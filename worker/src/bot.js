import {all, canEdit, digest, first, isHost, member, now, randomCode, rate, run, seal, stmt, unseal, sameSecret} from './common.js';
import {queueInitial} from './initial.js';
import {callbackCommands, menuCommands, showHelp, showLastChecks, showMailbox, showMenu, withMenus} from './ui.js';

const help = '/status — last check and delivery backlog\n/email — connect or change mailbox\n/password — change password\n/cancel — cancel entry';
const adminHelp = '\n/new Person or organisation — create a named code\n/keys — manage people, keys and accounts using buttons\n/members KEY_ID — accounts\n/remove TELEGRAM_ID — block an account\n/allow TELEGRAM_ID — allow it to join again\n/revoke KEY_ID — revoke key and erase mailbox data\n/owner KEY_ID TELEGRAM_ID — change mailbox manager\n/resume KEY_ID — retry a paused mailbox\n/health — all mailbox status';

async function state(env, user, stage, draft = null) {
  return run(env, `INSERT INTO states VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
    stage=excluded.stage,draft=excluded.draft,expires=excluded.expires`, user, stage, draft, now() + 600);
}
async function beginEmail(env, user, tg) {
  await state(env, user, 'email');
  await tg.send(user, 'Enter your full @rajasthan.gov.in email address. This mailbox is shared with the Telegram accounts enrolled under your key.');
}
async function askPassword(env, user, draft, tg) {
  await state(env, user, 'password', await seal(env, `draft:${user}`, draft));
  await tg.send(user, 'Enter the mailbox password (within 10 minutes), or /cancel. It passes through Telegram cloud chat, which is not end-to-end encrypted. I will attempt to delete your password message and encrypt it in backend storage. The system owner controls the encryption key.');
}
async function afterName(env, user, joined, tg, fresh=true) {
  await tg.send(user, `Thank you, ${joined.label}. You are connected to ${joined.name}.\nUse the buttons below to view your mailbox or update your details.`);
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
    const blocked=await first(env,'SELECT blocked FROM members WHERE user_id=?',user);
    key=await first(env,"SELECT * FROM access_keys WHERE code_hash=? AND active=1 AND id<>'host'",await digest(env,code));
    if(!key || blocked?.blocked || isHost(env,user)) return tg.send(user,'Key not accepted. Contact the host.');
  }
  const existing=await member(env,user);
  if(existing && existing.key_id!==key.id) return tg.send(user,'Already attached to another key. Ask the host to remove that membership first.');
  if(existing) return afterName(env,user,existing,tg,false);
  const limit=Math.max(1,Math.min(20,Number(env.MAX_MEMBERS_PER_KEY||5)));
  if((await first(env,'SELECT COUNT(*) AS n FROM members WHERE key_id=? AND active=1 AND blocked=0',key.id)).n>=limit) return tg.send(user,'This key has reached its account limit. Contact the host.');
  await state(env,user,'name',await seal(env,`draft:${user}`,{key_id:key.id}));
  return tg.send(user,`Welcome to ${key.name}!\nPlease enter your name (1–64 characters). The host can see this name to identify the account using this key and help prevent misuse of the system.\nAfter this, the mailbox manager will be asked for the email address and password. Accounts using this key share its mailbox. Send /cancel to stop.`);
}
async function completeName(env,user,text,pending,tg) {
  const label=text.trim();
  if(!label || label.length>64 || /[\u0000-\u001f\u007f]/.test(label) || label.startsWith('/')) return tg.send(user,'Please enter your name using 1–64 characters, or /cancel.');
  const {key_id}=await unseal(env,`draft:${user}`,pending.draft);
  const key=await first(env,'SELECT * FROM access_keys WHERE id=? AND active=1',key_id);
  const current=await first(env,'SELECT * FROM members WHERE user_id=?',user);
  if(!key || current?.blocked || (key_id==='host')!==isHost(env,user) || current?.active && current.key_id!==key_id) {
    await run(env,'DELETE FROM states WHERE user_id=?',user);return tg.send(user,'This invitation is no longer available. Contact the host.');
  }
  const limit=Math.max(1,Math.min(20,Number(env.MAX_MEMBERS_PER_KEY||5)));
  await env.DB.batch([
    stmt(env,`INSERT INTO members(user_id,key_id,label,joined_at) SELECT ?,?,?,?
      WHERE (SELECT COUNT(*) FROM members WHERE key_id=? AND active=1 AND blocked=0)<?
      ON CONFLICT(user_id) DO UPDATE SET key_id=excluded.key_id,label=excluded.label,active=1 WHERE members.blocked=0`,user,key_id,label,now(),key_id,limit),
    stmt(env,`UPDATE access_keys SET owner_id=? WHERE id=? AND owner_id IS NULL AND
      EXISTS(SELECT 1 FROM members WHERE user_id=? AND key_id=? AND active=1 AND blocked=0)`,user,key_id,user,key_id),
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
  if(typeof keyId!=='string' || !/^(host|key-\d+)$/.test(keyId)) return;
  const key=await first(env,'SELECT * FROM access_keys WHERE id=? AND active=1',keyId);
  if(!key) return tg.send(user,'This key is no longer active. Open /keys again.');
  if(action==='check') return showMailbox(env,user,tg,keyId);
  if(action==='resume') {await admin(env,user,'/resume',keyId,tg,0);return showMailbox(env,user,tg,keyId);}
  if(action==='members') {
    const rows=await all(env,'SELECT user_id,label,active,blocked FROM members WHERE key_id=? ORDER BY joined_at,user_id',keyId);
    const text=`${key.name}\nKey: ${keyId==='host'?'your private host key':await unseal(env,`key:${keyId}`,key.code_cipher)}\nTelegram accounts: ${rows.filter(r=>r.active&&!r.blocked).length}\n`+
      (rows.map((r,i)=>`${i+1}. ${r.label} — ${r.blocked?'blocked':r.active?'active':'inactive'}`).join('\n')||'No accounts have joined yet.');
    const buttons=rows.filter(r=>String(r.user_id)!==env.HOST_TELEGRAM_ID).map(r=>[{text:`${r.blocked?'Allow':'Remove'} ${r.label}`.slice(0,64),callback_data:`${r.blocked?'allow':'remove'}:${keyId}:${r.user_id}`}]);
    for(const r of rows.filter(r=>r.active&&!r.blocked&&r.user_id!==key.owner_id&&keyId!=='host'))
      buttons.push([{text:`Make manager: ${r.label}`.slice(0,64),callback_data:`manager:${keyId}:${r.user_id}`}]);
    buttons.push([{text:'Last check',callback_data:`check:${keyId}`},{text:'All access codes',callback_data:'menu:keys'}]);
    if(keyId!=='host') buttons.push([{text:`Revoke ${key.name}`.slice(0,64),callback_data:`revoke:${keyId}`}]);
    return tg.send(user,text,{inline_keyboard:buttons});
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
    let code;
    do { code = randomCode(); } while (code === env.HOST_ACCESS_KEY || await first(env, 'SELECT id FROM access_keys WHERE code_hash=?', await digest(env, code)));
    await run(env, 'INSERT INTO access_keys VALUES(?,?,?,?,NULL,1,?)', id, argument, await digest(env, code), await seal(env, `key:${id}`, code), now());
    return tg.send(user, `Name: ${argument}\nKey: ${code}\nNo expiry. Share privately with this person or organisation. They will be welcomed by this name, then asked for their own name to help prevent misuse. The first person to finish joining becomes the mailbox manager.`);
  }
  if (command === '/keys') {
    const rows = await all(env, `SELECT k.*, (SELECT COUNT(*) FROM members m WHERE m.key_id=k.id AND m.active=1 AND m.blocked=0) AS n FROM access_keys k WHERE active=1`);
    const texts = [];
    for (const k of rows) texts.push(`${k.name}\nKey: ${await unseal(env, `key:${k.id}`, k.code_cipher)}\nTelegram accounts: ${k.n}`);
    return tg.send(user, texts.join('\n\n') || 'No keys.', {inline_keyboard:rows.map(k=>[{text:`Manage ${k.name}`.slice(0,64),callback_data:`members:${k.id}`}])});
  }
  if (command === '/members') {
    const rows = await all(env, 'SELECT user_id,label,active,blocked FROM members WHERE key_id=?', argument);
    return tg.send(user, rows.map(m => `${m.label}: ${m.user_id} — ${m.blocked ? 'blocked' : m.active ? 'active' : 'inactive'}`).join('\n') || 'No accounts for that key ID.');
  }
  if (command === '/remove' || command === '/allow') {
    if (!/^\d+$/.test(argument) || isHost(env, argument)) return tg.send(user, 'Use a non-host Telegram numeric ID.');
    const id = Number(argument);
    await env.DB.batch([
      stmt(env, 'UPDATE members SET active=0,blocked=? WHERE user_id=?', command === '/remove' ? 1 : 0, id),
      stmt(env, 'DELETE FROM states WHERE user_id=?', id),
      stmt(env, 'DELETE FROM deliveries WHERE user_id=? AND state<>\'sent\'', id)
    ]);
    return tg.send(user, command === '/remove' ? 'Account blocked. Its key cannot be reused by this account unless you /allow it. An already in-flight notification may still arrive.' : 'Account unblocked; it must enter its key again.');
  }
  if (command === '/revoke') {
    if (argument === 'host') return tg.send(user, 'Host key cannot be revoked here. Rotate it in Cloudflare secrets.');
    await env.DB.batch([
      stmt(env, 'UPDATE access_keys SET active=0,code_cipher=\'\' WHERE id=?', argument),
      stmt(env, 'DELETE FROM states WHERE user_id IN (SELECT user_id FROM members WHERE key_id=?)', argument),
      stmt(env, 'UPDATE members SET active=0 WHERE key_id=?', argument),
      stmt(env, 'DELETE FROM credentials WHERE key_id=?', argument),
      stmt(env, 'DELETE FROM push_subscriptions WHERE key_id=?', argument),
      stmt(env, 'DELETE FROM messages WHERE key_id=?', argument)
    ]);
    return tg.send(user, 'Key revoked; credentials and queued mail removed. Already delivered Telegram messages are not erased.');
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
  if(menuCommand && pending && !['/cancel','/menu','/help'].includes(command)) return tg.send(user,'Finish the current step, or tap Cancel before choosing another action.');
  if (command === '/start' || command === '/host') {
    await run(env, 'DELETE FROM states WHERE user_id=?', user);
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
