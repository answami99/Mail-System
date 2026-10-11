import {all, canEdit, digest, first, isHost, member, now, randomCode, rate, run, seal, stmt, unseal, sameSecret} from './common.js';
import {queueInitial} from './initial.js';
import {callbackCommands, menuCommands, showHelp, showLastChecks, showMailbox, showMenu, withMenus} from './ui.js';

const help = '/status — last check and delivery backlog\n/email — connect or change mailbox\n/password — change password\n/pause — pause your notifications\n/resume_notifications — resume your notifications\n/stop — leave the bot after confirmation\n/cancel — cancel entry';
const adminHelp = '\n/new Person or organisation — create a named code\n/keys — manage people and organisations\n/members KEY_ID — accounts\n/remove TELEGRAM_ID — remove code access\n/allow TELEGRAM_ID — restore code access\n/blocked — manage the blacklist\n/blacklist TELEGRAM_ID — block every code\n/unblacklist TELEGRAM_ID — remove global block\n/revoke KEY_ID — revoke code and erase mailbox data\n/owner KEY_ID TELEGRAM_ID — change mailbox manager\n/resume KEY_ID — retry a paused mailbox\n/health — all mailbox status';

async function state(env, user, stage, draft = null) {
  return run(env, `INSERT INTO states VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
    stage=excluded.stage,draft=excluded.draft,expires=excluded.expires`, user, stage, draft, now() + 600);
}
async function beginEmail(env, user, tg) {
  await state(env, user, 'email');
  await tg.send(user, 'Enter your full @rajasthan.gov.in email address. Accounts on this code share the mailbox.');
}
async function askPassword(env, user, draft, tg) {
  await state(env, user, 'password', await seal(env, `draft:${user}`, draft));
  await tg.send(user, 'Enter the mailbox password within 10 minutes, or tap Cancel.\nTelegram chat is not end-to-end encrypted. The bot tries to delete your message and encrypts the stored password; the system owner can decrypt it.');
}
async function leaveBot(env,user,m,tg,confirm=false) {
  if(isHost(env,user)) return tg.send(user,'The host account stays connected so you can manage the system. Use Pause notifications to stop your own email alerts.');
  if(!confirm) {
    await state(env,user,'leave',await seal(env,`draft:${user}`,{key_id:m.key_id}));
    return tg.send(user,`Leave ${m.name}?\n\nYour name, membership and notification history/queue will be removed. If no other accounts remain connected to this key, its saved mailbox login and cached email metadata will also be deleted. If other accounts remain, their shared mailbox stays connected. If you are its manager, the host will need to appoint a new manager.\n\nYour emails in Outlook are untouched. You can rejoin later with an active access code. A notification already being sent may still arrive.`,
      {inline_keyboard:[[{text:'Confirm leave',callback_data:'menu:leave_confirm'},{text:'Stay connected',callback_data:'menu:home'}]]});
  }
  const pending=await first(env,"SELECT draft FROM states WHERE user_id=? AND stage='leave' AND expires>?",user,now());
  if(!pending || (await unseal(env,`draft:${user}`,pending.draft)).key_id!==m.key_id) return tg.send(user,'This confirmation expired. Tap Leave bot again.');
  await eraseAccount(env,user,m.key_id);
  return tg.send(user,'You have left the bot. Your Telegram account is disconnected and will receive no further email notifications. To join again, tap Enter access code and use an active code from the host.');
}
async function eraseAccount(env,user,keyId,blockCode=false) {
  const noMembers='NOT EXISTS(SELECT 1 FROM members WHERE key_id=? AND active=1 AND blocked=0)';
  await env.DB.batch([
    ...(blockCode?[stmt(env,'INSERT OR IGNORE INTO key_blocks VALUES(?,?,?)',user,keyId,now())]:[]),
    stmt(env,`UPDATE credentials SET lease=NULL,lease_until=0,last_result=NULL,last_finished=?,status='Initial check cancelled when account left'
      WHERE key_id=? AND lease IN (SELECT lease FROM initial_checks WHERE user_id=?)`,now(),keyId,user),
    stmt(env,'UPDATE access_keys SET owner_id=NULL WHERE id=? AND owner_id=?',keyId,user),
    stmt(env,'DELETE FROM states WHERE user_id=?',user),
    stmt(env,'DELETE FROM initial_checks WHERE user_id=?',user),
    stmt(env,'DELETE FROM deliveries WHERE user_id=?',user),
    stmt(env,'DELETE FROM members WHERE user_id=?',user),
    stmt(env,`DELETE FROM credentials WHERE key_id=? AND ${noMembers}`,keyId,keyId),
    stmt(env,`DELETE FROM push_subscriptions WHERE key_id=? AND ${noMembers}`,keyId,keyId),
    stmt(env,`DELETE FROM initial_checks WHERE key_id=? AND ${noMembers}`,keyId,keyId),
    stmt(env,`DELETE FROM messages WHERE key_id=? AND ${noMembers}`,keyId,keyId)
  ]);
}
async function notifyRevoked(tg,user,text) {
  try {await tg.send(user,`Access revoked\n\n${text}\nContact the host if you think this is a mistake.`);return true;}
  catch {return false;}
}
async function afterName(env, user, joined, tg, fresh=true) {
  await tg.send(user, `Connected to ${joined.name}, ${joined.label}.\nUse the buttons below.`);
  const creds=await first(env,'SELECT revision FROM credentials WHERE key_id=?',joined.key_id);
  if(!creds && canEdit(env,joined)) return beginEmail(env,user,tg);
  if(!creds) return tg.send(user,'The mailbox manager must connect the email account first.');
  if(fresh) {
    const dispatched=await queueInitial(env,joined.key_id,user,creds.revision);
    return tg.send(user,dispatched?'Your first unread-mail check has been requested. Results will appear when it completes.':'Your first unread-mail check is queued for the next recovery check.');
  }
}
async function redeem(env, user, label, code, tg) {
  if(!await rate(env,`login:${user}`,5,900) || !await rate(env,'login:global',100,3600)) return tg.send(user,'Too many key attempts. Try later.');
  let key;
  if(isHost(env,user) && await sameSecret(env,code,env.HOST_ACCESS_KEY)) {
    await run(env,`INSERT INTO access_keys VALUES('host','Host',?,?,?,1,?) ON CONFLICT(id)
      DO UPDATE SET code_hash=excluded.code_hash,code_cipher=excluded.code_cipher`,await digest(env,code),await seal(env,'key:host',code),user,now());
    key=await first(env,"SELECT * FROM access_keys WHERE id='host'");
  } else {
    key=await first(env,"SELECT * FROM access_keys WHERE code_hash=? AND active=1 AND id<>'host'",await digest(env,code));
    if(!key || await first(env,'SELECT user_id FROM blacklist WHERE user_id=?',user) ||
      await first(env,'SELECT user_id FROM key_blocks WHERE user_id=? AND key_id=?',user,key.id) || isHost(env,user)) return tg.send(user,'Key not accepted. Contact the host.');
  }
  const existing=await member(env,user);
  if(existing && existing.key_id!==key.id) return tg.send(user,'Already attached to another key. Ask the host to remove that membership first.');
  if(existing) return afterName(env,user,existing,tg,false);
  const limit=Math.max(1,Math.min(20,Number(env.MAX_MEMBERS_PER_KEY||5)));
  if((await first(env,'SELECT COUNT(*) AS n FROM members WHERE key_id=? AND active=1 AND blocked=0',key.id)).n>=limit) return tg.send(user,'This key has reached its account limit. Contact the host.');
  await state(env,user,'name',await seal(env,`draft:${user}`,{key_id:key.id}));
  return tg.send(user,`Welcome to ${key.name}!\n\nEnter your name (1–64 characters). The host sees it to identify accounts and prevent misuse.\n\nThis code shares one mailbox. Its first user adds the email and password. Tap Cancel to stop.`);
}
async function completeName(env,user,text,pending,tg) {
  const label=text.trim();
  if(!label || label.length>64 || /[\u0000-\u001f\u007f]/.test(label) || label.startsWith('/')) return tg.send(user,'Please enter your name using 1–64 characters, or /cancel.');
  const {key_id}=await unseal(env,`draft:${user}`,pending.draft);
  const key=await first(env,'SELECT * FROM access_keys WHERE id=? AND active=1',key_id);
  const current=await first(env,'SELECT * FROM members WHERE user_id=?',user);
  if(!key || await first(env,'SELECT user_id FROM blacklist WHERE user_id=?',user) ||
    await first(env,'SELECT user_id FROM key_blocks WHERE user_id=? AND key_id=?',user,key_id) ||
    (key_id==='host')!==isHost(env,user) || current?.active && current.key_id!==key_id) {
    await run(env,'DELETE FROM states WHERE user_id=?',user);return tg.send(user,'This invitation is no longer available. Contact the host.');
  }
  const limit=Math.max(1,Math.min(20,Number(env.MAX_MEMBERS_PER_KEY||5)));
  await env.DB.batch([
    stmt(env,`INSERT INTO members(user_id,key_id,label,joined_at) SELECT ?,?,?,?
      WHERE (SELECT COUNT(*) FROM members WHERE key_id=? AND active=1 AND blocked=0)<?
      AND NOT EXISTS(SELECT 1 FROM blacklist WHERE user_id=?) AND NOT EXISTS(SELECT 1 FROM key_blocks WHERE user_id=? AND key_id=?)
      ON CONFLICT(user_id) DO UPDATE SET key_id=excluded.key_id,label=excluded.label,active=1,blocked=0,notifications_paused=0`,user,key_id,label,now(),key_id,limit,user,user,key_id),
    stmt(env,`UPDATE access_keys SET owner_id=? WHERE id=? AND owner_id IS NULL AND
      (SELECT COUNT(*) FROM members WHERE key_id=? AND active=1 AND blocked=0)=1 AND
      EXISTS(SELECT 1 FROM members WHERE user_id=? AND key_id=? AND active=1 AND blocked=0)`,user,key_id,key_id,user,key_id),
    stmt(env,'DELETE FROM states WHERE user_id=?',user)
  ]);
  const joined=await member(env,user);
  if(!joined || joined.key_id!==key_id) return tg.send(user,'This key has reached its account limit. Contact the host.');
  if(isHost(env,user)) await tg.send(user,'Host access enabled. Use Create code, Manage access and Last checks on your dashboard.');
  return afterName(env,user,joined,tg);
}

