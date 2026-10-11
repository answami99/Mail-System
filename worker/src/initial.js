import {first, now, run} from './common.js';

export async function queueInitial(env, key, user, revision) {
  let request = await first(env, `SELECT id,requested_at FROM initial_checks
    WHERE key_id=? AND user_id=? AND revision=? AND state='pending' LIMIT 1`, key, user, revision);
  if (!request) {
    request = {id:crypto.randomUUID(),requested_at:0};
    await run(env, 'INSERT INTO initial_checks(id,key_id,revision,user_id,created_at) VALUES(?,?,?,?,?)',
      request.id, key, revision, user, now());
  }
  if (!env.GITHUB_DISPATCH_TOKEN) return false;
  if (request.requested_at > now() - 300) return true;
  try {
    // No account identifiers or credentials are sent to the workflow dispatch endpoint.
    const response = await fetch('https://api.github.com/repos/answami99/Mail-System/actions/workflows/initial.yml/dispatches', {
      method:'POST', redirect:'manual', signal:AbortSignal.timeout(10000),
      headers:{Authorization:`Bearer ${env.GITHUB_DISPATCH_TOKEN}`, Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2026-03-10', 'Content-Type':'application/json', 'User-Agent':'RajasthanMailNotifier'},
      body:JSON.stringify({ref:'main'})
    });
    if (![200,204].includes(response.status)) return false;
    await run(env, 'UPDATE initial_checks SET requested_at=? WHERE id=?', now(), request.id);
    return true;
  } catch { return false; }
}
