# Deployment and first live test

The source is ready for review and local tests. It is **not a deployed working service yet**. You need a Telegram bot token, your numeric Telegram user ID, a Cloudflare account with Workers/D1, and a GitHub repository. Never paste these secrets into a chat, commit, issue, workflow file, or command-line argument.

## 1. Verify Exchange access before inviting anyone

Use a trusted local terminal in this directory:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r poller/requirements.txt
.venv/bin/python -m poller.run --probe
```

The probe prompts for your email and password (password hidden). It contacts only the configured Rajasthan EWS endpoint, counts unread Inbox messages, and does not send anything to Telegram. The current endpoint is `https://mail.rajasthan.gov.in/EWS/Exchange.asmx`; this is the standard candidate, **not an endpoint confirmed available for your mailbox**. NTLM is the default authentication method. If your administrator specifies Basic authentication over HTTPS, set `EWS_AUTH_TYPE=BASIC` locally and as a GitHub repository variable. Do not repeatedly guess settings or disable certificate verification.

If the probe fails, stop deployment of mailbox polling and establish the supported endpoint/authentication with the mail administrator. Web login and Exchange API login are different paths. The implementation does not yet automate the OWA website. Local dependency installation was blocked by network/DNS restrictions in the build environment, so neither an installed-library integration test nor a live mailbox test was completed there.

## 2. Create and configure your Telegram bot

Create the bot with the official **@BotFather** inside Telegram. Keep the token private. Disable allowing the bot to join groups; the application also ignores non-private chats. Obtain your own numeric Telegram user ID and put it in `worker/wrangler.toml` as `HOST_TELEGRAM_ID`. Do not use a username as an authorization identifier.

Create the local secrets file:

```sh
python3 scripts/make_secrets.py
```

This securely prompts for the bot token and a fixed 6–8-digit host code. Blank generates an 8-digit host code. It writes `secrets.local.json` with owner-only permissions and refuses to overwrite an existing file. Inspect that file privately to obtain your generated host code and runner token. Store a secure backup: losing `ENCRYPTION_KEY` makes saved credentials unreadable, and changing `KEY_PEPPER` breaks key lookup.

## 3. Provision Cloudflare

Use Node 24+ and Cloudflare's official Wrangler CLI. The commands below intentionally require your Cloudflare login. They create only the named Worker/database; do not target an unrelated existing deployment.

```sh
cd worker
npx wrangler login
npx wrangler d1 create private-email-bot
```

Copy the returned database ID into `worker/wrangler.toml`. The database ID and your Telegram numeric ID are configuration, not passwords. Leave the secret values out of the TOML file.

```sh
npx wrangler d1 migrations apply private-email-bot --remote
npx wrangler secret bulk ../secrets.local.json
npx wrangler deploy
```

The six secret names are `TELEGRAM_BOT_TOKEN`, `HOST_ACCESS_KEY`, `ENCRYPTION_KEY`, `KEY_PEPPER`, `RUNNER_TOKEN`, and `WEBHOOK_SECRET`. Uploading the local secrets file sends those values to your Cloudflare account. The Worker's public URL is the bot backend origin. Its `/healthz` route reports only whether the service responds; it does not prove polling is healthy.

Keep the project on **Workers Free** initially. The configuration has no paid plan requirement. Watch CPU-limit errors and D1 usage during the first live checks; 10 ms CPU is a real free-plan limit, not a guarantee that this application always fits it. Small per-email API calls keep processing bounded.

From the repository root, register the webhook:

```sh
python3 scripts/register_webhook.py
```

It prompts for the Worker origin, bot token and webhook secret, then registers `/telegram` and verifies it using Telegram's API. This changes where that bot's incoming messages are delivered. It sets one webhook connection to serialize conversations and retains pending updates. Do not register it on a bot still used by another application.

## 4. Configure GitHub

Put **the contents of this `email-bot` directory at the repository root**, including `.github/workflows`. Keep the repository private unless you deliberately want the code public. Neither privacy setting makes Actions an unlimited scheduler; do not make it public just to evade limits.

Set these repository Actions secrets through GitHub's secret settings:

| Secret | Value |
|---|---|
| `BOT_BACKEND_URL` | Deployed Worker origin, such as `https://private-email-bot.YOUR-SUBDOMAIN.workers.dev` (no trailing path) |
| `BOT_RUNNER_TOKEN` | The same value as Cloudflare's `RUNNER_TOKEN` |

No mailbox password or Telegram bot token belongs in GitHub secrets: those stay in Cloudflare, although the runner temporarily retrieves each mailbox credential while polling. Grant repository access only to people trusted to change code that runs with the runner secret. The poller workflow does not execute for pull requests.

Ensure Actions are enabled and the workflow is on the default branch. Both workflows grant only `contents: read`; the poller has a concurrency lock and a 15-minute timeout. Enable GitHub's failed-workflow notifications. Inspect the Actions usage/budget settings so exceeding free minutes does not silently become an unexpected paid service.

## 5. Enroll and test the host mailbox

