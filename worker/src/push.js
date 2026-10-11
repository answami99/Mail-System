import {all, digest, first, json, now, run, sameSecret, stmt} from './common.js';

const SOAP='http://schemas.xmlsoap.org/soap/envelope/';
const M='http://schemas.microsoft.com/exchange/services/2006/messages';
const T='http://schemas.microsoft.com/exchange/services/2006/types';
const ORIGIN='https://private-email-bot.answami99.workers.dev';

// Small bounded XML reader for EWS notifications only. No DTD, external entities,
// CDATA, processing instructions (except initial declaration), or network access.
export function pushXML(raw) {
  raw=raw.replace(/^\uFEFF?\s*<\?xml\s[^?]*\?>/,'');
  if (raw.length>65536 || /<!|<\?/.test(raw)) throw new Error('Invalid XML');
  const root={children:[],ns:{}}, stack=[root]; let offset=0,nodes=0;
  const decode=s=>s.replace(/&(?:amp|lt|gt|quot|apos);/g,x=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[x]));
  const safe=s=>{if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(s)) throw new Error('Invalid entity'); return decode(s);};
  const token=/<[^>]*>|[^<]+/g; let match;
  while ((match=token.exec(raw))) {
    if(match.index!==offset) throw new Error('Invalid XML'); offset=token.lastIndex;
    const value=match[0],parent=stack.at(-1);
    if(!value.startsWith('<')) {parent.text=(parent.text||'')+safe(value);continue;}
    if(value.startsWith('</')) {
      if(stack.length<2 || value!==`</${parent.qname}>`) throw new Error('Invalid close'); stack.pop();continue;
    }
    const head=/^<([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)>$/.exec(value);
    if(!head || ++nodes>1000 || stack.length>16) throw new Error('Invalid element');
    const attrs={},ns={...parent.ns}; let rest=head[2];
    while(rest.trim()) {
      const a=/^\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(rest);
      if(!a || Object.hasOwn(attrs,a[1])) throw new Error('Invalid attribute');
      attrs[a[1]]=safe(a[2]??a[3]);rest=rest.slice(a[0].length);
    }
    for(const [k,v] of Object.entries(attrs)) {if(k==='xmlns') ns['']=v;else if(k.startsWith('xmlns:')) ns[k.slice(6)]=v;}
    const pieces=head[1].split(':');if(pieces.length>2) throw new Error('Invalid name');
    const prefix=pieces.length===2?pieces[0]:'';
    if(prefix && !ns[prefix]) throw new Error('Unknown namespace');
    const node={qname:head[1],name:pieces.at(-1),uri:ns[prefix]||'',ns,attrs,children:[],text:''};
    parent.children.push(node);if(!head[3]) stack.push(node);
  }
  if(offset!==raw.length || stack.length!==1 || root.children.length!==1 || root.text?.trim()) throw new Error('Invalid document');
  const child=(n,name,uri)=>{const found=n.children.filter(x=>x.name===name&&x.uri===uri);if(found.length!==1) throw new Error(`Expected:${name}`);return found[0];};
  const text=n=>{if(n.children.length || !n.text.trim() || n.text.length>4096) throw new Error('Invalid value');return n.text.trim();};
  const envelope=child(root,'Envelope',SOAP), body=child(envelope,'Body',SOAP);
  const send=child(body,'SendNotification',M), responses=child(send,'ResponseMessages',M);
  const response=child(responses,'SendNotificationResponseMessage',M);
  if(response.attrs.ResponseClass!=='Success' || text(child(response,'ResponseCode',M))!=='NoError') throw new Error('Failed notification');
  const n=child(response,'Notification',M), sid=text(child(n,'SubscriptionId',T));
  const events=[];
  for(const event of n.children.filter(x=>x.name.endsWith('Event'))) {
    if(event.uri!==T || !['NewMailEvent','StatusEvent'].includes(event.name)) throw new Error('Unexpected event');
    const watermark=text(child(event,'Watermark',T));
    if(event.name==='StatusEvent') continue;
    const item=child(event,'ItemId',T),folder=child(event,'ParentFolderId',T);
    if(!item.attrs.Id || !folder.attrs.Id || item.attrs.Id.length>4096 || folder.attrs.Id.length>4096) throw new Error('Invalid ID');
    events.push({watermark,item:item.attrs.Id,folder:folder.attrs.Id});
  }
  return {sid,events};
}
export function pushResponse(status='OK') {
  return new Response(`<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="${SOAP}"><s:Body><SendNotificationResult xmlns="${M}"><SubscriptionStatus>${status}</SubscriptionStatus></SendNotificationResult></s:Body></s:Envelope>`,
    {headers:{'Content-Type':'text/xml; charset=utf-8','Cache-Control':'no-store'}});
}
export async function pushWindow(env, date=new Date()) {
  if((await first(env,"SELECT value FROM settings WHERE id='realtime_hours'"))?.value==='always') return true;
  const local=new Date(date.getTime()+330*60000), minute=local.getUTCHours()*60+local.getUTCMinutes();
  return ![0,6].includes(local.getUTCDay()) && minute>=570 && minute<=1080;
}
export async function dispatchPush(env) {
  if(!env.GITHUB_DISPATCH_TOKEN || !await pushWindow(env)) return false;
  const pending=await first(env,`SELECT p.key_id FROM push_subscriptions p JOIN credentials c ON c.key_id=p.key_id AND c.revision=p.revision
    JOIN access_keys k ON k.id=p.key_id WHERE p.event_seq>p.done_seq AND p.state='active' AND c.paused=0 AND k.active=1
    AND EXISTS(SELECT 1 FROM members m WHERE m.key_id=p.key_id AND m.active=1 AND m.blocked=0) LIMIT 1`);
  if(!pending) return false;
  const gate=await first(env,`UPDATE push_dispatch SET lease_until=? WHERE id='events' AND lease_until<? AND requested_at<=? RETURNING id`,now()+15,now(),now()-60);
  if(!gate) return false;
  let ok=false;
  try {
    const response=await fetch('https://api.github.com/repos/answami99/Mail-System/actions/workflows/push.yml/dispatches',{
      method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),
      headers:{Authorization:`Bearer ${env.GITHUB_DISPATCH_TOKEN}`,Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2026-03-10','Content-Type':'application/json','User-Agent':'RajasthanMailNotifier'},body:JSON.stringify({ref:'main'})});
    ok=[200,204].includes(response.status);
  } catch { /* Durable pending state survives dispatch errors. */ }
  await run(env,"UPDATE push_dispatch SET requested_at=CASE WHEN ?=1 THEN ? ELSE requested_at END,lease_until=0 WHERE id='events'",Number(ok),now());
  return ok;
}
export async function receivePush(request,env) {
  const url=new URL(request.url), generation=url.pathname.slice('/exchange/'.length), token=url.searchParams.get('token');
  const p=await first(env,`SELECT p.* FROM push_subscriptions p JOIN credentials c ON c.key_id=p.key_id AND c.revision=p.revision
    JOIN access_keys k ON k.id=p.key_id WHERE p.generation=? AND k.active=1 AND c.paused=0
    AND EXISTS(SELECT 1 FROM members m WHERE m.key_id=p.key_id AND m.active=1 AND m.blocked=0)`,generation);
  if(!p || p.state==='failed') return pushResponse('Unsubscribe');
  await run(env,'UPDATE push_subscriptions SET last_request=? WHERE generation=?',now(),generation);
  if(typeof token!=='string' || !await sameSecret(env,await digest(env,token),p.token_hash)) {
    await run(env,"UPDATE push_subscriptions SET callback_error='Invalid callback token' WHERE generation=?",generation);
    return new Response('Forbidden',{status:403});
  }
  const reader=request.body?.getReader();if(!reader) return new Response('Body required',{status:400});
  const chunks=[];let size=0;
  while(true) {const {done,value}=await reader.read();if(done) break;size+=value.length;
    if(size>65536) {await reader.cancel();return new Response('Too large',{status:413});}chunks.push(value);}
  const bytes=new Uint8Array(size);let position=0;for(const chunk of chunks) {bytes.set(chunk,position);position+=chunk.length;}
  let data;try {data=pushXML(new TextDecoder('utf-8',{fatal:true}).decode(bytes));} catch(error) {
    const kind=/^(Expected:[A-Za-z]+|Invalid [A-Za-z ]+|Unknown namespace|Unexpected event|Failed notification)$/.test(error.message)?error.message:'Invalid encoding';
    await run(env,'UPDATE push_subscriptions SET callback_error=? WHERE generation=?',kind,generation);
    return new Response('Invalid notification',{status:400});
  }
  if(p.state!=='active') {
    if(now()>p.created_at+300) return pushResponse('Unsubscribe');
    // Subscription confirmation can race the initial status callback. No work is
    // triggered until the runner confirms the returned subscription and Inbox IDs.
    await run(env,'UPDATE push_subscriptions SET last_seen=?,callback_error=NULL WHERE generation=?',now(),generation);
    return pushResponse();
  }
  if(!await sameSecret(env,await digest(env,data.sid),p.subscription_hash)) return new Response('Forbidden',{status:403});
  for(const event of data.events) {
    if(!await sameSecret(env,await digest(env,event.folder),p.folder_hash)) continue;
    const id=await digest(env,`${generation}\n${event.item}\n${event.watermark}`);
    await env.DB.batch([
      stmt(env,'INSERT OR IGNORE INTO push_receipts(id,created_at) VALUES(?,?)',id,now()),
      stmt(env,'UPDATE push_subscriptions SET event_seq=event_seq+1 WHERE generation=? AND changes()=1',generation)
    ]);
  }
  await run(env,'UPDATE push_subscriptions SET last_seen=?,callback_error=NULL WHERE generation=?',now(),generation);
  // Heartbeats retry a previously failed or throttled dispatch, without scanning
  // mail or starting idle GitHub jobs. Response remains bounded to 10 seconds.
  await dispatchPush(env);
  return pushResponse();
}
export async function pushControl(env,route,body,c) {
  if(!c) return json({error:'Expired lease'},409);
  if(route==='/internal/push/prepare') {
    const old=await first(env,'SELECT * FROM push_subscriptions WHERE key_id=?',c.key_id);
    if(old?.revision===c.revision && old.state==='active' && Math.max(old.created_at,old.last_seen)>now()-300) return json({needed:false});
    if(old?.revision===c.revision && old.state==='provisioning' && old.created_at>now()-300) return json({needed:false});
    // A server that cannot reach this callback must not create a replacement
    // subscription on every recovery scan. Keep accepting late callbacks and
    // retry at most every six hours until one has actually been received.
    if(old?.revision===c.revision && !old.last_seen && old.created_at>now()-21600) return json({needed:false});
    const generation=crypto.randomUUID(), token=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
    await run(env,`INSERT INTO push_subscriptions(key_id,revision,generation,token_hash,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(key_id) DO UPDATE SET revision=excluded.revision,generation=excluded.generation,token_hash=excluded.token_hash,
      subscription_hash=NULL,folder_hash=NULL,state='provisioning',created_at=excluded.created_at,last_seen=0,last_request=0,callback_error=NULL,event_seq=0,done_seq=0`,
      c.key_id,c.revision,generation,await digest(env,token),now());
    return json({needed:true,generation,callback_url:`${ORIGIN}/exchange/${generation}?token=${token}`});
  }
  if(route==='/internal/push/confirm') {
    if(![body.subscription_id,body.folder_id].every(x=>typeof x==='string' && x.length>0 && x.length<=4096)) return json({error:'Invalid subscription'},400);
    const p=await first(env,`UPDATE push_subscriptions SET state='active',subscription_hash=?,folder_hash=?
      WHERE key_id=? AND revision=? AND generation=? AND state='provisioning' RETURNING generation`,
      await digest(env,body.subscription_id),await digest(env,body.folder_id),c.key_id,c.revision,body.generation);
    return p?json({ok:true}):json({error:'Unavailable'},409);
  }
  if(route==='/internal/push/failed') {
    await run(env,"UPDATE push_subscriptions SET state='failed' WHERE key_id=? AND revision=? AND generation=?",c.key_id,c.revision,body.generation);
    return json({ok:true});
  }
  return json({error:'Not found'},404);
}
