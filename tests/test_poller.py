import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch
from poller.mail import unread, message_key, PartialScan, classify
from poller.run import scan, APIError, NoRedirect, error_kinds


class Query:
    def __init__(self, items):
        self.items = items
        self.fields = None
    def filter(self, **kwargs):
        assert kwargs == {'is_read': False}
        return self
    def only(self, *fields):
        self.fields = fields
        return self
    def order_by(self, field):
        assert field == 'datetime_received'
        return self
    def __iter__(self):
        return iter(self.items)


def item(id='one', subject='Test'):
    return SimpleNamespace(id=id, subject=subject, sender=SimpleNamespace(email_address='sender@example.org'),
                           datetime_received=datetime(2026, 10, 12, 4, tzinfo=timezone.utc))


class Tests(unittest.TestCase):
    def test_metadata_only_read_only_and_ist(self):
        query = Query([item()])
        results = list(unread(SimpleNamespace(inbox=query), set(), 'a', 1))
        self.assertEqual(set(query.fields), {'sender', 'subject', 'datetime_received'})
        self.assertEqual(results[0], {'source_id': 'one', 'sender': 'sender@example.org', 'subject': 'Test',
                                     'received': '12 Oct 2026, 09:30 AM IST'})
        self.assertNotIn('body', results[0])

    def test_same_subject_different_mail_ids_both_notify_and_prior_ids_skip(self):
        query = Query([item('one'), item('two')])
        rows = list(unread(SimpleNamespace(inbox=query), {message_key('a', 1, 'one')}, 'a', 1))
        self.assertEqual([r['source_id'] for r in rows], ['two'])
        self.assertNotEqual(message_key('a', 1, 'one'), message_key('b', 1, 'one'))
        self.assertNotEqual(message_key('a', 1, 'one'), message_key('a', 2, 'one'))

    def test_unicode_subject_fits_single_telegram_message(self):
        row = list(unread(SimpleNamespace(inbox=Query([item(subject='😀' * 4000)])), set(), 'a', 1))[0]
        self.assertLessEqual(len(row['subject'].encode('utf-16-le')) // 2, 3300)
        self.assertTrue(row['subject'].endswith('…'))

    def test_budget_expiry_is_partial_not_success(self):
        with self.assertRaises(PartialScan):
            list(unread(SimpleNamespace(inbox=Query([item()])), set(), 'a', 1, lambda: False))
        self.assertEqual(classify(PartialScan()), 'partial')

    def test_job_is_finished_with_failure_without_exposing_password(self):
        calls = []
        class API:
            def post(self, route, body):
                calls.append((route, body.copy()))
                if route == 'claim':
                    return {'key_id': 'a', 'revision': 1, 'lease': 'x', 'email': 'a@rajasthan.gov.in', 'password': 'secret'}
                if route == 'known':
                    return {'ids': []}
                return {'ok': True}
        class UnauthorizedError(Exception):
            pass
        def bad_login(*args):
            raise UnauthorizedError('SENSITIVE SERVER RESPONSE')
        result, count = scan(API(), {'key_id': 'a', 'revision': 1}, 'slot', lambda: True, connector=bad_login)
        self.assertEqual(result, 'auth')
        self.assertEqual(count, 0)
        self.assertEqual(calls[-1][0], 'finish')
        self.assertNotIn('password', calls[-1][1])
        self.assertNotIn('SENSITIVE', str(calls))

    def test_backend_redirect_never_forwards_runner_secret(self):
        self.assertIsNone(NoRedirect().redirect_request(None, None, None, None, None, None))

    def test_exception_chain_never_serializes_private_messages(self):
        try:
            try:
                raise ConnectionError('private email and password')
            except Exception as cause:
                raise TimeoutError('private server response') from cause
        except Exception as error:
            self.assertEqual(error_kinds(error), 'TimeoutError -> ConnectionError')


if __name__ == '__main__':
    unittest.main()
