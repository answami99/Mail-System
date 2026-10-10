# Mail-System — Rajasthan Mail Bot

Repository: [answami99/Mail-System](https://github.com/answami99/Mail-System) · Telegram: [@RajasthanMail_bot](https://t.me/RajasthanMail_bot)

Implementation for a closed Telegram bot with GitHub Actions polling and a Cloudflare Worker + D1 backend. **Built locally; not deployed or connected to a real mailbox.** Live Exchange API compatibility and free-tier capacity still need verification.

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
- Checks are scheduled **Monday–Friday, 09:30 through 18:00 IST inclusive**, every 30 minutes: 18 runs/day, 90/week. No holiday calendar. Last-slot delayed execution is allowed until 18:29 IST; delivery can finish later. A manual forced run intentionally overrides hours.
- D1 stores encrypted credentials and queued notification metadata, plus delivery receipts. GitHub runners are temporary and do not store state in commits, caches or artifacts.
- Retries retain queued notifications even if an email later becomes read. Completed delivery records normally prevent repeats. A new Telegram account receives the unread backlog at the next check.
- Authentication/API failures pause the affected mailbox after three checks. Network errors retry next scheduled run. `/status` and host `/health` show failures and last successful check.
- Revoking a key removes its credentials and queued metadata. Removing a user blocks re-enrollment until the host allows it. Already sent Telegram messages cannot be retracted by revocation; an in-flight send may complete.

## Hosting choice and limits

GitHub Actions performs the scheduled mail checks. Cloudflare's small HTTPS webhook handles bot replies immediately, and D1 holds persistent state. GitHub alone is not an always-on webhook host or a durable application database.

This targets free allowances, **not unlimited hosting or guaranteed delivery times**:

| Service | Published allowance or constraint | Consequence |
|---|---|---|
| GitHub Free, private repository | 2,000 Actions minutes/month | 18 runs × 22 weekdays = 396 runs; at 2 billed minutes/run about 792 minutes, at 5 minutes about 1,980, before tests/other usage. Measure actual billing. |
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

- **EWS availability is unverified.** Successful OWA login does not prove the EWS endpoint or NTLM/basic auth is enabled. No CAPTCHA does not prove automation/API access is available. This implementation does not claim an OWA-browser fallback. If EWS is blocked, a separately tested OWA connector or administrator-supported method is needed.
- An EWS read-only API request leaves unread flags unchanged; the full mailbox password itself is not a read-only credential.
- Exactly-once delivery cannot be guaranteed across Telegram and D1. If Telegram accepts a send but the response/receipt write is lost, a retry can produce a duplicate. The implementation favors retry over silent loss.
- Revoking data on the host cannot delete copies already received on users' devices. `protect_content` discourages forwarding/saving but cannot stop every form of copying.
- Unread scans are bounded by run time; large mailboxes may require several runs. GitHub jobs have a 15-minute cap and a 12-minute work budget. EWS IDs can change when messages move; a message moved back into Inbox may notify again.
- Polling itself is not push. A message arriving just after a check may wait about 30 minutes plus queue delays; evening/weekend mail waits until Monday or the next workday's checks if still unread.
- `/health` and GitHub failure notifications help detect errors; there is no independent external uptime watchdog in this version. If the scheduler itself stops, the bot does not automatically repair it.

See [SETUP.md](SETUP.md) for deployment and acceptance checks.

## Local tests

```sh
node --test worker/test/*.test.js
python3 -m unittest discover -s tests -v
```

Tests use a real in-memory SQLite database behind a D1-compatible adapter, synthetic Telegram updates, a fake Telegram transport, and a mock Exchange query. No real credentials or mail are used. Node 24+ and Python 3.12+ are recommended. No third-party packages are needed for these local tests. The live poller requires the dependency in `poller/requirements.txt`.