async function hostButtons(env, query, tg) {
  const user=query.from?.id;
  if(!isHost(env,user) || query.message?.chat?.type!=='private' || query.message.chat.id!==user || !(await member(env,user))) return;
  if(typeof query.id!=='string' || typeof query.data!=='string' || query.data.length>64) return;
  await tg.call('answerCallbackQuery',{callback_query_id:query.id});
  const [action,keyId,target]=query.data.split(':');
  if(action==='keypage' && /^\d+$/.test(keyId||'')) return admin(env,user,'/keys',keyId,tg,0);
  if(action==='unblacklist' && /^\d+$/.test(keyId||'') && !isHost(env,keyId)) return admin(env,user,'/unblacklist',keyId,tg,0);
  if(typeof keyId!=='string' || !/^(host|key-\d+)$/.test(keyId)) return;
  const key=await first(env,'SELECT * FROM access_keys WHERE id=?',keyId);
  if(!key || !key.active && !['members','deleteorg','deleteuser','deleteuserconfirm','allowdeleted','blacklist','blacklistconfirm'].includes(action)) return tg.send(user,'This key is no longer active. Open /keys again.');
  if(action==='check') return showMailbox(env,user,tg,keyId);
  if(action==='resume') {await admin(env,user,'/resume',keyId,tg,0);return showMailbox(env,user,tg,keyId);}
  if(action==='members') {
    const rows=await all(env,'SELECT m.user_id,m.label,m.active,m.blocked,m.notifications_paused,b.user_id AS blacklisted FROM members m LEFT JOIN blacklist b ON b.user_id=m.user_id WHERE m.key_id=? ORDER BY m.joined_at,m.user_id',keyId);
    const text=`${key.name}\nKey: ${!key.active?'revoked':keyId==='host'?'your private host key':await unseal(env,`key:${keyId}`,key.code_cipher)}\nTelegram accounts: ${rows.filter(r=>r.active&&!r.blocked).length}\n`+
      (rows.map((r,i)=>`${i+1}. ${r.label} — ${r.blacklisted?'blacklisted':r.blocked?'code access removed':r.active?'active'+(r.notifications_paused?' · notifications paused':''):'inactive'}`).join('\n')||'No accounts have joined yet.');
    const buttons=rows.filter(r=>String(r.user_id)!==env.HOST_TELEGRAM_ID).map(r=>[{text:`${r.blocked?'Allow':'Remove'} ${r.label}`.slice(0,64),callback_data:`${r.blocked?'allow':'remove'}:${keyId}:${r.user_id}`}]);
    for(const r of rows.filter(r=>String(r.user_id)!==env.HOST_TELEGRAM_ID)) buttons.push([{text:`Delete permanently: ${r.label}`.slice(0,64),callback_data:`deleteuser:${keyId}:${r.user_id}`}]);
    for(const r of rows.filter(r=>String(r.user_id)!==env.HOST_TELEGRAM_ID && !r.blacklisted)) buttons.push([{text:`Blacklist: ${r.label}`.slice(0,64),callback_data:`blacklist:${keyId}:${r.user_id}`}]);
    const removed=await all(env,'SELECT b.user_id FROM key_blocks b WHERE b.key_id=? AND NOT EXISTS(SELECT 1 FROM members m WHERE m.user_id=b.user_id AND m.key_id=b.key_id) ORDER BY b.created_at LIMIT 20',keyId);
    for(const r of removed) buttons.push([{text:`Allow deleted account ${r.user_id}`,callback_data:`allowdeleted:${keyId}:${r.user_id}`}]);
    for(const r of rows.filter(r=>key.active&&r.active&&!r.blocked&&r.user_id!==key.owner_id&&keyId!=='host'))
      buttons.push([{text:`Make manager: ${r.label}`.slice(0,64),callback_data:`manager:${keyId}:${r.user_id}`}]);
    buttons.push([{text:'Last check',callback_data:`check:${keyId}`},{text:'All access codes',callback_data:'menu:keys'}]);
    if(keyId!=='host' && key.active) buttons.push([{text:`Revoke ${key.name}`.slice(0,64),callback_data:`revoke:${keyId}`}]);
    if(keyId!=='host') buttons.push([{text:'Delete organisation permanently',callback_data:`deleteorg:${keyId}`}]);
    return tg.send(user,text,{inline_keyboard:buttons});
  }
  if(action==='deleteorg' && keyId!=='host') {
    if(target!=='confirm') return tg.send(user,`Delete ${key.name} permanently?\n\nThis erases its code, all connected account profiles, saved mailbox login, notification history/queue and cached email metadata. The code will stop working. Connected users will receive an access-revoked notice. Outlook emails are untouched. This cannot be undone.`,
      {inline_keyboard:[[{text:'Confirm permanent deletion',callback_data:`deleteorg:${keyId}:confirm`},{text:'Back',callback_data:`members:${keyId}`}]]});
    const recipients=await all(env,'SELECT user_id FROM members WHERE key_id=? AND active=1 AND blocked=0',keyId);
    await env.DB.batch([
      stmt(env,'INSERT OR IGNORE INTO retired_codes VALUES(?,?)',key.code_hash,now()),
      stmt(env,'DELETE FROM states WHERE user_id IN (SELECT user_id FROM members WHERE key_id=?)',keyId),
      stmt(env,'DELETE FROM initial_checks WHERE key_id=?',keyId),
      stmt(env,'DELETE FROM messages WHERE key_id=?',keyId),
      stmt(env,'DELETE FROM credentials WHERE key_id=?',keyId),
      stmt(env,'DELETE FROM push_subscriptions WHERE key_id=?',keyId),
      stmt(env,'DELETE FROM members WHERE key_id=?',keyId),
      stmt(env,'DELETE FROM access_keys WHERE id=?',keyId)
    ]);
    let notified=0;
    for(const r of recipients) notified+=Number(await notifyRevoked(tg,r.user_id,'The host has permanently deleted your organisation/access code. Your account is disconnected from this mailbox. Ask the host for a new invitation if you need access again.'));
    return tg.send(user,`${key.name} permanently deleted. Access-revoked notices accepted by Telegram: ${notified}/${recipients.length}.${notified<recipients.length?' Some notices could not be delivered; access is still removed.':''}`);
  }
  if(action==='allowdeleted' && /^\d+$/.test(target||'') && !isHost(env,target)) {
    await run(env,'DELETE FROM key_blocks WHERE user_id=? AND key_id=?',Number(target),keyId);
    return tg.send(user,`Account ${target} may use this code again. Any separate blacklist still applies. The account must enter the code to rejoin.`);
  }
  if(['deleteuser','deleteuserconfirm','blacklist','blacklistconfirm'].includes(action) && /^\d+$/.test(target||'') && !isHost(env,target)) {
    const account=await first(env,'SELECT label FROM members WHERE user_id=? AND key_id=?',Number(target),keyId);
    if(!account) return tg.send(user,'That account no longer belongs to this organisation. Open Manage access again.');
    if(action==='blacklist') return tg.send(user,`Blacklist ${account.label}? This blocks this Telegram account from every access code and stops its email notifications. You can undo this from Blocked accounts.`,
      {inline_keyboard:[[{text:'Confirm blacklist',callback_data:`blacklistconfirm:${keyId}:${target}`},{text:'Back',callback_data:`members:${keyId}`}]]});
    if(action==='blacklistconfirm') return admin(env,user,'/blacklist',target,tg,0);
    if(action==='deleteuser') return tg.send(user,`Delete ${account.label} permanently?\n\nThis erases their name, membership and notification history/queue. If they are the last connected account, the saved mailbox login and cached metadata are also erased. Other connected accounts keep their shared mailbox.\n\nOnly their Telegram ID and this code restriction are retained: they cannot reuse this code until you allow it, but may join with a different code. This does not blacklist them. Outlook emails are untouched. This cannot be undone.`,
      {inline_keyboard:[[{text:'Confirm permanent deletion',callback_data:`deleteuserconfirm:${keyId}:${target}`},{text:'Back',callback_data:`members:${keyId}`}]]});
    await eraseAccount(env,Number(target),keyId,true);
    const notified=await notifyRevoked(tg,Number(target),'The host has permanently removed your account from this organisation. You cannot reuse its code unless the host allows it again. You may join with a different active code; this is not a blacklist.');
    return tg.send(user,`${account.label} permanently deleted. Their old code is blocked for this account; a different code may be used. ${notified?'Access-revoked notice accepted by Telegram.':'Telegram could not deliver the notice; access is still removed.'}`);
  }
  if(['manager','managerconfirm'].includes(action) && keyId!=='host' && /^\d+$/.test(target||'')) {
    const account=await first(env,'SELECT label FROM members WHERE user_id=? AND key_id=? AND active=1 AND blocked=0',Number(target),keyId);
    if(!account) return tg.send(user,'That account is no longer an active member of this key.');
    if(action==='manager') return tg.send(user,`Make ${account.label} the mailbox manager for ${key.name}? They will be able to change its saved email address and password.`,
      {inline_keyboard:[[{text:'Confirm manager',callback_data:`managerconfirm:${keyId}:${target}`},{text:'Back',callback_data:`members:${keyId}`}]]});
    return admin(env,user,'/owner',`${keyId} ${target}`,tg,0);
  }
  if(['remove','allow'].includes(action) && /^\d+$/.test(target||'') && !isHost(env,target)) {
    const account=await first(env,'SELECT label FROM members WHERE user_id=? AND key_id=?',Number(target),keyId);
    if(!account) return tg.send(user,'That account no longer belongs to this key.');
    await admin(env,user,`/${action}`,target,tg,0);
    return tg.send(user,`${account.label} — ${key.name}: ${action==='remove'?'removed and blocked':'allowed to enter the key again'}.`);
  }
  if(action==='revoke' && keyId!=='host') {
    if(target!=='confirm') return tg.send(user,`Revoke ${key.name}? This disables its code and removes its saved mailbox credentials and queued notifications.`,
      {inline_keyboard:[[{text:'Confirm revoke',callback_data:`revoke:${keyId}:confirm`},{text:'Back',callback_data:`members:${keyId}`}]]});
    return admin(env,user,'/revoke',keyId,tg,0);
  }
}

