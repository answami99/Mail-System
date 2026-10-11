"""Maintain EWS push subscriptions. Callback URLs and IDs are never logged."""
from urllib.parse import urlparse


def ensure_push(api, identity, account):
    prepared = None
    try:
        prepared = api.post('push/prepare', identity)
        if not prepared.get('needed'):
            return
        callback = prepared['callback_url']
        parsed = urlparse(callback)
        if (parsed.scheme != 'https' or parsed.netloc != 'private-email-bot.answami99.workers.dev'
                or not parsed.path.startswith('/exchange/') or parsed.fragment or not parsed.query.startswith('token=')):
            raise ValueError('Invalid callback destination')
        subscription, _ = account.inbox.subscribe_to_push(callback_url=callback, event_types=['NewMailEvent'], status_frequency=1)
        api.post('push/confirm', {**identity, 'generation': prepared['generation'],
                                 'subscription_id': subscription, 'folder_id': account.inbox.id})
        print('PUSH_SUBSCRIPTION_REGISTERED; awaiting server callbacks.')
    except Exception:
        # Mail scans and delivery continue even when the server blocks outbound push.
        print('Push subscription maintenance unavailable; normal unread scan continues. Sensitive details omitted.')
        if prepared and prepared.get('generation'):
            try:
                api.post('push/failed', {**identity, 'generation': prepared['generation']})
            except Exception:
                pass
