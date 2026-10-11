import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from io import StringIO
from poller.push import ensure_push


class PushTests(unittest.TestCase):
    def test_registers_only_new_inbox_events_with_fixed_callback(self):
        api=Mock()
        api.post.side_effect=[{'needed':True,'generation':'g','callback_url':'https://private-email-bot.answami99.workers.dev/exchange/g?token=private'}, {'ok':True}]
        inbox=SimpleNamespace(id='private-inbox',subscribe_to_push=Mock(return_value=('private-subscription','private-watermark')))
        with patch('sys.stdout',new_callable=StringIO) as output:
            ensure_push(api,{'key_id':'host','revision':1,'lease':'l'},SimpleNamespace(inbox=inbox))
        inbox.subscribe_to_push.assert_called_once_with(callback_url='https://private-email-bot.answami99.workers.dev/exchange/g?token=private',event_types=['NewMailEvent'],status_frequency=1)
        self.assertEqual(api.post.call_args_list[-1].args[0],'push/confirm')
        self.assertNotIn('private',output.getvalue())

    def test_healthy_subscription_does_not_reconnect_or_renew(self):
        api=Mock();api.post.return_value={'needed':False};account=Mock()
        ensure_push(api,{},account)
        account.inbox.subscribe_to_push.assert_not_called()

    def test_redirected_callback_fails_without_contacting_exchange(self):
        api=Mock();api.post.side_effect=[{'needed':True,'generation':'g','callback_url':'https://attacker.example/?token=private'}, {'ok':True}];account=Mock()
        with patch('sys.stdout',new_callable=StringIO) as output:
            ensure_push(api,{},account)
        account.inbox.subscribe_to_push.assert_not_called()
        self.assertEqual(api.post.call_args_list[-1].args[0],'push/failed')
        self.assertNotIn('private',output.getvalue())

    def test_subscription_errors_are_redacted_and_do_not_fail_mail_scan(self):
        api=Mock();api.post.side_effect=[{'needed':True,'generation':'g','callback_url':'https://private-email-bot.answami99.workers.dev/exchange/g?token=private'}, {'ok':True}]
        account=Mock();account.inbox.subscribe_to_push.side_effect=RuntimeError('private-password-response')
        with patch('sys.stdout',new_callable=StringIO) as output:
            ensure_push(api,{},account)
        self.assertNotIn('private',output.getvalue())
        self.assertEqual(api.post.call_args_list[-1].args[0],'push/failed')
