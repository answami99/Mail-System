import {all, canEdit, first, isHost, member, now} from './common.js';

export const scheduleText = 'Every 10 minutes · Daily, 09:30–18:00 IST';
export const menuCommands = {
  '📬 My mailbox':'/status', '🕒 Last check':'/lastcheck', '🕒 Last checks':'/lastcheck',
  '👥 Manage access':'/keys', '➕ Create code':'/new',
  '⛔ Blocked accounts':'/blocked',
  '✉️ Change email':'/email', '🔐 Change password':'/password',
  '⏸ Pause notifications':'/pause', '▶️ Resume notifications':'/resume_notifications', '🚪 Leave bot':'/stop',
  '❓ Help':'/help', '🏠 Main menu':'/menu', '❌ Cancel':'/cancel', '🔑 Enter access code':'/start'
};
export const callbackCommands = {home:'/menu',status:'/status',lastcheck:'/lastcheck',leave_confirm:'/leave_confirm',
  keys:'/keys',new:'/new',email:'/email',password:'/password',help:'/help',cancel:'/cancel'};
const dateFormat = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'});
export const istTime = value => value ? `${dateFormat.format(new Date(value*1000))} IST` : 'Not recorded yet';

export async function membersWithNotificationCounts(env,keyId) {
  // Only confirmed email deliveries for this person's current key; bot replies never enter deliveries.
  return all(env,`SELECT m.user_id,m.label,m.active,m.blocked,m.notifications_paused,b.user_id AS blacklisted,
    (SELECT COUNT(*) FROM deliveries d JOIN messages msg ON msg.id=d.message_id
      WHERE d.user_id=m.user_id AND msg.key_id=m.key_id AND d.state='sent') AS notifications_sent
    FROM members m LEFT JOIN blacklist b ON b.user_id=m.user_id
    WHERE m.key_id=? ORDER BY m.joined_at,m.user_id`,keyId);
}

export async function keyboardFor(env,user) {
  const pending=await first(env,'SELECT stage FROM states WHERE user_id=? AND expires>?',user,now());
  if(pending) return {keyboard:[['❌ Cancel']],resize_keyboard:true,is_persistent:true,
    input_field_placeholder:pending.stage==='password'?'Enter password privately':pending.stage==='email'?'Enter your full email address':pending.stage==='name'?'Enter your name':pending.stage==='new_key'?'Person or organisation name':pending.stage==='leave'?'Confirm leave above, or Cancel':'Enter your access code'};
  const m=await member(env,user);
  const blocked=!m && !!await first(env,'SELECT user_id FROM blacklist WHERE user_id=?',user);
  const notificationButton=m?.notifications_paused?'▶️ Resume notifications':'⏸ Pause notifications';
  const keyboard=!m?(blocked?[['❓ Help']]:[['🔑 Enter access code'],['❓ Help']]):isHost(env,user)?
    [['🕒 Last checks','👥 Manage access'],['➕ Create code','📬 My mailbox'],['✉️ Change email','🔐 Change password'],[notificationButton,'⛔ Blocked accounts'],['❓ Help']]:
    [['📬 My mailbox','🕒 Last check'],...(canEdit(env,m)?[['✉️ Change email','🔐 Change password']]:[]),[notificationButton,'🚪 Leave bot'],['❓ Help']];
  return {keyboard,resize_keyboard:true,is_persistent:true,input_field_placeholder:m?'Choose an option below':'Enter the private access code from your host'};
}

