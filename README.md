# Mail-System — Rajasthan Mail Bot

Repository: [answami99/Mail-System](https://github.com/answami99/Mail-System) · Telegram: [@RajasthanMail_bot](https://t.me/RajasthanMail_bot)

Implementation for a closed Telegram bot with GitHub Actions polling and a Cloudflare Worker + D1 backend. **Backend deployed, host enrolled, and live notification delivery verified on 11 October 2026.** Correcting the saved password resolved the Exchange login failure. The live test delivered three notifications, preserved all three unread emails, and sent zero duplicates on a repeat scan. Telegram webhook and automatic first-check dispatch are also verified. An actual scheduled run and sustained free-tier usage still need observation.

## What a notification looks like

```text
From: sender@example.org
Subject: Meeting notice
Received: 12 Oct 2026, 09:30 AM IST
```

One notification per email per enrolled Telegram account. The body and attachments are not requested, stored or sent. The bot does not change the email's read/unread status. A missing subject is shown as `(no subject)`; exceptionally long subjects are shortened with an ellipsis to keep one Telegram message.

## Behavior

- Host creates a named, random **8-digit fixed code** using `/new Name`. Codes have no expiry.
- Host access also requires a fixed code, but only the configured numeric Telegram account can use it.
- Multiple Telegram accounts may enroll under one key; they **share that key's mailbox**. One Telegram account used on several devices is one membership and receives one notification synced by Telegram.
- First person to redeem a key becomes its mailbox manager. Only that manager (or the host for its own mailbox) can change its email/password. The host can transfer management with `/owner`.
- The host has a separate mailbox under its own key, with the same enrollment flow.
- Initial checks include all existing unread Inbox mail. Each later check finds unread mail and skips durable delivery records. An email read or moved out of Inbox before a poll will not be picked up.
- Real-time delivery operates **24 hours, every day**, as requested. EWS Inbox `NewMailEvent` callbacks trigger a GitHub workflow through Cloudflare. Recovery checks run twice an hour at UTC minutes 7 and 37, including weekends; these also renew subscriptions when heartbeats stop. GitHub startup and scheduling delays still apply.
- New Telegram accounts get a separate first check after their mailbox is ready, including outside work hours. This check delivers only to the joining account. `GITHUB_DISPATCH_TOKEN` enables immediate workflow requests; GitHub startup can still be delayed. Without it, enrollment stays queued until a regular check. Repeating `/start` on an enrolled account does not request another check.
- D1 stores encrypted credentials and queued notification metadata, plus delivery receipts. GitHub runners are temporary and do not store state in commits, caches or artifacts.
- Retries retain queued notifications even if an email later becomes read. Completed delivery records normally prevent repeats. A new Telegram account receives the unread backlog at the next check.
- Authentication/API failures pause the affected mailbox after three checks. Network errors retry next scheduled run. `/status` and host `/health` show failures and last successful check.
- Revoking a key removes its credentials and queued metadata. Removing a user blocks re-enrollment until the host allows it. Already sent Telegram messages cannot be retracted by revocation; an in-flight send may complete.

## Hosting choice and limits

GitHub Actions fetches notification metadata after a new-mail callback and performs scheduled recovery checks. Cloudflare's small HTTPS webhook handles bot replies immediately, and D1 holds persistent state. GitHub alone is not an always-on webhook host or a durable application database.

This targets free allowances, **not unlimited hosting or guaranteed delivery times**:

| Service | Published allowance or constraint | Consequence |
|---|---|---|
| GitHub Free, private repository | 2,000 Actions minutes/month | 24/7 recovery alone is about 1,440 runs in a 30-day month, plus new-mail event jobs. A private repository could exceed free minutes. This repository is public; standard hosted runners have different billing. Measure usage and keep secrets out of code. |
| GitHub schedules | Runs may be delayed or dropped; public-repo schedules disable after 60 inactive days | No exact 30-minute reliability guarantee. Inspect Actions and `/health`. |
| Cloudflare Workers Free | 100,000 requests/day, 10 ms CPU per invocation | Small requests, per-message ingestion/delivery, no browser automation. Real deployment/load testing required; local tests do not measure Cloudflare CPU quotas. |
| D1 Free | 5M rows read/day, 100k written/day, 5 GB total | Ten small mailboxes are a reasonable starting target, but backlog volume and retained delivery records determine usage. |
| Telegram | Rate limits and finite message length | Runner paces delivery at roughly one message/second; 429 responses are deferred. Large backlogs may take several checks. |

Sources checked 10 October 2026: [GitHub billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [schedule limits](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [Telegram limits](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this).

## Security boundaries

This is not a guarantee that passwords can never leak. Passwords entered in bot chat pass through **Telegram cloud chats**, which are not end-to-end encrypted. The bot attempts to delete key/password messages and warns if deletion fails; deletion is not proof that no provider copy exists. Use this flow only with that understanding. Never send passwords into this Codex chat.

Passwords and email addresses are encrypted using AES-256-GCM in D1. Lookup codes are HMACed with a secret pepper; a separate encrypted copy allows the host to list codes. An 8-digit reusable code is a convenience credential, not strong authentication: guessing is rate limited, and host privileges are tied to a Telegram ID. A leaked key can still admit someone until it is revoked or its member limit is reached. Use a different key per person/mailbox.

The host controls the backend and encryption key and can technically decrypt credentials. Cloudflare processes credentials; GitHub's runner receives them temporarily to authenticate to the Rajasthan Exchange endpoint. Telegram receives credentials during enrollment and notification metadata during delivery. Other enrolled users cannot query another key's credentials or messages through bot commands.

No password viewing command, mailbox contents endpoint for users, or body collection exists. Exceptions and HTTP responses are not printed to logs. TLS verification stays enabled. No cookies or OWA sessions are persisted. The runner uses the account's own Exchange permissions, not administrator impersonation.

## Known practical limits

- **Live EWS access is verified for the host mailbox.** First-check run [38123247084](https://github.com/answami99/Mail-System/actions/runs/38123247084) authenticated using NTLM and completed one unread-inbox scan with no errors. Earlier authentication failures resulted from an incorrect saved password. Other mailboxes still need their own successful check. This implementation uses EWS and has no OWA-browser fallback.
- **Live delivery and repeat prevention passed.** [Poll run 38123430666, attempt 1](https://github.com/answami99/Mail-System/actions/runs/38123430666/attempts/1) found and delivered three unread emails. OWA still showed three unread emails afterward, and the host confirmed the sender/subject/timestamp notifications contained no body. Attempt 2 queued and delivered zero messages while those emails remained unread. These checks validate this mailbox and sample; they do not establish exactly-once delivery under all failures.
- An EWS read-only API request leaves unread flags unchanged; the full mailbox password itself is not a read-only credential.
- Exactly-once delivery cannot be guaranteed across Telegram and D1. If Telegram accepts a send but the response/receipt write is lost, a retry can produce a duplicate. The implementation favors retry over silent loss.
- Revoking data on the host cannot delete copies already received on users' devices. `protect_content` discourages forwarding/saving but cannot stop every form of copying.
- Unread scans are bounded by run time; large mailboxes may require several runs. GitHub jobs have a 15-minute cap and a 12-minute work budget. EWS IDs can change when messages move; a message moved back into Inbox may notify again.
- Callback delivery is event-driven, but GitHub runner startup means it is not guaranteed to arrive within seconds. Multiple events may be batched. A missed callback is recovered by the next successful scheduled check if the email remains unread. Reading or moving mail before the event job scans it can suppress its notification, matching the unread-only behavior.
- `/health` and GitHub failure notifications help detect errors; there is no independent external uptime watchdog in this version. If the scheduler itself stops, the bot does not automatically repair it.

See [SETUP.md](SETUP.md) for deployment and acceptance checks.

## Production push callbacks

The runner subscribes only to Inbox `NewMailEvent`, with one-minute idle heartbeats. Exchange calls the existing Cloudflare Worker directly. The callback URL contains a random 256-bit token limited to that mailbox subscription; only its HMAC is stored. Confirmed subscription and Inbox IDs are matched by HMAC, XML is size/depth bounded, and DTD/entity declarations are rejected. Callback tokens and subscription IDs must not be copied into logs or screenshots.

New events are recorded durably before the fixed `push.yml` workflow is requested. Dispatches are batched to at most one per minute across mailboxes; heartbeats retry unsuccessful dispatches. Replayed events are deduplicated. Each scan acknowledges only its starting event sequence, preserving arrivals during the scan. Credential changes retire old callback URLs; key revocation and inactive membership suppress delivery. Subscription status appears in `/status`.

Subscriptions are renewed when the last heartbeat becomes stale, during initial or recovery checks. Outbound HTTPS from the Exchange server must be allowed. Registration alone does not prove callback reachability; live callback and automatic delivery acceptance must pass. Failed push maintenance does not disable the working unread-mail scanner.

## Manual real-time trial

The **Test realtime notifications** workflow tests EWS streaming on the Host mailbox only. It first creates and removes a `NewMailEvent` subscription to check permission, then listens for up to five minutes. Wait until the listener reports ready before sending a harmless new email, and leave the email unread. Existing unread mail, status events, and events from other folders cannot pass the trial.

An Inbox new-mail event triggers a metadata-only fetch and the usual encrypted notification queue. The test measures approximate event/delivery delays, checks unread status, closes the stream, and unsubscribes. Logs contain counts and timings, not mail contents or subscription IDs. A final normal forced poll restores mailbox status and provides the usual delivery fallback; its sends are separate from the real-time result. A timed-out trial is inconclusive, not proof that subscriptions are unsupported.

This is a bounded manual test, not an always-on deployment. The production callback path and 24/7 recovery checks are separate from this bounded streaming trial. A permanent streaming listener would need continuous hosting, reconnection and subscription recovery; GitHub workflow startup time is excluded from the measured in-session delay.

## Local tests

```sh
node --test worker/test/*.test.js
python3 -m unittest discover -s tests -v
```

Tests use a real in-memory SQLite database behind a D1-compatible adapter, synthetic Telegram updates, a fake Telegram transport, and a mock Exchange query. No real credentials or mail are used. Node 24+ and Python 3.12+ are recommended. No third-party packages are needed for these local tests. The live poller requires the dependency in `poller/requirements.txt`.
