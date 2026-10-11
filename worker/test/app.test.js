import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handle} from '../src/index.js';
import {formatEmail, first, run, unseal, seal, now} from '../src/common.js';
import {slotAt} from '../src/jobs.js';
import {checkOutcome,overdue} from '../src/ui.js';
import {queueInitial} from '../src/initial.js';

// Real SQLite constraints/transactions behind the small D1 async interface.
class D1 {
  constructor() { this.db = new DatabaseSync(':memory:'); for (const name of ['0001.sql','0002_initial_checks.sql','0003_push.sql','0004_check_status.sql','0005_user_notifications.sql']) this.db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8')); }
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
  const tg = {send:async (id,text,markup) => {sent.push({id,text,markup});return {message_id:sent.length};},
    delete:async (id,msg) => {deleted.push({id,msg});return true;},
    call:async()=>({ok:true}),
    email:async (id,email) => {sent.push({id,text:formatEmail(email)});return {message_id:sent.length};}};
  let update = 0;
  const api = async (path, body, header) => {
    const response = await handle(new Request(`https://bot.example${path}`, {method:'POST',headers:header ||
      (path === '/telegram' ? {'X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET} : {Authorization:`Bearer ${env.RUNNER_TOKEN}`}),body:JSON.stringify(body)}),env,tg);
    return {status:response.status,body:await response.json()};
  };
  const rawChat = (user,text,id=++update,type='private') => api('/telegram',{update_id:id,message:{message_id:id,from:{id:user,first_name:`User ${user}`},chat:{id:user,type},text}});
  const chat=async (...args)=>{const result=await rawChat(...args);const pending=await first(env,'SELECT stage FROM states WHERE user_id=?',args[0]);
    if(pending?.stage==='name') await rawChat(args[0],`User ${args[0]}`);return result;};
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
  return {env,tg,sent,deleted,api,chat,rawChat,enroll,claim};
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

test('daily IST slots include weekends, endpoints and late grace, and exclude out-of-hours checks', () => {
  assert.equal(slotAt(new Date('2026-10-12T03:59:00Z')),null);
  assert.equal(slotAt(new Date('2026-10-12T04:00:00Z')),'2026-10-12T09:30+05:30');
  assert.equal(slotAt(new Date('2026-10-16T12:30:00Z')),'2026-10-16T18:00+05:30');
  assert.equal(slotAt(new Date('2026-10-12T04:09:59Z')),'2026-10-12T09:30+05:30');
  assert.equal(slotAt(new Date('2026-10-12T04:10:00Z')),'2026-10-12T09:40+05:30');
  assert.equal(slotAt(new Date('2026-10-12T04:20:00Z')),'2026-10-12T09:50+05:30');
  assert.equal(slotAt(new Date('2026-10-16T12:39:59Z')),'2026-10-16T18:00+05:30');
  assert.equal(slotAt(new Date('2026-10-16T12:40:00Z')),null);
  assert.equal(slotAt(new Date('2026-10-17T06:00:00Z')),'2026-10-17T11:30+05:30');
  assert.equal(slotAt(new Date('2026-10-18T06:00:00Z')),'2026-10-18T11:30+05:30');
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
  const calls=[]; let destination=''; let username='RajasthanMail_bot'; const commandMenus=new Map();
  s.tg.call=async (method,data) => {
    calls.push({method,data});
    if(method==='getMe') return {username};
    if(method==='getWebhookInfo') return {url:destination,max_connections:1};
    if(method==='setWebhook') {destination=data.url; return true;}
    if(method==='setMyCommands') {commandMenus.set(data.scope?.type||'default',data.commands);return true;}
    if(method==='getMyCommands') return commandMenus.get(data.scope?.type||'default');
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

const pushSoap=(sid='subscription-private',item='mail-private',folder='inbox-private',watermark='watermark-1',status=false)=>`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><m:SendNotification xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><m:ResponseMessages><m:SendNotificationResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Notification><t:SubscriptionId>${sid}</t:SubscriptionId><t:PreviousWatermark>old</t:PreviousWatermark><t:MoreEvents>false</t:MoreEvents><t:${status?'StatusEvent':'NewMailEvent'}><t:Watermark>${watermark}</t:Watermark>${status?'':`<t:TimeStamp>2026-10-12T04:15:00Z</t:TimeStamp><t:ItemId Id="${item}" ChangeKey="private"/><t:ParentFolderId Id="${folder}"/>`}</t:${status?'StatusEvent':'NewMailEvent'}></m:Notification></m:SendNotificationResponseMessage></m:ResponseMessages></m:SendNotification></s:Body></s:Envelope>`;
async function registeredPush(s,key) {
  const lease=await s.claim(key);
  const prep=(await s.api('/internal/push/prepare',lease)).body;
  assert(prep.needed);
  assert.equal((await s.api('/internal/push/confirm',{...lease,generation:prep.generation,subscription_id:'subscription-private',folder_id:'inbox-private'})).status,200);
  return {lease,prep,callback:async (xml=pushSoap(),url=prep.callback_url)=>handle(new Request(url,{method:'POST',body:xml}),s.env,s.tg)};
}
test('push callbacks authenticate token, subscription and folder; XML attacks fail closed',async()=>{
  const s=setup(),key=await s.enroll(2,'Alice'),p=await registeredPush(s,key);
  const bad=new URL(p.prep.callback_url);bad.searchParams.set('token','forged');
  assert.equal((await p.callback(pushSoap(),bad.href)).status,403);
  assert.equal((await p.callback(pushSoap('wrong'))).status,403);
  assert.equal((await p.callback(pushSoap('subscription-private','one','other-folder'))).status,200);
  assert.equal((await first(s.env,'SELECT event_seq FROM push_subscriptions')).event_seq,0);
  for(const xml of ['<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]>'+pushSoap(),pushSoap().replace('NoError','&evil;'),pushSoap().replace('</m:Notification>','</wrong>'),pushSoap().replace('services/2006/types','fake/namespace')]) assert.equal((await p.callback(xml)).status,400);
  assert.equal((await p.callback('x'.repeat(65537))).status,413);
  assert.equal((await p.callback()).status,200);
  assert.equal((await first(s.env,'SELECT event_seq FROM push_subscriptions')).event_seq,1);
  await s.chat(2,'/password');await s.chat(2,'updated-secret');
  assert.match(await (await p.callback()).text(),/Unsubscribe/);
});
test('push duplicates, idle status, and event snapshots never lose later arrivals',async()=>{
  const s=setup(),key=await s.enroll(2,'Alice'),p=await registeredPush(s,key);
  await run(s.env,"UPDATE settings SET value='always' WHERE id='realtime_hours'");
  await s.api('/internal/finish',{...p.lease,slot:'manual:registration',result:'success'});
  await p.callback();await p.callback();await p.callback(pushSoap(undefined,undefined,undefined,'status',true));
  assert.equal((await first(s.env,'SELECT event_seq FROM push_subscriptions')).event_seq,1);
  const batch=(await s.api('/internal/jobs',{events:true})).body;
  assert.equal(batch.jobs.length,1);
  const lease=(await s.api('/internal/claim',{...batch.jobs[0],slot:batch.slot})).body;
  await p.callback(pushSoap(undefined,'second',undefined,'watermark-2'));
  await s.api('/internal/finish',{...lease,slot:batch.slot,result:'success'});
  assert.deepEqual({...await first(s.env,'SELECT event_seq,done_seq FROM push_subscriptions')},{event_seq:2,done_seq:1});
  assert.equal((await s.api('/internal/jobs',{events:true})).body.jobs.length,1);
  const next=(await s.api('/internal/claim',{key_id:key.id,revision:1,slot:'event:second'})).body;
  await s.api('/internal/finish',{...next,slot:'event:second',result:'network'});
  assert.equal((await first(s.env,'SELECT done_seq FROM push_subscriptions')).done_seq,1);
  await s.chat(1,`/revoke ${key.id}`);
  assert.match(await (await p.callback()).text(),/Unsubscribe/);
  assert.equal((await s.api('/internal/jobs',{events:true})).body.jobs.length,0);
});
test('push dispatch has fixed destination and no private inputs, throttles bursts and retries failure',async t=>{
  const s=setup(),key=await s.enroll(2,'Alice'),p=await registeredPush(s,key);
  await run(s.env,"UPDATE settings SET value='always' WHERE id='realtime_hours'");
  s.env.GITHUB_DISPATCH_TOKEN='test-dispatch-token';let calls=0,fail=true;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls++;assert.equal(url,'https://api.github.com/repos/answami99/Mail-System/actions/workflows/push.yml/dispatches');
    assert.equal(options.redirect,'manual');assert.deepEqual(JSON.parse(options.body),{ref:'main'});
    return new Response(null,{status:fail?503:204});
  });
  await p.callback();assert.equal(calls,1);
  assert.equal((await first(s.env,'SELECT requested_at FROM push_dispatch')).requested_at,0);
  fail=false;await p.callback(pushSoap(undefined,undefined,undefined,'status',true));assert.equal(calls,2);
  await p.callback(pushSoap(undefined,'second',undefined,'watermark-2'));assert.equal(calls,2);
  await run(s.env,'UPDATE push_dispatch SET requested_at=0');
  await p.callback(pushSoap(undefined,undefined,undefined,'status',true));assert.equal(calls,3);
  await s.api('/internal/finish',{...p.lease,slot:'manual:first',result:'success'});
  const next=(await s.api('/internal/claim',{key_id:key.id,revision:1,slot:'event:all'})).body;
  await s.api('/internal/finish',{...next,slot:'event:all',result:'success'});
  await run(s.env,'UPDATE push_dispatch SET requested_at=0');
  await p.callback(pushSoap(undefined,undefined,undefined,'status',true));assert.equal(calls,3);
});
test('push provisioning race triggers no work, stale subscription renews, failed ones stop',async()=>{
  const s=setup(),key=await s.enroll(2,'Alice'),lease=await s.claim(key);
  const prep=(await s.api('/internal/push/prepare',lease)).body;
  assert.equal((await s.api('/internal/push/prepare',lease)).body.needed,false);
  const response=await handle(new Request(prep.callback_url,{method:'POST',body:pushSoap()}),s.env,s.tg);
  assert.match(await response.text(),/>OK</);
  assert.equal((await first(s.env,'SELECT event_seq FROM push_subscriptions')).event_seq,0);
  await s.api('/internal/push/confirm',{...lease,generation:prep.generation,subscription_id:'subscription-private',folder_id:'inbox-private'});
  assert.equal((await s.api('/internal/push/prepare',lease)).body.needed,false);
  await run(s.env,'UPDATE push_subscriptions SET last_seen=?,created_at=?',now()-400,now()-1000);
  const next=(await s.api('/internal/push/prepare',lease)).body;
  assert(next.needed);assert.notEqual(next.generation,prep.generation);
  assert.match(await (await handle(new Request(prep.callback_url,{method:'POST',body:pushSoap()}),s.env,s.tg)).text(),/Unsubscribe/);
  await s.api('/internal/push/failed',{...lease,generation:next.generation});
  assert.match(await (await handle(new Request(next.callback_url,{method:'POST',body:pushSoap()}),s.env,s.tg)).text(),/Unsubscribe/);
});

test('unreachable push callbacks back off without claiming realtime health or disabling scans',async()=>{
  const s=setup(),key=await s.enroll(2,'Alice'),p=await registeredPush(s,key);
  await run(s.env,'UPDATE push_subscriptions SET created_at=?',now()-600);
  assert.equal((await s.api('/internal/push/prepare',p.lease)).body.needed,false);
  await s.chat(2,'/status');assert.match(s.sent.at(-1).text,/Every 10 minutes/);
  await s.api('/internal/push/failed',{...p.lease,generation:p.prep.generation});
  assert.equal((await s.api('/internal/push/prepare',p.lease)).body.needed,false);
  await s.chat(2,'/status');assert(!s.sent.at(-1).text.includes('✅ Successful'));
  assert.equal((await first(s.env,'SELECT paused FROM credentials WHERE key_id=?',key.id)).paused,0);
  await run(s.env,'UPDATE push_subscriptions SET created_at=?,last_request=9,callback_error=?',now()-21601,'Previous failure');
  const next=(await s.api('/internal/push/prepare',p.lease)).body;assert(next.needed);
  const row=await first(s.env,'SELECT last_request,callback_error FROM push_subscriptions WHERE key_id=?',key.id);
  assert.equal(row.last_request,0);assert.equal(row.callback_error,null);
});

test('named invitation welcomes the organisation and requires a declared name before enrollment or credentials',async()=>{
  const s=setup();await s.chat(1,'/start 12345678');await s.chat(1,'/new');
  assert.match(s.sent.at(-1).text,/person or organisation/);
  await s.chat(1,'Office / Jaipur');
  const key=await first(s.env,"SELECT * FROM access_keys WHERE name='Office / Jaipur'");
  const code=await unseal(s.env,`key:${key.id}`,key.code_cipher);
  await s.rawChat(2,`/start ${code}`);
  assert.match(s.sent.at(-1).text,/Welcome to Office \/ Jaipur!/);
  assert.match(s.sent.at(-1).text,/host sees it.*prevent misuse/);
  assert.equal(await first(s.env,'SELECT * FROM members WHERE user_id=2'),null);
  assert.equal(await first(s.env,'SELECT * FROM credentials WHERE key_id=?',key.id),null);
  await s.rawChat(2,'   ');assert.equal((await first(s.env,'SELECT stage FROM states WHERE user_id=2')).stage,'name');
  await s.rawChat(2,'A'.repeat(65));assert.equal((await first(s.env,'SELECT stage FROM states WHERE user_id=2')).stage,'name');
  await s.rawChat(2,'Meera Sharma');
  assert.equal((await first(s.env,'SELECT label FROM members WHERE user_id=2')).label,'Meera Sharma');
  assert.equal((await first(s.env,'SELECT stage FROM states WHERE user_id=2')).stage,'email');
  assert.equal((await first(s.env,'SELECT owner_id FROM access_keys WHERE id=?',key.id)).owner_id,2);
  await s.rawChat(2,'office@rajasthan.gov.in');await s.rawChat(2,'private-password');
  await s.rawChat(3,`/start ${code}`);await s.rawChat(3,'Another colleague');
  assert.equal((await first(s.env,'SELECT label FROM members WHERE user_id=3')).label,'Another colleague');
  assert.equal(await first(s.env,'SELECT stage FROM states WHERE user_id=3'),null);
  assert.match(s.sent.at(-1).text,/first unread-mail check/);
  await s.rawChat(2,`/start ${code}`);
  assert.equal((await first(s.env,'SELECT label FROM members WHERE user_id=2')).label,'Meera Sharma');
});
test('name enrollment rechecks revocation and expired invitations',async()=>{
  const s=setup(),key=await s.enroll(2,'Alice');
  await s.rawChat(3,`/start ${key.code}`);await s.chat(1,`/revoke ${key.id}`);await s.rawChat(3,'Late join');
  assert.equal(await first(s.env,'SELECT user_id FROM members WHERE user_id=3'),null);
  assert.match(s.sent.at(-1).text,/no longer available/);
});
test('host can manage accounts by named buttons without Telegram IDs; forged actions cannot remove users',async()=>{
  const s=setup(),key=await s.enroll(2,'Alice');
  await s.chat(1,'/keys');
  const menu=s.sent.at(-1);assert(menu.markup.inline_keyboard.some(row=>row[0].text==='Manage Alice'));
  const callback=(user,data,id)=>s.api('/telegram',{update_id:id,callback_query:{id:`callback-${id}`,from:{id:user},message:{chat:{id:user,type:'private'}},data}});
  await callback(2,`remove:${key.id}:2`,900);
  assert.equal((await first(s.env,'SELECT active FROM members WHERE user_id=2')).active,1);
  await callback(1,`members:${key.id}`,901);
  const members=s.sent.at(-1);assert.match(members.text,/Alice/);assert(!members.text.includes('Telegram ID'));
  const remove=members.markup.inline_keyboard.flat().find(b=>b.text==='Remove User 2');assert(remove);
  await callback(1,remove.callback_data,902);
  assert.equal((await first(s.env,'SELECT blocked FROM members WHERE user_id=2')).blocked,1);
  await callback(1,`members:${key.id}`,903);
  const allow=s.sent.at(-1).markup.inline_keyboard.flat().find(b=>b.text==='Allow User 2');assert(allow);
  await callback(1,allow.callback_data,904);assert.equal((await first(s.env,'SELECT blocked FROM members WHERE user_id=2')).blocked,0);
  await callback(1,`revoke:${key.id}`,905);
  assert.match(s.sent.at(-1).text,/Revoke Alice\?/);
  assert.equal((await first(s.env,'SELECT active FROM access_keys WHERE id=?',key.id)).active,1);
  await callback(1,`revoke:${key.id}:confirm`,906);
  assert.equal((await first(s.env,'SELECT active FROM access_keys WHERE id=?',key.id)).active,0);
});

test('scheduled checks use distinct ten-minute slots and record a failure after a prior success',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-12T04:00:00Z')});
  const s=setup(),key=await s.enroll(2,'Alice');
  const batch=(await s.api('/internal/jobs',{})).body;assert.equal(batch.slot,'2026-10-12T09:30+05:30');
  const one=(await s.api('/internal/claim',{...batch.jobs[0],slot:batch.slot})).body;
  assert.equal((await first(s.env,'SELECT last_result FROM credentials WHERE key_id=?',key.id)).last_result,'running');
  t.mock.timers.tick(1000);
  await s.api('/internal/finish',{...one,slot:batch.slot,result:'success'});
  const success=await first(s.env,'SELECT last_checked,last_finished FROM credentials WHERE key_id=?',key.id);
  assert.equal(success.last_checked,success.last_finished);
  assert.equal((await s.api('/internal/jobs',{})).body.jobs.length,0);
  t.mock.timers.tick(599000);
  const next=(await s.api('/internal/jobs',{})).body;assert.equal(next.slot,'2026-10-12T09:40+05:30');assert.equal(next.jobs.length,1);
  const two=(await s.api('/internal/claim',{...next.jobs[0],slot:next.slot})).body;
  await s.api('/internal/finish',{...two,slot:next.slot,result:'network'});
  const failed=await first(s.env,'SELECT * FROM credentials WHERE key_id=?',key.id);
  assert.equal(failed.last_result,'network');assert.equal(failed.last_checked,success.last_checked);
  assert(failed.last_attempt>success.last_checked);assert(failed.last_finished>=failed.last_attempt);
  await s.chat(1,'🕒 Last checks');assert.match(s.sent.at(-1).text,/Alice\n⚠️ Mail server unavailable/);
  assert.match(s.sent.at(-1).text,/09:40/);assert.match(s.sent.at(-1).text,/Last success:.*09:30/);
  await s.chat(2,'🕒 Last check');assert.match(s.sent.at(-1).text,/Mail server unavailable/);
  assert(!s.sent.at(-1).text.includes('✅ Successful'));
});

test('check displays distinguish expired runs, incomplete scans and overdue office-hour results',()=>{
  assert.match(checkOutcome({status:'Check completed',last_result:'running',lease_until:now()-1}),/interrupted or timed out/);
  assert.match(checkOutcome({status:'Check completed',last_result:'running',lease_until:now()+60}),/in progress/);
  assert.match(checkOutcome({status:'Partial',last_result:'partial',paused:0}),/Incomplete/);
  const old={status:'Check completed',last_attempt:1,last_result:'success'};
  assert.equal(overdue(old,new Date('2026-10-12T04:19:00Z')),false);
  assert.equal(overdue(old,new Date('2026-10-12T04:20:00Z')),true);
  assert.equal(overdue(old,new Date('2026-10-12T13:00:00Z')),false);
  assert.equal(overdue(old,new Date('2026-10-18T06:00:00Z')),true);
});

test('button menus guide host and users, protect credential prompts and preserve mailbox isolation',async()=>{
  const s=setup(),alice=await s.enroll(2,'Alice');await s.enroll(3,'Bob');
  await s.chat(1,'/start');assert(s.sent.at(-1).markup.keyboard.flat().includes('🕒 Last checks'));
  await s.chat(2,'/start');assert(s.sent.at(-1).markup.keyboard.flat().includes('🕒 Last check'));
  assert(!s.sent.at(-1).markup.keyboard.flat().includes('➕ Create code'));
  await s.chat(4,`/start ${alice.code}`);await s.chat(4,'/start');
  assert(!s.sent.at(-1).markup.keyboard.flat().includes('🔐 Change password'));
  await s.chat(2,'🔐 Change password');assert.deepEqual(s.sent.at(-1).markup.keyboard,[['❌ Cancel']]);
  await s.chat(2,'📬 My mailbox');assert.match(s.sent.at(-1).text,/Finish the current step/);
  await s.chat(2,'❓ Help');assert.equal((await first(s.env,'SELECT stage FROM states WHERE user_id=2')).stage,'password');
  await s.chat(2,'❌ Cancel');assert.equal(await first(s.env,'SELECT stage FROM states WHERE user_id=2'),null);
  assert(s.sent.at(-1).markup.keyboard.flat().includes('📬 My mailbox'));
  const cred=await first(s.env,'SELECT password_cipher FROM credentials WHERE key_id=?',alice.id);
  assert.equal(await unseal(s.env,`password:${alice.id}`,cred.password_cipher),'private-password');
  await s.chat(2,'🕒 Last checks');assert(!s.sent.at(-1).text.includes('Bob'));
  const callback=(user,data,id)=>s.api('/telegram',{update_id:id,callback_query:{id:`q${id}`,from:{id:user},message:{chat:{id:user,type:'private'}},data}});
  const before=s.sent.length;await callback(2,`check:${alice.id}`,1001);assert.equal(s.sent.length,before);
  await callback(2,'menu:keys',1002);assert(!s.sent.at(-1).text.includes(alice.code));
  await callback(1,'menu:lastcheck',1003);assert.match(s.sent.at(-1).text,/Bob/);
  await callback(1,`manager:${alice.id}:4`,1004);assert.match(s.sent.at(-1).text,/able to change/);
  assert.equal((await first(s.env,'SELECT owner_id FROM access_keys WHERE id=?',alice.id)).owner_id,2);
  await callback(1,`managerconfirm:${alice.id}:4`,1005);assert.equal((await first(s.env,'SELECT owner_id FROM access_keys WHERE id=?',alice.id)).owner_id,4);
  await s.chat(4,'/start');assert(s.sent.at(-1).markup.keyboard.flat().includes('🔐 Change password'));
  assert.equal((await s.rawChat(2,'constructor')).status,200);
  assert.equal((await callback(1,'menu:constructor',1006)).status,200);
  assert.equal((await callback(1,'malformed',1007)).status,200);
});

test('changing credentials clears latest-attempt state and stale finishes cannot restore it',async()=>{
  const s=setup(),key=await s.enroll(2,'Alice'),lease=await s.claim(key);
  await s.chat(2,'🔐 Change password');await s.chat(2,'replacement');
  let c=await first(s.env,'SELECT last_attempt,last_finished,last_result FROM credentials WHERE key_id=?',key.id);
  assert.equal(c.last_attempt,null);assert.equal(c.last_result,null);assert.equal(c.last_finished,null);
  assert.equal((await s.api('/internal/finish',{...lease,slot:'manual:test',result:'success'})).status,409);
  c=await first(s.env,'SELECT last_result FROM credentials WHERE key_id=?',key.id);assert.equal(c.last_result,null);
});

test('pause is per recipient, blocks a previously fetched delivery and retains the queue for resume',async()=>{
  const s=setup(),key=await s.enroll(2,'Alice');await s.chat(4,`/start ${key.code}`);
  const lease=await s.claim(key);await s.api('/internal/ingest',{...lease,email});
  const held=await first(s.env,'SELECT id FROM deliveries WHERE user_id=2');
  await s.chat(2,'⏸ Pause notifications');
  assert.equal((await first(s.env,'SELECT notifications_paused FROM members WHERE user_id=2')).notifications_paused,1);
  assert(s.sent.at(-1).markup.keyboard.flat().includes('▶️ Resume notifications'));
  assert(s.sent.at(-1).markup.keyboard.flat().includes('🚪 Leave bot'));
  assert.equal((await s.api('/internal/deliver',{id:held.id})).body.skipped,true);
  let ready=(await s.api('/internal/pending',{})).body.ids;assert.equal(ready.length,1);
  await s.api('/internal/deliver',{id:ready[0]});
  await s.api('/internal/jobs',{force:true}); // cleanup must retain the paused recipient's payload
  assert((await first(s.env,'SELECT payload FROM messages')).payload);
  await s.chat(2,'📬 My mailbox');assert.match(s.sent.at(-1).text,/Notifications: paused/);
  await s.chat(2,'/start');assert.match(s.sent.at(-1).text,/Notifications: paused/);
  await s.chat(4,'/resume_notifications');
  assert.equal((await first(s.env,'SELECT notifications_paused FROM members WHERE user_id=2')).notifications_paused,1);
  await s.chat(2,'▶️ Resume notifications');
  ready=(await s.api('/internal/pending',{})).body.ids;assert.deepEqual(ready,[held.id]);
  await s.api('/internal/deliver',{id:held.id});
  assert.equal(s.sent.filter(x=>x.id===2&&x.text.startsWith('From:')).length,1);
  assert.equal(s.sent.filter(x=>x.id===4&&x.text.startsWith('From:')).length,1);
  assert.equal((await s.api('/internal/pending',{})).body.ids.length,0);
});

test('leaving requires private confirmation, preserves shared mailboxes and erases a last-member mailbox',async()=>{
  const s=setup(),key=await s.enroll(2,'Alice');await s.chat(4,`/start ${key.code}`);
  const lease=await s.claim(key);await s.api('/internal/ingest',{...lease,email});
  const callback=(user,data,id,type='private')=>s.api('/telegram',{update_id:id,callback_query:{id:`q${id}`,from:{id:user},message:{chat:{id:user,type}},data}});
  await callback(2,'menu:leave_confirm',2100);assert(await first(s.env,'SELECT user_id FROM members WHERE user_id=2'));
  await s.chat(2,'🚪 Leave bot');assert.match(s.sent.at(-1).text,/saved mailbox login/);
  await s.chat(2,'❌ Cancel');await callback(2,'menu:leave_confirm',2101);
  assert(await first(s.env,'SELECT user_id FROM members WHERE user_id=2'));
  await s.chat(2,'🚪 Leave bot');await callback(2,'menu:leave_confirm',2102,'group');
  assert(await first(s.env,'SELECT user_id FROM members WHERE user_id=2'));
  await callback(2,'menu:leave_confirm',2103);
  assert.equal(await first(s.env,'SELECT * FROM members WHERE user_id=2'),null);
  assert.equal(await first(s.env,'SELECT * FROM deliveries WHERE user_id=2'),null);
  assert.equal(await first(s.env,'SELECT * FROM initial_checks WHERE user_id=2'),null);
  assert(await first(s.env,'SELECT key_id FROM credentials WHERE key_id=?',key.id));
  assert.equal((await first(s.env,'SELECT owner_id FROM access_keys WHERE id=?',key.id)).owner_id,null);
  await s.chat(4,'/start');assert(!s.sent.at(-1).markup.keyboard.flat().includes('🔐 Change password'));
  await s.chat(4,'🚪 Leave bot');await callback(4,'menu:leave_confirm',2104);
  assert.equal(await first(s.env,'SELECT key_id FROM credentials WHERE key_id=?',key.id),null);
  assert.equal(await first(s.env,'SELECT id FROM messages WHERE key_id=?',key.id),null);
  assert.equal(await first(s.env,'SELECT id FROM initial_checks WHERE key_id=?',key.id),null);
  assert.equal((await first(s.env,'SELECT active FROM access_keys WHERE id=?',key.id)).active,1);
  assert(s.sent.at(-1).markup.keyboard.flat().includes('🔑 Enter access code'));
  assert.equal((await s.api('/internal/ingest',{...lease,email})).status,409);
  await s.chat(4,`/start ${key.code}`);assert(await first(s.env,'SELECT user_id FROM members WHERE user_id=4'));
  await s.chat(1,'/stop');assert.match(s.sent.at(-1).text,/host account stays connected/i);
  assert(await first(s.env,'SELECT user_id FROM members WHERE user_id=1'));
});

test('leaving cancels its in-flight first check without deleting another member or their credentials',async()=>{
  const s=setup(),key=await s.enroll(2,'Alice');await s.chat(4,`/start ${key.code}`);
  const request=await first(s.env,'SELECT id FROM initial_checks WHERE user_id=4');
  const batch=(await s.api('/internal/jobs',{initial:true})).body;
  const lease=(await s.api('/internal/claim',{...batch.jobs.find(x=>x.initial_request===request.id),slot:batch.slot})).body;
  await s.chat(4,'🚪 Leave bot');
  await s.api('/telegram',{update_id:2200,callback_query:{id:'exit',from:{id:4},message:{chat:{id:4,type:'private'}},data:'menu:leave_confirm'}});
  assert.equal((await s.api('/internal/ingest',{...lease,email})).status,409);
  assert(await first(s.env,'SELECT key_id FROM credentials WHERE key_id=?',key.id));
  assert(await first(s.env,'SELECT user_id FROM members WHERE user_id=2'));
  assert.equal((await first(s.env,'SELECT owner_id FROM access_keys WHERE id=?',key.id)).owner_id,2);
});

test('host revocation sends immediate notices after access is blocked and reports undeliverable notices',async()=>{
  const s=setup(),key=await s.enroll(2,'Alice');await s.chat(4,`/start ${key.code}`);
  await s.chat(1,'/remove 2');
  const notice=s.sent.find(x=>x.id===2&&x.text.startsWith('Access revoked'));assert(notice);
  assert.match(notice.text,/blocked by the host/);assert(notice.markup.keyboard.flat().includes('🔑 Enter access code'));
  assert.equal((await first(s.env,'SELECT blocked FROM members WHERE user_id=2')).blocked,1);
  await s.chat(2,'❓ Help');assert.match(s.sent.at(-1).text,/Access revoked/);
  await s.chat(1,`/revoke ${key.id}`);
  assert(s.sent.some(x=>x.id===4&&x.text.startsWith('Access revoked')));
  assert.match(s.sent.at(-1).text,/1\/1/);
  assert.equal((await first(s.env,'SELECT active FROM access_keys WHERE id=?',key.id)).active,0);
  const second=await s.enroll(3,'Bob'),send=s.tg.send;
  s.tg.send=async(id,...args)=>{if(id===3) throw new Error('Blocked bot');return send(id,...args);};
  assert.equal((await s.chat(1,`/revoke ${second.id}`)).status,200);
  assert.match(s.sent.at(-1).text,/0\/1/);assert.match(s.sent.at(-1).text,/could not be delivered/);
  assert.equal((await first(s.env,'SELECT active FROM access_keys WHERE id=?',second.id)).active,0);
});

test('host can permanently erase active or revoked organisations without deleting another key or the host',async()=>{
  const s=setup(),key=await s.enroll(2,'Alice'),other=await s.enroll(3,'Bob');
  await s.chat(4,`/start ${key.code}`);const lease=await s.claim(key);await s.api('/internal/ingest',{...lease,email});
  const callback=(user,data,id)=>s.api('/telegram',{update_id:id,callback_query:{id:`q${id}`,from:{id:user},message:{chat:{id:user,type:'private'}},data}});
  await callback(2,`deleteorg:${key.id}:confirm`,2300);assert(await first(s.env,'SELECT id FROM access_keys WHERE id=?',key.id));
  await callback(1,`deleteorg:${key.id}`,2301);assert.match(s.sent.at(-1).text,/This cannot be undone/);
  assert(await first(s.env,'SELECT id FROM access_keys WHERE id=?',key.id));
  await callback(1,`deleteorg:${key.id}:confirm`,2302);
  assert.equal(await first(s.env,'SELECT id FROM access_keys WHERE id=?',key.id),null);
  assert.equal(await first(s.env,'SELECT user_id FROM members WHERE key_id=?',key.id),null);
  assert.equal(await first(s.env,'SELECT key_id FROM credentials WHERE key_id=?',key.id),null);
  assert.equal(await first(s.env,'SELECT id FROM messages WHERE key_id=?',key.id),null);
  assert(s.sent.some(x=>x.id===2&&/permanently deleted your organisation/.test(x.text)));
  assert(s.sent.some(x=>x.id===4&&/permanently deleted your organisation/.test(x.text)));
  assert(await first(s.env,'SELECT key_id FROM credentials WHERE key_id=?',other.id));
  assert.equal((await s.api('/internal/known',lease)).status,409);
  await s.chat(2,`/start ${key.code}`);assert.equal(await first(s.env,'SELECT user_id FROM members WHERE user_id=2'),null);
  await callback(1,'deleteorg:host:confirm',2303);assert(await first(s.env,"SELECT id FROM access_keys WHERE id='host'"));
  await s.chat(1,`/revoke ${other.id}`);await s.chat(1,'👥 Manage access');assert.match(s.sent.at(-1).text,/Bob\nKey: revoked/);
  await callback(1,`members:${other.id}`,2304);assert(s.sent.at(-1).markup.inline_keyboard.flat().some(b=>b.text==='Delete organisation permanently'));
  await callback(1,`deleteorg:${other.id}:confirm`,2305);assert.equal(await first(s.env,'SELECT id FROM access_keys WHERE id=?',other.id),null);
});

test('permanent user deletion restricts only its old code, host can allow it, and blacklist is independent',async()=>{
  const s=setup(),key=await s.enroll(2,'Alice'),other=await s.enroll(3,'Bob');await s.chat(4,`/start ${key.code}`);
  const callback=(user,data,id)=>s.api('/telegram',{update_id:id,callback_query:{id:`q${id}`,from:{id:user},message:{chat:{id:user,type:'private'}},data}});
  await callback(2,`deleteuserconfirm:${key.id}:4`,2400);assert(await first(s.env,'SELECT user_id FROM members WHERE user_id=4'));
  await callback(1,`deleteuser:${key.id}:2`,2401);assert.match(s.sent.at(-1).text,/does not blacklist/);
  assert(await first(s.env,'SELECT user_id FROM members WHERE user_id=2'));
  await callback(1,`deleteuserconfirm:${key.id}:2`,2402);
  assert.equal(await first(s.env,'SELECT user_id FROM members WHERE user_id=2'),null);
  assert(await first(s.env,'SELECT user_id FROM key_blocks WHERE user_id=2 AND key_id=?',key.id));
  assert.equal(await first(s.env,'SELECT user_id FROM blacklist WHERE user_id=2'),null);
  await s.chat(5,`/start ${key.code}`);assert.equal((await first(s.env,'SELECT owner_id FROM access_keys WHERE id=?',key.id)).owner_id,null);
  assert(!s.sent.at(-1).markup.keyboard.flat().includes('🔐 Change password'));
  await s.chat(2,`/start ${key.code}`);assert.equal(await first(s.env,'SELECT user_id FROM members WHERE user_id=2'),null);
  await s.chat(2,`/start ${other.code}`);assert.equal((await first(s.env,'SELECT key_id FROM members WHERE user_id=2')).key_id,other.id);
  await callback(1,`members:${key.id}`,2403);assert(s.sent.at(-1).markup.inline_keyboard.flat().some(b=>b.text==='Allow deleted account 2'));
  await callback(1,`allowdeleted:${key.id}:2`,2404);assert.equal(await first(s.env,'SELECT user_id FROM key_blocks WHERE user_id=2'),null);
  await callback(1,`blacklist:${other.id}:2`,2405);assert.match(s.sent.at(-1).text,/every access code/);
  assert.equal(await first(s.env,'SELECT user_id FROM blacklist WHERE user_id=2'),null);
  await callback(1,`blacklistconfirm:${other.id}:2`,2406);assert(await first(s.env,'SELECT user_id FROM blacklist WHERE user_id=2'));
  await s.chat(2,`/start ${key.code}`);assert.match(s.sent.at(-1).text,/blacklisted/);
  await s.chat(2,`/start ${other.code}`);assert.equal((await first(s.env,'SELECT active FROM members WHERE user_id=2')).active,0);
  await s.chat(1,'⛔ Blocked accounts');assert(s.sent.at(-1).markup.inline_keyboard.flat().some(b=>b.callback_data==='unblacklist:2'));
  await callback(4,'unblacklist:2',2407);assert(await first(s.env,'SELECT user_id FROM blacklist WHERE user_id=2'));
  await callback(1,'unblacklist:2',2408);assert.equal(await first(s.env,'SELECT user_id FROM blacklist WHERE user_id=2'),null);
  await s.chat(2,`/start ${key.code}`);assert.equal((await first(s.env,'SELECT key_id FROM members WHERE user_id=2')).key_id,key.id);
  await callback(1,'deleteuserconfirm:host:1',2409);assert(await first(s.env,'SELECT user_id FROM members WHERE user_id=1'));
  await s.chat(1,'/blacklist 1');assert.equal(await first(s.env,'SELECT user_id FROM blacklist WHERE user_id=1'),null);
});