For automatic first checks, apply `worker/migrations/0002_initial_checks.sql` before deploying the new Worker. Create a fine-grained GitHub token limited to **answami99/Mail-System**, with **Actions: Read and write** (and the mandatory Metadata read permission). Add it only to Cloudflare as encrypted secret `GITHUB_DISPATCH_TOKEN`. It lets the backend request the fixed `First connection check` workflow on `main`; no mailbox/account identifiers are sent in the dispatch request. No Contents write permission is needed. Rotate the token before its chosen expiry. Until this secret is configured, first checks wait for a scheduled run.

Each newly enrolled Telegram account gets an initial unread-mail check once mailbox credentials exist, even outside the regular work window. Multiple devices using one Telegram account are one recipient. Initial checks deliver only to the joining account; regular checks serve all enrolled recipients. The durable queue is also covered by regular checks if a dispatch fails or GitHub replaces a pending run. Manually running **First connection check** drains this initial queue without checking unrelated accounts.

In a private bot chat:

```text
/start
<your fixed host code>
<your Rajasthan email address>
<your mailbox password>
```

The password step explicitly explains Telegram cloud-chat exposure and attempts to delete your password message. Credentials are saved encrypted, not yet asserted valid. The backend host controls their encryption key.

In GitHub Actions, choose **Check email inboxes → Run workflow**. Select `force` only when you intend to run outside the weekday work window (for example, Saturday setup). A forced run checks and delivers immediately; otherwise the runner skips outside that window.

Acceptance checks before inviting other people:

1. Existing unread Inbox messages produce separate notifications with sender, subject and IST time, with no email body.
2. Compare unread count/status in OWA before and after; the bot should not mark them read.
3. Run again: already delivered email IDs should not repeat.
4. Send a new test email, run again, and confirm one new notification.
5. `/status` shows a recent successful check. `/health` shows host mailbox status.
6. Inspect GitHub duration/billing and Cloudflare CPU/D1 usage. Allow at least one actual scheduled run to validate the scheduler rather than relying only on a manual run.

## 6. Invite and manage users

| Command | Host action |
|---|---|
| `/new Aditya` | Generate a non-expiring named 8-digit key. Share it privately. |
| `/keys` | Show active keys, codes, IDs and active Telegram-account counts. |
| `/members key-12345` | Show accounts enrolled with this key ID. |
| `/remove 123456789` | Disable and block that Telegram account; it cannot simply redeem the key again. |
| `/allow 123456789` | Unblock it; it must enter its key again. |
| `/revoke key-12345` | Disable the key and erase its credentials and queued notifications. |
| `/owner key-12345 123456789` | Give mailbox-management rights to an active member of that key. |
| `/resume key-12345` | Resume checking after resolving a paused mailbox's access problem. |
| `/health` | Show all connected mailbox states and last successful checks. |

Each user uses `/start`, enters their code, then follows the email/password prompts. First redeemer becomes mailbox manager. Later redeemers share the same mailbox; they do not replace its credentials. The manager uses `/email` to change both email/password or `/password` to change only the password. `/cancel` cancels pending entry. Credential-entry prompts expire after 10 minutes; the invitation code itself does not expire.

Default capacity is ten active keys including Host, with up to five Telegram accounts per key. Adjust `MAX_KEYS` and `MAX_MEMBERS_PER_KEY` only after measuring free-tier usage. Device count cannot be obtained from Telegram's Bot API.

## Recovery and operational notes

- Authentication or API incompatibility after three checks pauses that mailbox and attempts a host/manager alert. Fix credentials or API access before resuming; repeated wrong passwords may trigger the government's own lockout policy.
- Failed sends remain queued and retry on later GitHub runs. A blocked bot deactivates that Telegram membership; the person must unblock the bot and `/start` again.
- At most one GitHub poll workflow runs at a time. A killed worker lease expires after 15 minutes. Telegram delivery leases expire after two minutes.
- Keep the D1 database and `ENCRYPTION_KEY`/`KEY_PEPPER` securely backed up. Do not export credentials into the repository. Deletion does not necessarily erase provider backups instantly.
- Changing a password preserves delivery history; changing the mailbox address increments its version and removes old queued notifications so they cannot be sent as the new mailbox's mail.
- To stop all processing, disable the GitHub poll workflow and remove the Telegram webhook through your own bot administration. Key revocation is available for individual mailbox shutdown.
- A Telegram timeout can leave an uncertain send outcome. Retrying may duplicate that notification; this is not an exactly-once system.
- If GitHub schedules become too unreliable or the free allocation is insufficient, the same poller can run from an always-on trusted machine. Its backend/API boundary is independent of GitHub.

## Dashboard installation shortcut

When the Telegram token and other secrets are already stored in Cloudflare, deploy the current Worker code, set the two GitHub Actions secrets, and run **Connect Telegram bot** manually from Actions. The runner-authenticated `/internal/setup` route validates encryption, database access and the expected bot username before registering the fixed production callback URL. It refuses to replace an existing different webhook and never returns the bot token. This installation is bound to `RajasthanMail_bot` at `https://private-email-bot.answami99.workers.dev`. The connection workflow does not read any mailbox or send notification messages.
