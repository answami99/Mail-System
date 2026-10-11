"""Bounded manual streaming trial. No subscription IDs or mailbox contents are logged."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import sys
import time

from .mail import connect, metadata, message_key, unread
from .run import Backend, error_kinds


@contextmanager
def streaming(account, subscription_id, minutes):
    from exchangelib.services import GetStreamingEvents
    service = GetStreamingEvents(account=account)
    try:
        yield service.call(subscription_ids=[subscription_id], connection_timeout=minutes)
    finally:
        # Release the HTTP response/session before fetching notification metadata.
        service.stop_streaming()


def new_mail_events(notification, inbox_id):
    """Accept only Inbox NewMail events; a status/change event is not a passing test."""
    found = {}
    for event in notification.events:
        if type(event).__name__ != 'NewMailEvent':
            continue
        item_id = getattr(event, 'item_id', None)
        parent = getattr(event, 'parent_folder_id', None)
        if not item_id or not isinstance(item_id.id, str) or not item_id.id or not parent or parent.id != inbox_id:
            continue
        found[item_id.id] = event
    return found


def deliver_matching(api, allowed, budget_ok):
    sent = 0
    # A trial can never drain another mailbox's pending notifications.
    pending = api.post('pending', {})['ids']
    for delivery_id in pending:
        if delivery_id.split(':', 1)[0] not in allowed or not budget_ok():
            continue
        response = api.post('deliver', {'id': delivery_id})
        sent += int(response.get('ok', False) and not response.get('skipped', False))
        time.sleep(1.1)
    return sent


def trial(api, minutes=5, capability_only=False, connector=connect, stream_factory=streaming,
          baseline_reader=unread):
    started = time.monotonic()
    budget_ok = lambda: time.monotonic() - started < 600
    batch = api.post('jobs', {'force': True})
    job = next((j for j in batch['jobs'] if j['key_id'] == 'host'), None)
    if not job:
        print('Host mailbox unavailable or already leased. No other mailbox will be tested.', flush=True)
        return 1
    claimed = api.post('claim', {**job, 'slot': batch['slot']})
    identity = {k: claimed[k] for k in ('key_id', 'revision', 'lease')}
    account, subscription_id = None, None
    outcome = 1
    cleanup_ok = True
    try:
        account = connector(claimed['email'], claimed['password'])
        claimed.clear()
        known = set(api.post('known', identity)['ids'])
        # Exclude existing unread mail: only an actual post-subscription event can pass this trial.
        for row in baseline_reader(account, known, job['key_id'], job['revision'], budget_ok):
            known.add(message_key(job['key_id'], job['revision'], row['source_id']))
        inbox = account.inbox
        subscription_id = inbox.subscribe_to_streaming(event_types=['NewMailEvent'])
        print('STREAMING_SUBSCRIPTION_ACCEPTED', flush=True)
        if capability_only:
            outcome = 0
        else:
            until = datetime.now(timezone.utc) + timedelta(minutes=minutes)
            events = {}
            with stream_factory(account, subscription_id, minutes) as notifications:
                print('STREAMING_LISTENER_READY; send a new test email now. Window ends around ' +
                      until.isoformat(timespec='seconds'), flush=True)
                for notification in notifications:
                    events = new_mail_events(notification, inbox.id)
                    if events:
                        break
            if not events:
                print('INCONCLUSIVE: no Inbox NewMail event arrived during this window.', flush=True)
                outcome = 2
            else:
                observed = datetime.now(timezone.utc)
                print(f'NEW_MAIL_EVENT_RECEIVED; count={len(events)}', flush=True)
                lag = []
                for event in events.values():
                    stamp = getattr(event, 'timestamp', None)
                    if stamp is not None and stamp.tzinfo is not None:
                        lag.append((observed - stamp).total_seconds())
                if lag:
                    print(f'Server event to listener, seconds: min={min(lag):.2f}, max={max(lag):.2f}', flush=True)
                requested = [(event.item_id.id, event.item_id.changekey) for event in events.values()]
                allowed, received = set(), []
                for item in account.fetch(ids=requested, folder=inbox,
                                          only_fields=['sender', 'subject', 'datetime_received', 'is_read']):
                    if isinstance(item, Exception):
                        raise item
                    if item.id not in events or item.is_read is not False:
                        continue
                    source = message_key(job['key_id'], job['revision'], item.id)
                    if source in known:
                        continue
                    api.post('ingest', {**identity, 'email': metadata(item)})
                    allowed.add(source)
                    known.add(source)
                    received.append(item.datetime_received)
                sent = deliver_matching(api, allowed, budget_ok) if allowed else 0
                print(f'Event-triggered notifications: queued={len(allowed)}, delivered={sent}', flush=True)
                if received and sent:
                    accepted = datetime.now(timezone.utc)
                    delay = [(accepted - stamp).total_seconds() for stamp in received]
                    print(f'Mail received to Telegram acceptance, seconds: min={min(delay):.2f}, max={max(delay):.2f}', flush=True)
                flags = list(account.fetch(ids=requested, folder=inbox, only_fields=['is_read']))
                unchanged = len(flags) == len(requested) and all(
                    not isinstance(item, Exception) and item.id in events and item.is_read is False for item in flags)
                print(f'Event emails still unread: {str(unchanged).lower()}', flush=True)
                outcome = 0 if allowed and sent >= len(allowed) and unchanged else 2
                print('REALTIME_TRIAL_PASSED' if outcome == 0 else
                      'INCONCLUSIVE: event arrived but delivery or unread verification did not complete.', flush=True)
    except Exception as error:
        print('Streaming trial failed; types: ' + error_kinds(error) + '. Sensitive details omitted.', flush=True)
    finally:
        claimed.clear()
        if account is not None and subscription_id:
            try:
                account.inbox.unsubscribe(subscription_id=subscription_id)
                print('STREAMING_SUBSCRIPTION_REMOVED', flush=True)
            except Exception as error:
                cleanup_ok = False
                print('Subscription cleanup failed; types: ' + error_kinds(error) + '. Sensitive details omitted.', flush=True)
        try:
            # Experimental notification support must not increment normal mailbox failure counters,
            # mark an initial backlog completed, or claim that a full polling check was completed.
            api.post('finish', {**identity, 'slot': batch['slot'], 'result': 'partial'})
        except Exception:
            cleanup_ok = False
            print('Lease release failed. The existing 15-minute lease expiry remains in effect.', flush=True)
    return outcome if cleanup_ok else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--capability-only', action='store_true')
    parser.add_argument('--minutes', type=int, choices=range(1, 6), default=5)
    args = parser.parse_args()
    try:
        return trial(Backend(), args.minutes, args.capability_only)
    except Exception as error:
        print('Trial could not start; types: ' + error_kinds(error) + '. Sensitive details omitted.', flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
