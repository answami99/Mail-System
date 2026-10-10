"""Run intentionally after deployment. No token appears in shell history or output."""
import getpass
import json
import re
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.parse import urlparse


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    origin = input('Deployed Worker HTTPS origin: ').strip().rstrip('/')
    parsed = urlparse(origin)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.path or parsed.query or parsed.username or parsed.fragment:
        raise ValueError('Use an HTTPS origin without a path')
    token = getpass.getpass('Telegram bot token (hidden): ')
    secret = getpass.getpass('WEBHOOK_SECRET configured in Cloudflare (hidden): ')
    if not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', secret):
        raise ValueError('Webhook secret must be 32–256 letters, digits, underscores or hyphens')
    opener = build_opener(NoRedirect)
    def call(method, data):
        request = Request(f'https://api.telegram.org/bot{token}/{method}', data=json.dumps(data).encode(),
                          headers={'Content-Type': 'application/json'})
        with opener.open(request, timeout=30) as response:
            result = json.load(response)
        if not result.get('ok'):
            raise RuntimeError('Telegram rejected the configuration')
        return result['result']
    call('setWebhook', {'url': origin + '/telegram', 'secret_token': secret,
                        'allowed_updates': ['message'], 'max_connections': 1, 'drop_pending_updates': False})
    result = call('getWebhookInfo', {})
    if result.get('url') != origin + '/telegram':
        raise RuntimeError('Webhook verification failed')
    print('Webhook registered and verified. Send /start to your bot privately.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Webhook setup failed. Verify the origin and secrets. Sensitive details omitted.')
        raise SystemExit(1)