async function admin(env, user, command, argument, tg, updateId) {
  if (command === '/new') {
    if(!argument) {await state(env,user,'new_key');return tg.send(user,'Enter the name of the person or organisation for this code (1–64 characters).');}
    if(argument.length>64 || /[\u0000-\u001f\u007f]/.test(argument)) return tg.send(user,'Use /new Person or organisation name (1–64 characters).');
    await run(env,'DELETE FROM states WHERE user_id=?',user);
    const id = `key-${updateId}`;
    const previous = await first(env, 'SELECT * FROM access_keys WHERE id=?', id);
    if (previous) return tg.send(user, `Name: ${previous.name}\nKey: ${await unseal(env, `key:${id}`, previous.code_cipher)}`);
    const count = await first(env, 'SELECT COUNT(*) AS n FROM access_keys WHERE active=1');
    if (count.n >= Number(env.MAX_KEYS || 10)) return tg.send(user, 'Configured mailbox limit reached (including Host).');
    let code,hash;
    do {code=randomCode();hash=await digest(env,code);} while(code===env.HOST_ACCESS_KEY || await first(env,'SELECT code_hash FROM access_keys WHERE code_hash=? UNION SELECT code_hash FROM retired_codes WHERE code_hash=?',hash,hash));
    await run(env, 'INSERT INTO access_keys VALUES(?,?,?,?,NULL,1,?)', id, argument, await digest(env, code), await seal(env, `key:${id}`, code), now());
    return tg.send(user, `Name: ${argument}\nKey: ${code}\nNo expiry. Share privately.\nUsers see this welcome name and enter their own name to prevent misuse. The first user manages the shared mailbox.`);
  }
  if (command === '/keys') {
    const page=Math.max(0,Math.min(1000,Number.parseInt(argument,10)||0)),size=20;
    const rows = await all(env, `SELECT k.*, (SELECT COUNT(*) FROM members m WHERE m.key_id=k.id AND m.active=1 AND m.blocked=0) AS n FROM access_keys k ORDER BY created_at,id LIMIT ? OFFSET ?`,size,page*size);
    const texts = [];
    for (const k of rows) texts.push(`${k.name}\nKey: ${k.active?await unseal(env, `key:${k.id}`, k.code_cipher):'revoked'}\nTelegram accounts: ${k.n}`);
    const buttons=rows.map(k=>[{text:`Manage ${k.name}`.slice(0,64),callback_data:`members:${k.id}`}]);
    const pages=[];if(page) pages.push({text:'Previous',callback_data:`keypage:${page-1}`});
    if((await first(env,'SELECT COUNT(*) AS n FROM access_keys')).n>(page+1)*size) pages.push({text:'Next',callback_data:`keypage:${page+1}`});
    if(pages.length) buttons.push(pages);
    return tg.send(user, texts.join('\n\n') || 'No keys.', {inline_keyboard:buttons});
  }
  if (command === '/members') {
    const rows = await all(env, 'SELECT user_id,label,active,blocked FROM members WHERE key_id=?', argument);
    return tg.send(user, rows.map(m => `${m.label}: ${m.user_id} — ${m.blocked ? 'blocked' : m.active ? 'active' : 'inactive'}`).join('\n') || 'No accounts for that key ID.');
  }
  if (command === '/remove' || command === '/allow') {
    if (!/^\d+$/.test(argument) || isHost(env, argument)) return tg.send(user, 'Use a non-host Telegram numeric ID.');
    const id = Number(argument);
    if(!await first(env,'SELECT user_id FROM members WHERE user_id=?',id) && (command!=='/allow' || !await first(env,'SELECT user_id FROM key_blocks WHERE user_id=?',id))) return tg.send(user,'That account is no longer enrolled. Open Manage access again.');
    await env.DB.batch([
      ...(command==='/remove'?[stmt(env,'INSERT OR IGNORE INTO key_blocks(user_id,key_id,created_at) SELECT user_id,key_id,? FROM members WHERE user_id=?',now(),id)]:[stmt(env,'DELETE FROM key_blocks WHERE user_id=?',id)]),
      stmt(env, 'UPDATE members SET active=0,blocked=? WHERE user_id=?', command === '/remove' ? 1 : 0, id),
      stmt(env, 'DELETE FROM states WHERE user_id=?', id),
      stmt(env, 'DELETE FROM deliveries WHERE user_id=? AND state<>\'sent\'', id)
    ]);
    if(command==='/allow') return tg.send(user,'Code access restored; the account must enter its key again. Any separate blacklist still applies.');
    const notified=await notifyRevoked(tg,id,'This Telegram account has been blocked by the host from its current access code. Email notifications have stopped. Ask the host to allow that code again or issue a different code.');
    return tg.send(user,`Account blocked. Its key cannot be reused by this account unless you /allow it. ${notified?'Access-revoked notice accepted by Telegram.':'Telegram could not deliver the access-revoked notice; access remains blocked.'} An already in-flight notification may still arrive.`);
  }
  if(command==='/blocked') {
    const rows=await all(env,'SELECT b.user_id,m.label FROM blacklist b LEFT JOIN members m ON m.user_id=b.user_id ORDER BY b.created_at LIMIT 50');
    return tg.send(user,rows.length?'Blacklisted accounts\nThese accounts cannot join with any code. Tap an account to unblock it.':'No blacklisted accounts.',
      {inline_keyboard:[...rows.map(r=>[{text:`Unblock ${r.label||'account '+r.user_id}`.slice(0,64),callback_data:`unblacklist:${r.user_id}`}]),[{text:'Main menu',callback_data:'menu:home'}]]});
  }
  if(command==='/blacklist' || command==='/unblacklist') {
    if(!/^\d+$/.test(argument) || isHost(env,argument)) return tg.send(user,'Choose a non-host account.');
    const id=Number(argument);
    if(command==='/unblacklist') {await run(env,'DELETE FROM blacklist WHERE user_id=?',id);return tg.send(user,'Account removed from the blacklist. It may enter an active code to rejoin; code-specific restrictions still apply.');}
    await env.DB.batch([stmt(env,'INSERT OR IGNORE INTO blacklist VALUES(?,?)',id,now()),
      stmt(env,'UPDATE members SET active=0 WHERE user_id=?',id),stmt(env,'DELETE FROM states WHERE user_id=?',id),
      stmt(env,"DELETE FROM deliveries WHERE user_id=? AND state<>'sent'",id)]);
    const notified=await notifyRevoked(tg,id,'This Telegram account has been blacklisted by the host. Email notifications have stopped and no access code can be used until the host removes the account from the blocked list.');
    return tg.send(user,`Account blacklisted across all access codes. ${notified?'Access-revoked notice accepted by Telegram.':'Telegram could not deliver the notice; access is still blocked.'}`);
  }
  if (command === '/revoke') {
    if (argument === 'host') return tg.send(user, 'Host key cannot be revoked here. Rotate it in Cloudflare secrets.');
    const recipients=await all(env,'SELECT user_id FROM members WHERE key_id=? AND active=1 AND blocked=0',argument);
    await env.DB.batch([
      stmt(env, 'UPDATE access_keys SET active=0,code_cipher=\'\' WHERE id=?', argument),
      stmt(env, 'DELETE FROM states WHERE user_id IN (SELECT user_id FROM members WHERE key_id=?)', argument),
      stmt(env, 'UPDATE members SET active=0 WHERE key_id=?', argument),
      stmt(env, 'DELETE FROM credentials WHERE key_id=?', argument),
      stmt(env, 'DELETE FROM push_subscriptions WHERE key_id=?', argument),
      stmt(env, 'DELETE FROM messages WHERE key_id=?', argument)
    ]);
    let notified=0;
    for(const r of recipients) notified+=Number(await notifyRevoked(tg,r.user_id,'The host has revoked your access code. Your Telegram account is disconnected from this mailbox and email notifications have stopped.'));
    return tg.send(user, `Key revoked; credentials and queued mail removed. Access-revoked notices accepted by Telegram: ${notified}/${recipients.length}.${notified<recipients.length?' Some notices could not be delivered; access is still revoked.':''} Already delivered Telegram messages are not erased.`);
  }
  if (command === '/owner') {
    const [key, target] = argument.split(/\s+/);
    if (key === 'host' || !/^\d+$/.test(target || '')) return tg.send(user, 'Use /owner KEY_ID TELEGRAM_ID for a non-host key.');
    const result = await run(env, `UPDATE access_keys SET owner_id=? WHERE id=? AND active=1 AND
      EXISTS(SELECT 1 FROM members WHERE user_id=? AND key_id=? AND active=1 AND blocked=0)`, Number(target), key, Number(target), key);
    return tg.send(user, result.meta.changes ? 'Mailbox manager changed.' : 'That account must be an active member of that key.');
  }
  if (command === '/resume') {
    await run(env, `UPDATE credentials SET paused=0,failures=0,last_slot=NULL,status='Retry requested' WHERE key_id=?`, argument);
    return tg.send(user, 'Retry requested for the next scheduled check. Verify credentials first if login failed.');
  }
  if (command === '/health' || command === '/lastcheck') return showLastChecks(env,user,tg);
  return false;
}

