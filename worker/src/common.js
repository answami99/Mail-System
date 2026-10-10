const encoder = new TextEncoder();
export const now = () => Math.floor(Date.now() / 1000);
export const first = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
export const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();
export const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
export const stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
export const json = (body, status = 200) => Response.json(body, {status, headers: {'Cache-Control': 'no-store'}});
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

async function encryptionKey(env) {
  const raw = unb64(env.ENCRYPTION_KEY);
  if (raw.length !== 32) throw new Error('Invalid encryption configuration');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(env, scope, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv, additionalData: encoder.encode(scope)},
    await encryptionKey(env), encoder.encode(JSON.stringify(value))));
  // Chunk conversion avoids an argument-stack overflow for large emails.
  let data = '';
  for (let i = 0; i < encrypted.length; i += 8192) data += String.fromCharCode(...encrypted.subarray(i, i + 8192));
  return `${b64(iv)}.${btoa(data)}`;
}
export async function unseal(env, scope, value) {
  const [iv, data] = value.split('.');
  const clear = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: unb64(iv), additionalData: encoder.encode(scope)},
    await encryptionKey(env), unb64(data));
  return JSON.parse(new TextDecoder().decode(clear));
}
export async function digest(env, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.KEY_PEPPER),
    {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}
export async function sameSecret(env, a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = await digest(env, a), y = await digest(env, b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
export function randomCode() {
  // Rejection sampling avoids modulo bias. Preserve leading zeroes.
  let value;
  do { value = crypto.getRandomValues(new Uint32Array(1))[0]; } while (value >= 4200000000);
  return String(value % 100000000).padStart(8, '0');
}
export async function rate(env, bucket, max, seconds) {
  const t = now(), id = `${bucket}:${Math.floor(t / seconds)}`;
  const result = await first(env, `INSERT INTO limits(bucket,count,expires) VALUES(?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count`, id, t + seconds);
  return result.count <= max;
}
export async function member(env, user) {
  return first(env, `SELECT m.*, k.name,k.owner_id FROM members m JOIN access_keys k ON k.id=m.key_id
    WHERE m.user_id=? AND m.active=1 AND m.blocked=0 AND k.active=1`, user);
}
export const isHost = (env, user) => String(user) === env.HOST_TELEGRAM_ID;
export const canEdit = (env, m) => isHost(env, m.user_id) || m.owner_id === m.user_id;
export function formatEmail(email) {
  return `From: ${email.sender}\nSubject: ${email.subject || '(no subject)'}\nReceived: ${email.received}`;
}

export class TelegramError extends Error {
  constructor(code, retry = 60) { super('Telegram request failed'); this.code = code; this.retry = retry; }
}
export class Telegram {
  constructor(env) { this.token = env.TELEGRAM_BOT_TOKEN; }
  async call(method, data) {
    const form = data instanceof FormData;
    let response;
    try {
      response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: form ? undefined : {'Content-Type': 'application/json'},
        body: form ? data : JSON.stringify(data), signal: AbortSignal.timeout(15000), redirect: 'error'
      });
    } catch { throw new TelegramError(0); }
    let result;
    try { result = await response.json(); } catch { throw new TelegramError(0); }
    if (!result.ok) throw new TelegramError(result.error_code, result.parameters?.retry_after || 60);
    return result.result;
  }
  async send(chat, text) {
    return this.call('sendMessage', {chat_id: chat, text, protect_content: true,
      link_preview_options: {is_disabled: true}});
  }
  async delete(chat, id) {
    try { await this.call('deleteMessage', {chat_id: chat, message_id: id}); return true; }
    catch { return false; }
  }
  async email(chat, email) {
    const text = formatEmail(email);
    return this.send(chat, text);
  }
}
