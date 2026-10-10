import {first, json, now, run, sameSecret, Telegram} from './common.js';
import {handleUpdate} from './bot.js';
import {jobs} from './jobs.js';

export async function handle(request, env, tg = new Telegram(env)) {
  const path = new URL(request.url).pathname;
  if (path === '/healthz' && request.method === 'GET') return json({ok:true, service:'private-email-bot'});
  if (request.method !== 'POST') return json({error:'Not found'}, 404);
  try {
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
  } catch {
    // Never serialize exceptions: network libraries can include tokens, passwords, or mail bodies.
    return json({error:'Temporary service failure'}, 503);
  }
}
export default {fetch(request, env) { return handle(request, env); }};
