import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handle} from '../src/index.js';
import {formatEmail, first, run, unseal, seal, now} from '../src/common.js';
import {slotAt} from '../src/jobs.js';
import {queueInitial} from '../src/initial.js';

// Real SQLite constraints/transactions behind the small D1 async interface.
class D1 {
  constructor() { this.db = new DatabaseSync(':memory:'); for (const name of ['0001.sql','0002_initial_checks.sql']) this.db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8')); }
  prepare(sql) {
    const query = this.db.prepare(sql);
    const make = args => ({
      bind: (...values) => make(values),
      first: async () => query.get(...args) || null,
      all: async () => ({results: query.all(...args)}),
      run: async () => ({meta: query.run(...args)})
    });
    return make([]);
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try { const results = []; for (const s of statements) results.push(await s.run()); this.db.exec('COMMIT'); return results; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
function setup() {
  const env = {DB:new D1(), ENCRYPTION_KEY:Buffer.alloc(32,1).toString('base64'), KEY_PEPPER:'test-pepper-long-value',
    RUNNER_TOKEN:'test-runner-token-32-characters-minimum', WEBHOOK_SECRET:'test-webhook-secret', HOST_ACCESS_KEY:'12345678', HOST_TELEGRAM_ID:'1',MAX_KEYS:'10',MAX_MEMBERS_PER_KEY:'5'};
  const sent = [], deleted = [];
  const tg = {send:async (id,text) => {sent.push({id,text});return {message_id:sent.length};},
    delete:async (id,msg) => {deleted.push({id,msg});return true;},
    email:async (id,email) => {sent.push({id,text:formatEmail(email)});return {message_id:sent.length};}};
  let update = 0;
  const api = async (path, body, header) => {
    const response = await handle(new Request(`https://bot.example${path}`, {method:'POST',headers:header ||
      (path === '/telegram' ? {'X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET} : {Authorization:`Bearer ${env.RUNNER_TOKEN}`}),body:JSON.stringify(body)}),env,tg);
    return {status:response.status,body:await response.json()};
  };
  const chat = (user,text,id=++update,type='private') => api('/telegram',{update_id:id,message:{message_id:id,from:{id:user,first_name:`User ${user}`},chat:{id:user,type},text}});
  const enroll = async (user,name) => {
    if (!await first(env,'SELECT * FROM members WHERE user_id=1')) await chat(1,'/start 12345678');
    await chat(1,`/new ${name}`);
    const key = await first(env,'SELECT * FROM access_keys WHERE name=?',name);
    const code = await unseal(env,`key:${key.id}`,key.code_cipher);
    await chat(user,`/start ${code}`);
    await chat(user,`${name.toLowerCase()}@rajasthan.gov.in`);
    await chat(user,'private-password');
    return {...key,code};
  };
  const claim = async key => {
    const revision = (await first(env,'SELECT revision FROM credentials WHERE key_id=?',key.id)).revision;
    return (await api('/internal/claim',{key_id:key.id,revision,slot:'manual:test'})).body;
  };
  return {env,tg,sent,deleted,api,chat,enroll,claim};
}
const email = {source_id:'ews-id-1',sender:'sender@example.org',subject:'Meeting at noon',received:'12 Oct 2026, 10:00 AM IST'};

test('first checks run outside schedule and deliver only to the newly joined account', async () => {
  const s=setup(), key=await s.enroll(2,'Alice');
  const regular=await s.claim(key);
  await s.api('/internal/ingest',{...regular,email});
  await s.api('/internal/finish',{...regular,slot:'manual:test',result:'success'});
  await s.api('/internal/deliver',{id:(await s.api('/internal/pending',{})).body.ids[0]});
  await s.chat(4,`/start ${key.code}`);
  const queued=await first(s.env,'SELECT * FROM initial_checks WHERE user_id=4');
  const batch=(await s.api('/internal/jobs',{initial:true})).body;
  const job=batch.jobs.find(j=>j.initial_request===queued.id);
  assert(job);
  const c=(await s.api('/internal/claim',{...job,slot:batch.slot})).body;
  assert.equal((await s.api('/internal/known',c)).body.ids.length,0);
  await s.api('/internal/ingest',{...c,email});
  await s.api('/internal/ingest',{...c,email:{...email,source_id:'new-during-onboarding'}});
  assert.equal((await first(s.env,`SELECT COUNT(*) AS n FROM deliveries d JOIN messages m ON m.id=d.message_id
    WHERE m.id<>? AND d.user_id=2`,(await s.api('/internal/known',c)).body.ids[0])).n,0);
  const pending=(await s.api('/internal/pending',{initial_request:queued.id})).body.ids;
  assert.equal(pending.length,2);
  for (const id of pending) await s.api('/internal/deliver',{id});
  assert.equal(s.sent.filter(x=>x.id===4 && x.text.startsWith('From:')).length,2);
  assert.equal(s.sent.filter(x=>x.id===2 && x.text.startsWith('From:')).length,1);
  await s.api('/internal/finish',{...c,slot:batch.slot,result:'success'});
  assert.equal((await first(s.env,'SELECT state FROM initial_checks WHERE id=?',queued.id)).state,'done');
  assert.equal((await first(s.env,'SELECT last_slot FROM credentials WHERE key_id=?',key.id)).last_slot,'manual:test');
  await s.chat(4,`/start ${key.code}`);
  assert.equal((await first(s.env,'SELECT COUNT(*) AS n FROM initial_checks WHERE user_id=4')).n,1);
  assert.equal((await s.api('/internal/jobs',{initial:true})).body.jobs.length,0);
});

test('initial queue waits for credentials and excludes blocked accounts', async () => {
  const s=setup();
  await s.chat(1,'/start 12345678');
  assert.equal((await s.api('/internal/jobs',{initial:true})).body.jobs.length,0);
  await s.chat(1,'host@rajasthan.gov.in');
  await s.chat(1,'private-password');
  assert.equal((await s.api('/internal/jobs',{initial:true})).body.jobs.length,1);
  const k=await s.enroll(2,'Alice');
  await s.chat(1,'/remove 2');
  assert.equal((await s.api('/internal/jobs',{initial:true})).body.jobs.some(j=>j.key_id===k.id),false);
});

test('initial trigger dispatches fixed workflow without identifiers; missing token retains queue', async t => {
  const s=setup(), key=await s.enroll(2,'Alice');
  assert.equal(await queueInitial(s.env,key.id,2,1),false);
  s.env.GITHUB_DISPATCH_TOKEN='test-dispatch-token';
  const mock=t.mock.method(globalThis,'fetch',async (url,options)=>{
    assert.equal(url,'https://api.github.com/repos/answami99/Mail-System/actions/workflows/initial.yml/dispatches');
    assert.equal(options.redirect,'manual');
    assert.deepEqual(JSON.parse(options.body),{ref:'main'});
    return Response.json({workflow_run_id:123},{status:200});
  });
  assert.equal(await queueInitial(s.env,key.id,2,1),true);
  assert.equal(await queueInitial(s.env,key.id,2,1),true);
  assert.equal(mock.mock.callCount(),1);
  assert.equal((await first(s.env,'SELECT COUNT(*) AS n FROM initial_checks WHERE user_id=2')).n,1);
});

test('exact IST weekday slots, including endpoints, late grace and weekend exclusion', () => {
  assert.equal(slotAt(new Date('2026-10-12T03:59:00Z')),null);
  assert.equal(slotAt(new Date('2026-10-12T04:00:00Z')),'2026-10-12T09:30+05:30');
  assert.equal(slotAt(new Date('2026-10-16T12:30:00Z')),'2026-10-16T18:00+05:30');
  assert.equal(slotAt(new Date('2026-10-16T12:59:59Z')),'2026-10-16T18:00+05:30');
  assert.equal(slotAt(new Date('2026-10-16T13:00:00Z')),null);
  assert.equal(slotAt(new Date('2026-10-17T06:00:00Z')),null);
  assert.equal(slotAt(new Date('2026-10-18T06:00:00Z')),null);
});
test('forged webhooks, unauthenticated runner calls, group messages and stolen host code fail closed', async () => {
  const s=setup();
  assert.equal((await s.api('/telegram',{update_id:1},{'X-Telegram-Bot-Api-Secret-Token':'bad'})).status,403);
  assert.equal((await s.api('/internal/jobs',{},{})).status,403);
  await s.chat(2,'/start 12345678');
  assert.equal(await first(s.env,'SELECT * FROM members WHERE user_id=2'),null);
  await s.chat(1,'/start 12345678',10,'group');
  assert.equal(await first(s.env,'SELECT * FROM members WHERE user_id=1'),null);
});
test('keys and passwords are encrypted, envelope scope prevents cross-mailbox decryption', async () => {
  const s=setup(); const k=await s.enroll(2,'Alice');
  const c=await first(s.env,'SELECT * FROM credentials WHERE key_id=?',k.id);
  assert.equal(c.password_cipher.includes('private-password'),false);
  assert.equal(await unseal(s.env,`password:${k.id}`,c.password_cipher),'private-password');
  await assert.rejects(unseal(s.env,'password:other',c.password_cipher));
  assert(s.deleted.some(x=>x.id===2));
});
test('multi-account membership has one credential owner; account count is not device count', async () => {
  const s=setup(); const k=await s.enroll(2,'Alice');
  await s.chat(3,`/start ${k.code}`);
  await s.chat(3,'/password');
  assert.match(s.sent.at(-1).text,/Only the mailbox manager/);
  await s.chat(2,`/start ${k.code}`);
  assert.equal((await first(s.env,'SELECT COUNT(*) AS n FROM members WHERE key_id=?',k.id)).n,2);
  await s.chat(2,'/keys');
  assert(!s.sent.at(-1).text.includes(k.code));
});
test('failed access-code guesses are rate limited', async () => {
  const s=setup(); for(let i=0;i<6;i++) await s.chat(5,'/start 00000000');
  assert.match(s.sent.at(-1).text,/Too many key attempts/);
});
test('mail routes only to its key, delivery deduplicates and rejects accidental body ingestion', async () => {
  const s=setup(); const a=await s.enroll(2,'Alice'); await s.enroll(3,'Bob');
  const identity=await s.claim(a);
  assert.equal((await s.api('/internal/ingest',{...identity,email:{...email,body:'private body'}})).status,400);
  assert.equal((await s.api('/internal/ingest',{...identity,email})).status,200);
  await s.api('/internal/ingest',{...identity,email});
  const pending=(await s.api('/internal/pending',{})).body.ids;
  assert.equal(pending.length,1);
  const before=s.sent.length;
  await s.api('/internal/deliver',{id:pending[0]}); await s.api('/internal/deliver',{id:pending[0]});
  assert.equal(s.sent.length,before+1);
  assert.equal(s.sent.at(-1).id,2);
  assert.equal(s.sent.at(-1).text,'From: sender@example.org\nSubject: Meeting at noon\nReceived: 12 Oct 2026, 10:00 AM IST');
  assert.equal((await first(s.env,'SELECT payload FROM messages')).payload,null);
  assert.equal((await s.api('/internal/known',identity)).body.ids.length,1);
});
test('new member gets unread backlog despite existing recipients having received it', async () => {
  const s=setup(); const a=await s.enroll(2,'Alice'), identity=await s.claim(a);
  await s.api('/internal/ingest',{...identity,email});
  const firstId=(await s.api('/internal/pending',{})).body.ids[0];
  await s.api('/internal/deliver',{id:firstId});
  await s.chat(3,`/start ${a.code}`);
  assert.equal((await s.api('/internal/known',identity)).body.ids.length,0);
  await s.api('/internal/ingest',{...identity,email});
  const queue=(await s.api('/internal/pending',{})).body.ids;
  assert.equal(queue.length,1);
  await s.api('/internal/deliver',{id:queue[0]});
  assert.equal(s.sent.at(-1).id,3);
});
test('removal blocks re-enrollment and suppresses queued delivery', async () => {
  const s=setup(); const a=await s.enroll(2,'Alice'), identity=await s.claim(a);
  await s.api('/internal/ingest',{...identity,email});
  await s.chat(1,'/remove 2'); await s.chat(2,`/start ${a.code}`);
  assert.equal((await first(s.env,'SELECT blocked FROM members WHERE user_id=2')).blocked,1);
  assert.equal((await s.api('/internal/pending',{})).body.ids.length,0);
});
test('revocation destroys credentials and queued metadata, invalidates runner leases', async () => {
  const s=setup(); const a=await s.enroll(2,'Alice'), identity=await s.claim(a);
  await s.api('/internal/ingest',{...identity,email}); await s.chat(1,`/revoke ${a.id}`);
  assert.equal(await first(s.env,'SELECT * FROM credentials WHERE key_id=?',a.id),null);
  assert.equal(await first(s.env,'SELECT * FROM messages WHERE key_id=?',a.id),null);
  assert.equal((await s.api('/internal/ingest',{...identity,email})).status,409);
});
test('password change keeps dedup history; mailbox change removes old queued messages', async () => {
  const s=setup(); const a=await s.enroll(2,'Alice'), identity=await s.claim(a);
  await s.api('/internal/ingest',{...identity,email});
  await s.chat(2,'/password'); await s.chat(2,'new-password');
  assert.equal((await first(s.env,'SELECT revision FROM credentials WHERE key_id=?',a.id)).revision,1);
  assert(await first(s.env,'SELECT * FROM messages WHERE key_id=?',a.id));
  assert.equal((await s.api('/internal/ingest',{...identity,email})).status,409);
  await s.chat(2,'/email'); await s.chat(2,'changed@rajasthan.gov.in'); await s.chat(2,'another-password');
  assert.equal((await first(s.env,'SELECT revision FROM credentials WHERE key_id=?',a.id)).revision,2);
  assert.equal(await first(s.env,'SELECT * FROM messages WHERE key_id=?',a.id),null);
});
test('Telegram rate limit retains queued metadata for later retry', async () => {
  const s=setup(); const a=await s.enroll(2,'Alice'), identity=await s.claim(a);
  await s.api('/internal/ingest',{...identity,email});
  const id=(await s.api('/internal/pending',{})).body.ids[0];
  s.tg.email=async()=>{throw {code:429,retry:100};};
  assert.equal((await s.api('/internal/deliver',{id})).body.retry,true);
  const d=await first(s.env,'SELECT * FROM deliveries WHERE id=?',id);
  assert.equal(d.state,'pending'); assert(d.retry_at>=now()+99);
  assert((await first(s.env,'SELECT payload FROM messages')).payload);
});
test('repeated authentication failures pause only the affected mailbox', async () => {
  const s=setup(); const a=await s.enroll(2,'Alice'); await s.enroll(3,'Bob');
  for(let i=0;i<3;i++) {
    const c=(await s.api('/internal/claim',{key_id:a.id,revision:1,slot:`manual:${i}`})).body;
    assert.equal((await s.api('/internal/finish',{...c,slot:`manual:${i}`,result:'auth'})).status,200);
  }
  assert.equal((await first(s.env,'SELECT paused FROM credentials WHERE key_id=?',a.id)).paused,1);
  const bob=await first(s.env,'SELECT c.paused FROM credentials c JOIN access_keys k ON k.id=c.key_id WHERE k.name=\'Bob\'');
  assert.equal(bob.paused,0);
});
test('replayed Telegram update does not create duplicate keys', async () => {
  const s=setup(); await s.chat(1,'/start 12345678');
  await s.chat(1,'/new Alice',200); await s.chat(1,'/new Alice',200);
  assert.equal((await first(s.env,'SELECT COUNT(*) AS n FROM access_keys WHERE name=\'Alice\'')).n,1);
});
test('job discovery, exclusive leases, completed-slot suppression and missing-secret protection', async () => {
  const s=setup(); const a=await s.enroll(2,'Alice');
  const batch=(await s.api('/internal/jobs',{force:true})).body;
  assert.equal(batch.jobs.length,1);
  const claim={...batch.jobs[0],slot:batch.slot};
  const leased=await s.api('/internal/claim',claim);
  assert.equal(leased.status,200);
  assert.equal((await s.api('/internal/claim',claim)).status,409);
  await s.api('/internal/finish',{...leased.body,slot:batch.slot,result:'success'});
  assert.equal((await s.api('/internal/claim',claim)).status,409);
  delete s.env.RUNNER_TOKEN;
  assert.equal((await s.api('/internal/jobs',{}, {Authorization:'Bearer undefined'})).status,503);
});
test('expired password entry cannot overwrite credentials', async () => {
  const s=setup(); const a=await s.enroll(2,'Alice');
  await s.chat(2,'/password');
  await run(s.env,'UPDATE states SET expires=? WHERE user_id=2',now()-1);
  await s.chat(2,'replacement');
  const c=await first(s.env,'SELECT * FROM credentials WHERE key_id=?',a.id);
  assert.equal(await unseal(s.env,`password:${a.id}`,c.password_cipher),'private-password');
});

test('setup requires runner authentication and cannot redirect updates or replace another bot webhook', async t => {
  const s=setup();
  s.env.TELEGRAM_BOT_TOKEN='12345:'+ 'a'.repeat(35); s.env.KEY_PEPPER='p'.repeat(32); s.env.WEBHOOK_SECRET='w'.repeat(32);
  const calls=[]; let destination=''; let username='RajasthanMail_bot';
  s.tg.call=async (method,data) => {
    calls.push({method,data});
    if(method==='getMe') return {username};
    if(method==='getWebhookInfo') return {url:destination,max_connections:1};
    if(method==='setWebhook') {destination=data.url; return true;}
  };
  assert.equal((await s.api('/internal/setup',{}, {Authorization:'Bearer wrong'})).status,403);
  assert.equal(calls.length,0);
  assert.equal((await s.api('/internal/setup',{url:'https://attacker.example'})).status,400);
  username='other_bot';
  assert.equal((await s.api('/internal/setup',{})).status,409);
  username='RajasthanMail_bot'; destination='https://existing.example/telegram';
  assert.equal((await s.api('/internal/setup',{})).status,409);
  assert.equal(calls.some(c=>c.method==='setWebhook'),false);
  destination='';
  assert.equal((await s.api('/internal/setup',{})).status,200);
  const update=calls.find(c=>c.method==='setWebhook').data;
  assert.equal(update.url,'https://private-email-bot.answami99.workers.dev/telegram');
  assert.equal(update.secret_token,s.env.WEBHOOK_SECRET);
  assert.equal(update.drop_pending_updates,false);
  const key=await s.enroll(2,'Alice');
  s.env.GITHUB_DISPATCH_TOKEN='test-dispatch-token';
  const dispatch=t.mock.method(globalThis,'fetch',async ()=>new Response(null,{status:204}));
  const connected=await s.api('/internal/setup',{});
  assert.equal(connected.status,200);
  assert.equal(connected.body.initial_checks_queued,1);
  assert.equal(connected.body.initial_checks_requested,1);
  assert.equal(dispatch.mock.callCount(),1);
  await s.api('/internal/setup',{});
  assert.equal(dispatch.mock.callCount(),1);
  await run(s.env,'UPDATE initial_checks SET state=\'done\' WHERE key_id=?',key.id);
  assert.equal((await s.api('/internal/setup',{})).body.initial_checks_queued,0);
});