// Attach the correct keyboard at send time, including after enrollment or cancellation.
export function withMenus(env,tg) {
  return {call:(...args)=>tg.call(...args),delete:(...args)=>tg.delete(...args),email:(...args)=>tg.email(...args),
    send:async(user,text,markup)=>tg.send(user,text,markup===undefined?await keyboardFor(env,user):markup)};
}
export async function showMenu(env,user,tg) {
  const m=await member(env,user);
  if(!m && await first(env,'SELECT user_id FROM blacklist WHERE user_id=?',user)) return showHelp(env,user,tg);
  if(!m) return tg.send(user,'Welcome to Rajasthan Mail. Tap Enter access code to join using the private code supplied by your host.');
  return tg.send(user,`Hello, ${m.label}!\n${isHost(env,user)?'Host dashboard':'Your mailbox: '+m.name}\nNotifications: ${m.notifications_paused?'paused for your Telegram account':'on'}\n\n${scheduleText}\nChoose an option using the buttons below.`,await keyboardFor(env,user));
}
export async function showHelp(env,user,tg) {
  const m=await member(env,user);
  if(!m && await first(env,'SELECT user_id FROM blacklist WHERE user_id=?',user)) return tg.send(user,'Access revoked. This Telegram account is blacklisted by the host and cannot join with any code. Contact the host to request removal from the blocked list.');
  if(!m && await first(env,'SELECT user_id FROM key_blocks WHERE user_id=?',user)) return tg.send(user,'Access revoked for your previous code. Ask the host to allow it again or give you a different code. Your account is not blacklisted.');
  if(!m) return tg.send(user,'This is a private notification bot. Ask your host for an access code, then tap Enter access code. Your name is requested to identify your account and help prevent misuse.');
  return tg.send(user,`How to use Rajasthan Mail\n\n${isHost(env,user)?
    '➕ Create code — enter a person or organisation name.\n👥 Manage access — view accounts and notification counts, change the manager, allow/remove access, permanently delete users or organisations, or blacklist an account.\n⛔ Blocked accounts — see the blacklist and unblock accounts.\n🕒 Last checks — see whether each mailbox check succeeded.\n':
    '📬 My mailbox — see your connection and notification status.\n🕒 Last check — see the latest check result.\n'}${canEdit(env,m)?'✉️ Change email / 🔐 Change password — follow the private prompts.\n':''}⏸ Pause / ▶️ Resume notifications — stop delivery to your Telegram account temporarily. Queued notifications wait until you resume; shared mailbox checks continue.\n${isHost(env,user)?'':'🚪 Leave bot — disconnect your account after confirmation. You can rejoin later with an active access code.\n'}\n${scheduleText}\nEach notification contains sender, subject and received time. Emails stay unread. Already read or moved emails are excluded.\n\nCloudflare requests checks; GitHub runner delays are still possible. New accounts get a first check after connection. Use Cancel while entering details to stop. Commands remain available with /commands.`);
}
export function checkOutcome(c) {
  if(!c?.status) return '⚪ Mailbox not connected';
  if(c.last_result==='running') return c.lease_until>now()?'🔄 Check in progress':'⚠️ Check interrupted or timed out';
  const labels={success:'✅ Successful',auth:'❌ Login or access failed',network:'⚠️ Mail server unavailable',
    protocol:'❌ Mail API check failed',partial:'⚠️ Incomplete check; remaining mail will be retried'};
  return (labels[c.last_result] || `⏳ ${c.status}`)+(c.paused?' · Paused':'');
}
export function overdue(c,date=new Date()) {
  const local=new Date(date.getTime()+330*60000),minute=local.getUTCHours()*60+local.getUTCMinutes();
  return minute>=590 && minute<=1080 &&
    !!c?.status && (!c.last_attempt || c.last_attempt<Math.floor(date.getTime()/1000)-1200);
}
const checkFields='c.status,c.paused,c.last_checked,c.last_attempt,c.last_finished,c.last_result,c.lease_until';
export async function showMailbox(env,user,tg,keyId=null) {
  const m=await member(env,user);
  if(!m || keyId && !isHost(env,user)) return;
  const key=keyId||m.key_id;
  const c=await first(env,`SELECT k.name,${checkFields} FROM access_keys k LEFT JOIN credentials c ON c.key_id=k.id WHERE k.id=? AND k.active=1`,key);
  if(!c) return tg.send(user,'This mailbox is no longer available. Open the main menu again.');
  const pending=await first(env,`SELECT COUNT(*) AS n FROM deliveries d JOIN messages msg ON msg.id=d.message_id
    JOIN members m ON m.user_id=d.user_id AND m.key_id=msg.key_id
    WHERE msg.key_id=? AND d.state<>'sent' AND m.active=1 AND m.blocked=0 AND (?=1 OR d.user_id=?)`,key,Number(!!keyId),user);
  const sent=keyId?null:await first(env,`SELECT COUNT(*) AS n FROM deliveries d JOIN messages msg ON msg.id=d.message_id
    WHERE msg.key_id=? AND d.user_id=? AND d.state='sent'`,key,user);
  const buttons=[[{text:'Refresh',callback_data:keyId?`check:${key}`:'menu:status'},{text:'Main menu',callback_data:'menu:home'}]];
  if(keyId && c.paused) buttons.unshift([{text:'Resume checks',callback_data:`resume:${key}`}]);
  return tg.send(user,`${c.name}\n${checkOutcome(c)}${keyId?'':`\nNotifications: ${m.notifications_paused?'paused for your Telegram account':'on'}`}\n\nLast attempt: ${istTime(c.last_attempt)}\nFinished: ${istTime(c.last_finished)}\nLast successful check: ${istTime(c.last_checked)}${sent?`\nEmail notifications sent to you: ${sent.n} (saved history)`:''}\nPending notifications: ${pending.n}${overdue(c)?'\n\n⚠️ No check reported in the last 20 minutes during office hours. Checks may be delayed.':''}\n\n${scheduleText}\nSuccess means the inbox scan completed; pending notifications are delivered separately.`,{inline_keyboard:buttons});
}
export async function showLastChecks(env,user,tg) {
  const m=await member(env,user);
  if(!m) return;
  if(!isHost(env,user)) return showMailbox(env,user,tg);
  const rows=await all(env,`SELECT k.id,k.name,${checkFields} FROM access_keys k LEFT JOIN credentials c ON c.key_id=k.id WHERE k.active=1 ORDER BY k.created_at,k.id`);
  const buttons={inline_keyboard:[...rows.map(r=>[{text:`${r.name} — details`.slice(0,64),callback_data:`check:${r.id}`}]),
    [{text:'Refresh results',callback_data:'menu:lastcheck'},{text:'Main menu',callback_data:'menu:home'}],
    [{text:'Open workflow runs',url:'https://github.com/answami99/Mail-System/actions/workflows/poll.yml'}]]};
  const tick=await first(env,'SELECT status,attempted_at,finished_at,http_status FROM scheduler_ticks ORDER BY attempted_at DESC LIMIT 1');
  const trigger=!tick?'Awaiting first automatic trigger':tick.status==='accepted'?'GitHub accepted the check request':
    tick.status==='dispatching' && tick.attempted_at>now()-90?'Request in progress':tick.status==='dispatching'?'Request interrupted':
    `Request failed${tick.http_status?' (HTTP '+tick.http_status+')':''}`;
  let text=`Last mailbox checks\n${scheduleText}\n\nCloudflare trigger: ${trigger}\nTrigger time: ${istTime(tick?.attempted_at)}\nA request being accepted does not mean the inbox check has finished.\n\n`;
  for(const r of rows) {
    const line=`${r.name}\n${checkOutcome(r)}\nLast attempt: ${istTime(r.last_attempt)}\nLast success: ${istTime(r.last_checked)}${overdue(r)?'\n⚠️ Overdue: no recent check reported.':''}\n\n`;
    if(text.length+line.length>3500) {await tg.send(user,text);text='';} text+=line;
  }
  return tg.send(user,text+'Tap a mailbox for details. Success refers to the inbox scan; pending notifications are shown in its details.',buttons);
}
