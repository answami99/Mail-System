import {first, now, run} from './common.js';
import {slotAt} from './jobs.js';

// Only start the fixed workflow. No mailbox or recipient data enters the request.
export async function scheduleChecks(controller, env) {
  const time = now();
  if (!Number.isFinite(controller.scheduledTime)) return {skipped:true};
  const slot = slotAt(new Date(controller.scheduledTime));
  // Ignore stale/redelivered events from a previous slot or outside office hours.
  if (!slot || slot !== slotAt(new Date(time * 1000)) || controller.scheduledTime > time * 1000 + 60000)
    return {skipped:true};
  const lease = crypto.randomUUID();
  const claim = await first(env, `INSERT INTO scheduler_ticks(slot,status,attempted_at,lease,lease_until)
    VALUES(?,'dispatching',?,?,?) ON CONFLICT(slot) DO UPDATE SET
    status='dispatching',attempted_at=excluded.attempted_at,finished_at=NULL,http_status=NULL,
    attempts=scheduler_ticks.attempts+1,lease=excluded.lease,lease_until=excluded.lease_until
    WHERE scheduler_ticks.status<>'accepted' AND scheduler_ticks.lease_until<=? RETURNING slot`,
    slot,time,lease,time+90,time);
  if (!claim) return {skipped:true};
  await run(env,'DELETE FROM scheduler_ticks WHERE attempted_at<?',time-7*86400);
  let status = 0;
  if (env.GITHUB_DISPATCH_TOKEN) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch('https://api.github.com/repos/answami99/Mail-System/actions/workflows/poll.yml/dispatches', {
          method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),
          headers:{Authorization:`Bearer ${env.GITHUB_DISPATCH_TOKEN}`,Accept:'application/vnd.github+json',
            'X-GitHub-Api-Version':'2026-03-10','Content-Type':'application/json','User-Agent':'RajasthanMailNotifier'},
          body:JSON.stringify({ref:'main',inputs:{force:false}})
        });
        status = response.status;
      } catch { status = 0; }
      // Retry one transient failure, but never permission errors or rate limits.
      if (status !== 0 && status < 500) break;
    }
  }
  const accepted = status === 200 || status === 204;
  await run(env,`UPDATE scheduler_ticks SET status=?,finished_at=?,http_status=?,lease_until=0 WHERE slot=? AND lease=?`,
    accepted?'accepted':'failed',now(),status,slot,lease);
  // Never include fetch exceptions, response bodies, or the token in diagnostics.
  if (!accepted) throw new Error('Mail-check workflow dispatch failed; see host Last checks');
  return {accepted:true};
}
