import {all, first, formatEmail, json, now, run, seal, stmt, unseal} from './common.js';

export function slotAt(date = new Date()) {
  const local = new Date(date.getTime() + 330 * 60000);
  const day = local.getUTCDay(), minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  // A late GitHub run can service the most recent slot until 18:29 IST.
  if (day === 0 || day === 6 || minute < 570 || minute >= 1110) return null;
  const slot = Math.floor(minute / 30) * 30;
  return `${local.toISOString().slice(0, 10)}T${String(Math.floor(slot / 60)).padStart(2, '0')}:${String(slot % 60).padStart(2, '0')}+05:30`;
}
async function validLease(env, body) {
  return first(env, `SELECT c.* FROM credentials c JOIN access_keys k ON k.id=c.key_id
    WHERE c.key_id=? AND c.revision=? AND c.lease=? AND c.lease_until>? AND c.paused=0 AND k.active=1`,
    body.key_id, body.revision, body.lease, now());
}
async function mailId(key, revision, source) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${key}\n${revision}\n${source}`));
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
}

export async function jobs(env, route, body, tg) {
  if (route === '/internal/jobs') {
    await env.DB.batch([
      stmt(env, 'DELETE FROM states WHERE expires<?', now()),
      stmt(env, 'DELETE FROM limits WHERE expires<?', now()),
      stmt(env, 'DELETE FROM updates WHERE expires<? AND state=\'done\'', now()),
      stmt(env, `UPDATE messages SET payload=NULL WHERE payload IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM deliveries d JOIN members m ON m.user_id=d.user_id AND m.key_id=messages.key_id
        WHERE d.message_id=messages.id AND d.state<>'sent' AND m.active=1 AND m.blocked=0)`)
    ]);
    const slot = body.force === true ? `manual:${crypto.randomUUID()}` : slotAt();
    if (!slot) return json({slot: null, jobs: []});
    const rows = await all(env, `SELECT c.key_id,c.revision FROM credentials c JOIN access_keys k ON k.id=c.key_id
      WHERE k.active=1 AND c.paused=0 AND c.lease_until<? AND (c.last_slot IS NULL OR c.last_slot<>?)
      AND EXISTS(SELECT 1 FROM members m WHERE m.key_id=c.key_id AND m.active=1 AND m.blocked=0)`, now(), slot);
    return json({slot, jobs: rows});
  }
  if (route === '/internal/claim') {
    if (typeof body.slot !== 'string' || body.slot.length > 80) return json({error:'Invalid slot'}, 400);
    const lease = crypto.randomUUID();
    const c = await first(env, `UPDATE credentials SET lease=?,lease_until=? WHERE key_id=? AND revision=?
      AND lease_until<? AND paused=0 AND (last_slot IS NULL OR last_slot<>?)
      AND EXISTS(SELECT 1 FROM access_keys WHERE id=key_id AND active=1) RETURNING *`,
      lease, now() + 900, body.key_id, body.revision, now(), body.slot);
    if (!c) return json({error:'Unavailable'}, 409);
    return json({key_id: c.key_id, revision:c.revision, lease,
      email:await unseal(env, `email:${c.key_id}`, c.email_cipher),
      password:await unseal(env, `password:${c.key_id}`, c.password_cipher)});
  }
  if (route === '/internal/known') {
    if (!await validLease(env, body)) return json({error:'Expired lease'}, 409);
    // Only skip a message if every currently enrolled recipient has a durable delivery row.
    const rows = await all(env, `SELECT msg.id FROM messages msg WHERE msg.key_id=? AND msg.revision=?
      AND NOT EXISTS(SELECT 1 FROM members m WHERE m.key_id=msg.key_id AND m.active=1 AND m.blocked=0
      AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=msg.id AND d.user_id=m.user_id))`, body.key_id, body.revision);
    return json({ids:rows.map(x => x.id)});
  }
  if (route === '/internal/ingest') {
    if (!await validLease(env, body)) return json({error:'Expired lease'}, 409);
    const e = body.email;
    if (!e || !['source_id','sender','subject','received'].every(k => typeof e[k] === 'string') ||
        Object.keys(e).some(k => !['source_id','sender','subject','received'].includes(k)) ||
        !e.source_id || e.source_id.length > 2048 || e.sender.length > 512 || e.received.length > 100 ||
        e.subject.length > 3300 || formatEmail(e).length > 4000) return json({error:'Invalid email metadata'}, 400);
    const id = await mailId(body.key_id, body.revision, e.source_id);
    const payload = await seal(env, `message:${id}`, e);
    await env.DB.batch([
      stmt(env, `INSERT INTO messages VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=COALESCE(messages.payload,excluded.payload)`,
        id, body.key_id, body.revision, payload, now()),
      stmt(env, `INSERT OR IGNORE INTO deliveries(id,message_id,user_id)
        SELECT ? || ':' || user_id,?,user_id FROM members WHERE key_id=? AND active=1 AND blocked=0`, id, id, body.key_id)
    ]);
    return json({ok:true});
  }
  if (route === '/internal/finish') {
    if (!await validLease(env, body)) return json({error:'Expired lease'}, 409);
    const statuses = {auth:'Login failed; check email/password or Exchange API permissions',
      network:'Mail server unavailable; will retry', protocol:'Exchange API unavailable or incompatible',
      partial:'Partial check; remaining unread mail will be checked on a future run', success:'Check completed'};
    if (!Object.hasOwn(statuses, body.result)) return json({error:'Invalid result'}, 400);
    const fatal = ['auth', 'protocol'].includes(body.result);
    const c = await first(env, `UPDATE credentials SET lease=NULL,lease_until=0,last_slot=?,status=?,
      last_checked=CASE WHEN ?='success' THEN ? ELSE last_checked END,
      failures=CASE WHEN ?='success' THEN 0 WHEN ?=1 THEN failures+1 ELSE failures END,
      paused=CASE WHEN ?=1 AND failures>=2 THEN 1 ELSE paused END WHERE key_id=? AND lease=? RETURNING paused,failures`,
      body.slot, statuses[body.result], body.result, now(), body.result, fatal ? 1 : 0, fatal ? 1 : 0, body.key_id, body.lease);
    if (c?.paused) {
      // Limit further attempts; the government's independent lockout threshold is unknown.
      const k = await first(env, 'SELECT name,owner_id FROM access_keys WHERE id=?', body.key_id);
      const msg = `Mailbox ${k.name} paused after repeated access failures. Check /status and update credentials or ask the administrator about EWS. Host can use /resume ${body.key_id}.`;
      for (const recipient of new Set([Number(env.HOST_TELEGRAM_ID), k.owner_id].filter(Boolean))) {
        try { await tg.send(recipient, msg); } catch { /* /health remains authoritative */ }
      }
    }
    return json({ok:true});
  }
  if (route === '/internal/pending') {
    const rows = await all(env, `SELECT d.id FROM deliveries d JOIN messages msg ON msg.id=d.message_id
      JOIN credentials c ON c.key_id=msg.key_id AND c.revision=msg.revision
      JOIN access_keys k ON k.id=msg.key_id JOIN members m ON m.user_id=d.user_id AND m.key_id=msg.key_id
      WHERE d.state<>'sent' AND d.lease_until<? AND d.retry_at<=? AND k.active=1 AND m.active=1 AND m.blocked=0
      ORDER BY msg.created_at,d.id LIMIT 25`, now(), now());
    return json({ids:rows.map(r => r.id)});
  }
  if (route === '/internal/deliver') {
    const d = await first(env, `UPDATE deliveries SET state='sending',lease_until=? WHERE id=? AND state<>'sent'
      AND lease_until<? AND retry_at<=? RETURNING *`, now() + 120, body.id, now(), now());
    if (!d) return json({ok:true, skipped:true});
    const msg = await first(env, `SELECT msg.* FROM messages msg JOIN access_keys k ON k.id=msg.key_id
      JOIN credentials c ON c.key_id=msg.key_id AND c.revision=msg.revision
      JOIN members m ON m.key_id=msg.key_id WHERE msg.id=? AND m.user_id=? AND k.active=1 AND m.active=1 AND m.blocked=0`, d.message_id, d.user_id);
    if (!msg?.payload) {
      await run(env, 'DELETE FROM deliveries WHERE id=? AND state<>\'sent\'', d.id);
      return json({ok:true, skipped:true});
    }
    try {
      const result = await tg.email(d.user_id, await unseal(env, `message:${msg.id}`, msg.payload));
      await env.DB.batch([
        stmt(env, 'UPDATE deliveries SET state=\'sent\',telegram_id=?,lease_until=0 WHERE id=?', result.message_id, d.id),
        stmt(env, `UPDATE messages SET payload=NULL WHERE id=? AND NOT EXISTS(SELECT 1 FROM deliveries WHERE message_id=? AND state<>'sent')`, msg.id, msg.id)
      ]);
      return json({ok:true});
    } catch (error) {
      if (error.code === 403) {
        await env.DB.batch([
          stmt(env, 'UPDATE members SET active=0 WHERE user_id=?', d.user_id),
          stmt(env, 'DELETE FROM deliveries WHERE user_id=? AND state<>\'sent\'', d.user_id)
        ]);
      } else {
        await run(env, 'UPDATE deliveries SET state=\'pending\',lease_until=0,retry_at=? WHERE id=?',
          now() + Math.min(3600, Math.max(60, error.retry || 60)), d.id);
      }
      return json({ok:false, retry:true});
    }
  }
  return json({error:'Not found'}, 404);
}