export async function handleUpdate(env, update, tg) {
  const query=update.callback_query;
  const message=query?{from:query.from,chat:query.message?.chat}:update.message;
  if (!message || message.chat?.type !== 'private' || message.from?.is_bot || message.chat.id !== message.from?.id) return;
  const user = message.from.id;
  if (!await rate(env, `messages:${user}`, 30, 60)) return;
  const pending = await first(env, 'SELECT * FROM states WHERE user_id=? AND expires>?', user, now());
  tg=withMenus(env,tg);
  let callbackCommand;
  if(query) {
    if(typeof query.id!=='string' || typeof query.data!=='string' || query.data.length>64) return;
    if(!await member(env,user)) return tg.call('answerCallbackQuery',{callback_query_id:query.id,text:'Access unavailable. Send /start to join.'});
    if(!query.data.startsWith('menu:')) {
      if(pending) {await tg.call('answerCallbackQuery',{callback_query_id:query.id});return tg.send(user,'Finish the current step, or tap Cancel before choosing another action.');}
      return hostButtons(env,query,tg);
    }
    const action=query.data.slice(5);
    callbackCommand=Object.hasOwn(callbackCommands,action)?callbackCommands[action]:null;
    if(!callbackCommand) return;
    await tg.call('answerCallbackQuery',{callback_query_id:query.id});
  }
  const rawText = typeof message.text === 'string' ? message.text : '';
  const menuCommand=callbackCommand||(Object.hasOwn(menuCommands,rawText)?menuCommands[rawText]:null);
  const text=menuCommand||rawText;
  const command = text.split(/\s+/, 1)[0].split('@')[0];
  const argument = text.includes(' ') ? text.slice(text.indexOf(' ') + 1).trim() : '';
  // Delete credential-bearing input before any business logic or parsing errors.
  if (!query && (pending?.stage === 'password' || /^\d{6,8}$/.test(rawText) || command === '/start' && argument || command === '/host')) {
    if (!await tg.delete(user, message.message_id)) await tg.send(user, 'I could not delete your sensitive message. Please delete it from this chat yourself.');
  }
  if (command === '/cancel') {
    await run(env, 'DELETE FROM states WHERE user_id=?', user);
    return tg.send(user, 'Cancelled. Choose an option using the buttons below.');
  }
  if(command==='/menu') {await run(env,'DELETE FROM states WHERE user_id=?',user);return showMenu(env,user,tg);}
  if(command==='/help') return showHelp(env,user,tg);
  if(menuCommand && pending && !['/cancel','/menu','/help','/pause','/resume_notifications','/stop','/leave_confirm'].includes(command)) return tg.send(user,'Finish the current step, or tap Cancel before choosing another action.');
  if (command === '/start' || command === '/host') {
    await run(env, 'DELETE FROM states WHERE user_id=?', user);
    if(await first(env,'SELECT user_id FROM blacklist WHERE user_id=?',user)) return showHelp(env,user,tg);
    if (argument) return redeem(env, user, (message.from.first_name || 'Account').slice(0, 64), argument, tg);
    const m = await member(env, user);
    if (m) return showMenu(env,user,tg);
    await state(env, user, 'key');
    return tg.send(user, 'Private email bot. Enter the fixed key supplied by the host.');
  }
  if(pending?.stage==='name') return completeName(env,user,text,pending,tg);
  const m = await member(env, user);
  if(pending?.stage==='new_key' && m && isHost(env,user)) {
    await run(env,'DELETE FROM states WHERE user_id=?',user);return admin(env,user,'/new',text.trim(),tg,update.update_id);
  }
  if (!m) {
    if (pending?.stage === 'key' || /^\d{6,8}$/.test(text)) return redeem(env, user, (message.from.first_name || 'Account').slice(0, 64), text, tg);
    return tg.send(user, 'Send /start to enter your access key.');
  }
  if(command==='/pause' || command==='/resume_notifications') {
    await env.DB.batch([stmt(env,'DELETE FROM states WHERE user_id=?',user),
      stmt(env,'UPDATE members SET notifications_paused=? WHERE user_id=?',command==='/pause'?1:0,user)]);
    return tg.send(user,command==='/pause'?
      'Email notifications are paused for your Telegram account. Shared mailbox checks and other accounts continue. Queued notifications wait until you tap Resume notifications. A notification already being sent may still arrive.':
      'Email notifications are on again for your Telegram account. Queued notifications will be delivered on the next scheduled check.');
  }
  if(command==='/stop') return leaveBot(env,user,m,tg);
  if(command==='/leave_confirm' && query && callbackCommand) return leaveBot(env,user,m,tg,true);
  if(pending?.stage==='leave') return tg.send(user,'Tap Confirm leave to disconnect, or tap Cancel to stay connected.');
  if (command === '/commands') return tg.send(user, help + (isHost(env, user) ? adminHelp : ''));
  if (isHost(env, user) && m.key_id === 'host' && command.startsWith('/')) {
    const handled = await admin(env, user, command, argument, tg, update.update_id);
    if (handled !== false) return handled;
  }
  if (command === '/status' || command === '/lastcheck') return showMailbox(env,user,tg);
  if (command === '/email' || command === '/password' || pending?.stage === 'email' || pending?.stage === 'password') {
    if (!canEdit(env, m)) return tg.send(user, 'Only the mailbox manager or host can change credentials for this key.');
    if (command === '/email') return beginEmail(env, user, tg);
    if (command === '/password') {
      const c = await first(env, 'SELECT email_cipher FROM credentials WHERE key_id=?', m.key_id);
      if (!c) return beginEmail(env, user, tg);
      return askPassword(env, user, {email: await unseal(env, `email:${m.key_id}`, c.email_cipher)}, tg);
    }
    if (pending?.stage === 'email') {
      const email = text.trim().toLowerCase();
      if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@rajasthan\.gov\.in$/.test(email) || email.length > 254) return tg.send(user, 'Enter the full @rajasthan.gov.in email address, or /cancel.');
      return askPassword(env, user, {email}, tg);
    }
    if (pending?.stage === 'password') {
      if (!text || text.length > 512) return tg.send(user, 'Password must be 1–512 characters. Send /cancel to stop.');
      const {email} = await unseal(env, `draft:${user}`, pending.draft);
      const old = await first(env, 'SELECT email_cipher,revision FROM credentials WHERE key_id=?', m.key_id);
      const sameMailbox = old && await unseal(env, `email:${m.key_id}`, old.email_cipher) === email;
      const revision = old ? old.revision + (sameMailbox ? 0 : 1) : 1;
      const changes = [stmt(env, `INSERT INTO credentials(key_id,email_cipher,password_cipher,revision) VALUES(?,?,?,?)
        ON CONFLICT(key_id) DO UPDATE SET email_cipher=excluded.email_cipher,password_cipher=excluded.password_cipher,
        last_checked=CASE WHEN revision=excluded.revision THEN last_checked ELSE NULL END,
        revision=excluded.revision,paused=0,failures=0,status='Credentials updated; awaiting check',lease=NULL,lease_until=0,last_slot=NULL,
        last_attempt=NULL,last_finished=NULL,last_result=NULL`,
        m.key_id, await seal(env, `email:${m.key_id}`, email), await seal(env, `password:${m.key_id}`, text), revision),
        stmt(env, 'DELETE FROM states WHERE user_id=?', user),
        stmt(env, 'DELETE FROM push_subscriptions WHERE key_id=?', m.key_id)];
      if (old && !sameMailbox) changes.push(stmt(env, 'DELETE FROM messages WHERE key_id=?', m.key_id));
      await env.DB.batch(changes);
      const recipients = !old || !sameMailbox ? await all(env, 'SELECT user_id FROM members WHERE key_id=? AND active=1 AND blocked=0',m.key_id) : [{user_id:user}];
      let dispatched = false;
      for (const recipient of recipients) dispatched = await queueInitial(env,m.key_id,recipient.user_id,revision) || dispatched;
      return tg.send(user, 'Credentials saved encrypted. Login is not yet verified. ' +
        (dispatched ? 'Your first check has been requested.' : 'Your first check is queued for the next scheduled run.') +
        ' Existing unread emails will be included, and delivered emails will not normally repeat.');
    }
  }
  return showMenu(env,user,tg);
}
