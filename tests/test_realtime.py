from contextlib import contextmanager, redirect_stdout
from datetime import datetime, timezone
from io import StringIO
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from poller.mail import message_key
from poller.realtime import trial


class NewMailEvent:
    def __init__(self, source='new', folder='inbox'):
        self.item_id = SimpleNamespace(id=source, changekey='change')
        self.parent_folder_id = SimpleNamespace(id=folder)
        self.timestamp = datetime.now(timezone.utc)


class API:
    def __init__(self, host=True):
        self.calls = []
        self.host = host

    def post(self, route, body):
        self.calls.append((route, body.copy()))
        if route == 'jobs':
            return {'slot': 'manual:trial', 'jobs':
                    [{'key_id': 'other', 'revision': 1}] + ([{'key_id': 'host', 'revision': 1}] if self.host else [])}
        if route == 'claim':
            return {**body, 'lease': 'lease', 'email': 'private@rajasthan.gov.in', 'password': 'PRIVATE PASSWORD'}
        if route == 'known':
            return {'ids': []}
        if route == 'pending':
            return {'ids': [message_key('host', 1, 'new') + ':123', message_key('other', 1, 'new') + ':456']}
        return {'ok': True}


class Account:
    def __init__(self, reject=False, read_after=False):
        self.inbox = self
        self.id = 'inbox'
        self.reject, self.read_after = reject, read_after
        self.unsubscribed = []
        self.fetches = []
        self.closed = False

    def subscribe_to_streaming(self, event_types):
        assert event_types == ['NewMailEvent']
        if self.reject:
            raise PermissionError('PRIVATE SERVER RESPONSE')
        return 'PRIVATE SUBSCRIPTION ID'

    def unsubscribe(self, subscription_id):
        self.unsubscribed.append(subscription_id)

    def fetch(self, ids, folder, only_fields):
        assert self.closed, 'stream response must be released before fetching'
        self.fetches.append((ids, only_fields))
        return [SimpleNamespace(id='new', is_read=self.read_after if only_fields == ['is_read'] else False,
                                subject='PRIVATE SUBJECT', sender=SimpleNamespace(email_address='private@example.org'),
                                datetime_received=datetime.now(timezone.utc))]


class StreamingTests(unittest.TestCase):
    def execute(self, account, events=(), capability=False, host=True):
        api, output = API(host), StringIO()

        @contextmanager
        def stream_factory(*args):
            try:
                yield [SimpleNamespace(events=events)]
            finally:
                account.closed = True

        with redirect_stdout(output), patch('poller.realtime.time.sleep'):
            result = trial(api, capability_only=capability, connector=lambda *args: account,
                           stream_factory=stream_factory, baseline_reader=lambda *args: iter([]))
        return result, api, output.getvalue()

    def test_live_event_delivers_only_matching_host_metadata_and_cleans_up(self):
        account = Account()
        result, api, log = self.execute(account, [NewMailEvent(), NewMailEvent(), NewMailEvent('other', 'sent')])
        self.assertEqual(result, 0)
        self.assertEqual(account.unsubscribed, ['PRIVATE SUBSCRIPTION ID'])
        self.assertEqual([b['key_id'] for r, b in api.calls if r == 'claim'], ['host'])
        self.assertEqual([b['id'] for r, b in api.calls if r == 'deliver'], [message_key('host', 1, 'new') + ':123'])
        rows = [b['email'] for r, b in api.calls if r == 'ingest']
        self.assertEqual(len(rows), 1)
        self.assertEqual(set(rows[0]), {'source_id', 'sender', 'subject', 'received'})
        self.assertEqual(set(account.fetches[0][1]), {'sender', 'subject', 'datetime_received', 'is_read'})
        self.assertEqual(account.fetches[1][1], ['is_read'])
        self.assertIn('REALTIME_TRIAL_PASSED', log)
        self.assertNotIn('PRIVATE', log)

    def test_status_or_other_folder_event_is_inconclusive(self):
        account = Account()
        result, api, log = self.execute(account, [SimpleNamespace(), NewMailEvent(folder='sent')])
        self.assertEqual(result, 2)
        self.assertFalse(any(r == 'ingest' for r, b in api.calls))
        self.assertEqual(len(account.unsubscribed), 1)
        self.assertNotIn('REALTIME_TRIAL_PASSED', log)

    def test_capability_probe_unsubscribes_without_fetching_or_sending(self):
        account = Account()
        result, api, log = self.execute(account, capability=True)
        self.assertEqual(result, 0)
        self.assertEqual(account.fetches, [])
        self.assertEqual(len(account.unsubscribed), 1)
        self.assertFalse(any(r in {'ingest', 'deliver'} for r, b in api.calls))

    def test_rejected_subscription_is_redacted_and_does_not_record_mailbox_auth_failure(self):
        result, api, log = self.execute(Account(reject=True))
        self.assertEqual(result, 1)
        self.assertNotIn('PRIVATE', log)
        self.assertEqual(api.calls[-1][0], 'finish')
        self.assertEqual(api.calls[-1][1]['result'], 'partial')

    def test_host_missing_never_claims_another_mailbox(self):
        result, api, log = self.execute(Account(), host=False)
        self.assertEqual(result, 1)
        self.assertFalse(any(r == 'claim' for r, b in api.calls))

    def test_unread_change_cannot_be_reported_as_pass(self):
        result, api, log = self.execute(Account(read_after=True), [NewMailEvent()])
        self.assertEqual(result, 2)
        self.assertNotIn('REALTIME_TRIAL_PASSED', log)

    def test_stream_error_still_unsubscribes_and_releases_lease(self):
        account, api, output = Account(), API(), StringIO()

        @contextmanager
        def broken(*args):
            raise ConnectionError('PRIVATE CONNECTION DETAILS')
            yield

        with redirect_stdout(output):
            result = trial(api, connector=lambda *args: account, stream_factory=broken,
                           baseline_reader=lambda *args: iter([]))
        self.assertEqual(result, 1)
        self.assertEqual(len(account.unsubscribed), 1)
        self.assertEqual(api.calls[-1][0], 'finish')
        self.assertNotIn('PRIVATE', output.getvalue())


if __name__ == '__main__':
    unittest.main()
