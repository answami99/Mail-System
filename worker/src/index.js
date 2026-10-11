import {all, first, json, now, run, sameSecret, seal, unseal, Telegram, TelegramError} from './common.js';
import {handleUpdate} from './bot.js';
import {jobs} from './jobs.js';
import {queueInitial} from './initial.js';
import {receivePush} from './push.js';

export async function handle(request, env, tg = new Telegram(env)) {
  const path = new URL(request.url).pathname;
  if (path === '/healthz' && request.method === 'GET') return json({ok:true, service:'private-email-bot'});
  if (request.method !== 'POST') return json({error:'Not found'}, 404);
  let setupStage = 'authentication';
  try {
    if (path.startsWith('/exchange/')) return await receivePush(request,env);
    if (path === '/telegram') {
      if (!await sameSecret(env, request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.WEBHOOK_SECRET)) return json({error:'Forbidden'}, 403);
    } else if (path.startsWith('/internal/')) {
      if (typeof env.RUNNER_TOKEN !== 'string' || env.RUNNER_TOKEN.length < 32) return json({error:'Service not configured'}, 503);
      if (!await sameSecret(env, request.headers.get('Authorization'), `Bearer ${env.RUNNER_TOKEN}`)) return json({error:'Forbidden'}, 403);
    } else return json({error:'Not found'}, 404);
    // Enforce actual streamed size, not a caller-controlled Content-Length alone.
    const reader = request.body?.getReader();
    if (!reader) return json({error:'Body required'}, 400);
    const parts = []; let size = 0;
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); return json({error:'Too large'}, 413); }
      parts.push(value);
    }
    const raw = new Uint8Array(size); let position = 0;
    for (const part of parts) { raw.set(part,position); position += part.length; }
    let body;
    try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return json({error:'Invalid JSON'}, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({error:'Invalid payload'}, 400);
    if (path === '/internal/setup') {
      // Fixed destination and bot identity: runner input cannot redirect private updates.
      if (Object.keys(body).length) return json({error:'No setup parameters accepted'},400);
      const url = 'https://private-email-bot.answami99.workers.dev/telegram';
      if (!/^\d+$/.test(env.HOST_TELEGRAM_ID || '') || !/^\d{6,8}$/.test(env.HOST_ACCESS_KEY || '') ||
          !/^[A-Za-z0-9_-]{32,256}$/.test(env.WEBHOOK_SECRET || '') || (env.KEY_PEPPER || '').length < 32)
        return json({error:'Invalid private configuration'},503);
      setupStage = 'encryption';
      if (await unseal(env,'setup',await seal(env,'setup','ready')) !== 'ready') throw new Error('Encryption check failed');
      setupStage = 'database';
      await first(env,'SELECT id FROM access_keys LIMIT 1');
      if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test((env.TELEGRAM_BOT_TOKEN || '').trim())) return json({error:'Invalid bot token format'},503);
      setupStage = 'telegram-token';
      const me = await tg.call('getMe',{});
      if (me.username?.toLowerCase() !== 'rajasthanmail_bot') return json({error:'Unexpected bot token'},409);
      setupStage = 'telegram-webhook-read';
      const previous = await tg.call('getWebhookInfo',{});
      if (previous.url && previous.url !== url) return json({error:'Bot already connected elsewhere'},409);
      setupStage = 'telegram-webhook-register';
      await tg.call('setWebhook',{url,secret_token:env.WEBHOOK_SECRET,max_connections:1,allowed_updates:['message'],drop_pending_updates:false});
      setupStage = 'telegram-webhook-verify';
      const info = await tg.call('getWebhookInfo',{});
      if (info.url !== url || info.max_connections !== 1) return json({error:'Webhook verification failed'},503);
      // Backfill accounts connected before the first-check feature was deployed.
      // Completed checks are never re-enqueued by this idempotent setup operation.
      setupStage = 'initial-check';
      const waiting = await all(env, `SELECT m.user_id,m.key_id,c.revision FROM members m
        JOIN access_keys k ON k.id=m.key_id JOIN credentials c ON c.key_id=m.key_id
        WHERE m.active=1 AND m.blocked=0 AND k.active=1 AND c.paused=0 AND c.last_checked IS NULL
        AND NOT EXISTS(SELECT 1 FROM initial_checks i WHERE i.key_id=m.key_id AND i.user_id=m.user_id
          AND i.revision=c.revision AND i.state='done') LIMIT 50`);
      let requested = 0;
      for (const account of waiting) requested += Number(await queueInitial(env,account.key_id,account.user_id,account.revision));
      return json({ok:true,bot:'RajasthanMail_bot',webhook_configured:true,
        initial_checks_queued:waiting.length,initial_checks_requested:requested});
    }
    if (path !== '/telegram') return await jobs(env, path, body, tg);
    if (!Number.isSafeInteger(body.update_id)) return json({error:'Invalid update'}, 400);
    const claim = await first(env, `INSERT INTO updates(id,state,expires) VALUES(?,'processing',?)
      ON CONFLICT(id) DO UPDATE SET state='processing',expires=excluded.expires
      WHERE updates.state='processing' AND updates.expires<? RETURNING id`, body.update_id, now()+60, now());
    if (!claim) {
      const row = await first(env, 'SELECT state FROM updates WHERE id=?', body.update_id);
      return json({ok:row.state === 'done'}, row.state === 'done' ? 200 : 503);
    }
    await handleUpdate(env, body, tg);
    await run(env, 'UPDATE updates SET state=\'done\',expires=? WHERE id=?', now()+172800, body.update_id);
    return json({ok:true});
  } catch (error) {
    if (path === '/internal/setup') return json({error:'Setup step failed',stage:setupStage,telegram_code:error instanceof TelegramError ? error.code : null},503);
    // Never serialize exceptions: network libraries can include tokens, passwords, or mail bodies.
    return json({error:'Temporary service failure'}, 503);
  }
}
export default {fetch(request, env) { return handle(request, env); }};
