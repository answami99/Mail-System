"""No credentials, mail bodies, server responses or exception strings are logged."""
import argparse
import getpass
import json
import logging
import os
import sys
import time
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from .mail import connect, unread, classify

logging.disable(logging.CRITICAL)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class APIError(Exception):
    pass


def error_kinds(error):
    """Bounded class names only: exception messages and response contents are private."""
    kinds, seen = [], set()
    while error is not None and id(error) not in seen and len(kinds) < 5:
        seen.add(id(error))
        kind = type(error).__name__
        kinds.append(kind if kind.isidentifier() and len(kind) <= 64 else 'Error')
        error = error.__cause__ or error.__context__
    return ' -> '.join(kinds)


class Backend:
    def __init__(self):
        self.base = os.environ['BOT_BACKEND_URL'].rstrip('/')
        parsed = urlparse(self.base)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.query or parsed.fragment or parsed.path:
            raise ValueError('Backend must be an HTTPS origin')
        self.token = os.environ['BOT_RUNNER_TOKEN']
        self.opener = build_opener(NoRedirect)

    def post(self, route, data):
        request = Request(self.base + '/internal/' + route, method='POST', data=json.dumps(data).encode(),
                          headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json', 'User-Agent': 'RajasthanMailNotifier/1.0 (+https://github.com/answami99/Mail-System)'})
        for attempt in range(3):
            try:
                with self.opener.open(request, timeout=45) as response:
                    return json.load(response)
            except HTTPError as error:
                if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                    raise APIError('Backend request failed') from None
            except (URLError, TimeoutError, json.JSONDecodeError):
                if attempt == 2:
                    raise APIError('Backend request failed') from None
            time.sleep(2 ** attempt)


def scan(api, job, slot, budget_ok, connector=connect, reader=unread):
    claimed = api.post('claim', {**job, 'slot': slot})
    identity = {k: claimed[k] for k in ('key_id', 'revision', 'lease')}
    known = set(api.post('known', identity)['ids'])
    result, found = 'success', 0
    try:
        account = connector(claimed['email'], claimed['password'])
        for email in reader(account, known, job['key_id'], job['revision'], budget_ok):
            api.post('ingest', {**identity, 'email': email})
            found += 1
    except APIError:
        raise
    except Exception as error:
        result = classify(error)
        # Class names and categories identify transport problems without exposing URLs or credentials.
        print(f'Exchange check failed. Category: {result}; types: {error_kinds(error)}. Sensitive details omitted.')
    finally:
        claimed.clear()
    # The lease prevents stale runs finishing after a credential change/revocation.
    api.post('finish', {**identity, 'slot': slot, 'result': result})
    return result, found


def drain(api, budget_ok, initial_request=None):
    delivered = 0
    while budget_ok():
        pending = api.post('pending', {'initial_request': initial_request} if initial_request else {})['ids']
        if not pending:
            break
        for item in pending:
            if not budget_ok():
                break
            result = api.post('deliver', {'id': item})
            delivered += int(result.get('ok', False) and not result.get('skipped', False))
            # Conservative pacing: at most one message per second, including shared-mailbox recipients.
            time.sleep(1.1)
    return delivered


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--force', action='store_true', help='Explicit manual run outside scheduled hours')
    parser.add_argument('--initial', action='store_true', help='Check only queued newly connected Telegram accounts')
    parser.add_argument('--probe', action='store_true', help='Read-only local EWS login test; no Telegram transmission')
    args = parser.parse_args()
    if args.probe:
        email = input('Rajasthan email address: ').strip()
        password = getpass.getpass('Password (hidden): ')
        try:
            account = connect(email, password)
            count = account.inbox.filter(is_read=False).count()
            print(f'Exchange API access succeeded. Unread inbox messages: {count}. No messages modified.')
            return 0
        except Exception as error:
            print('Exchange API test failed. Category: ' + classify(error) + '. No credentials or server response printed.')
            return 1
    started = time.monotonic()
    # Leave room for orderly shutdown before the workflow's 15 minute hard limit.
    budget_ok = lambda: time.monotonic() - started < 720
    failures, found = 0, 0
    try:
        api = Backend()
        batch = api.post('jobs', {'force': args.force, 'initial': args.initial})
        if not batch['slot']:
            print('Outside the scheduled work window; no mail checks or sends performed.')
            return 0
        jobs = batch['jobs']
        sent, failed_keys = 0, set()
        for index, job in enumerate(jobs):
            if args.initial and job['key_id'] in failed_keys:
                continue
            if not budget_ok():
                failures += 1
                break
            # Give every inbox a fair share; unfinished unread scans resume on a future run.
            remaining = 600 - (time.monotonic() - started)
            deadline = time.monotonic() + max(15, remaining / max(1, len(jobs) - index))
            mailbox_budget = lambda: budget_ok() and time.monotonic() < deadline
            try:
                result, count = scan(api, job, batch['slot'], mailbox_budget)
                found += count
                failures += int(result != 'success')
                if args.initial:
                    sent += drain(api, budget_ok, job['initial_request'])
                    if result != 'success':
                        failed_keys.add(job['key_id'])
            except Exception:
                failures += 1
        if not args.initial:
            sent = drain(api, budget_ok)
        print(f'Run complete. Mailboxes attempted: {len(jobs)}; newly queued: {found}; delivered: {sent}; failed checks: {failures}.')
        return 1 if failures else 0
    except Exception:
        print('Run failed. Check backend availability and configured secrets. Sensitive details omitted.')
        return 1


if __name__ == '__main__':
    sys.exit(main())
