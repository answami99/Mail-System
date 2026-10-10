"""Register the fixed bot webhook without moving its Telegram token out of Cloudflare."""
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, HTTPRedirectHandler

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def main():
    origin = os.environ.get('BOT_BACKEND_URL', '').rstrip('/')
    token = os.environ.get('BOT_RUNNER_TOKEN', '')
    if origin != 'https://private-email-bot.answami99.workers.dev' or len(token) < 32:
        print('Backend secrets are missing or invalid.')
        return 1
    request = Request(origin + '/internal/setup', data=b'{}', method='POST',
                      headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with build_opener(NoRedirect).open(request, timeout=90) as response:
            result = json.load(response)
        if result.get('ok') is not True or result.get('webhook_configured') is not True:
            raise ValueError()
    except HTTPError as error:
        safe = {'Forbidden', 'Service not configured', 'Invalid private configuration', 'Unexpected bot token',
                'Bot already connected elsewhere', 'Webhook verification failed', 'Temporary service failure', 'Not found'}
        try:
            reason = json.loads(error.read(2048)).get('error')
        except Exception:
            reason = None
        print('Backend HTTP status:', error.code)
        print('Backend result:', reason if reason in safe else 'Unrecognized response (content withheld)')
        return 1
    except URLError:
        print('Could not reach the backend over verified HTTPS (DNS, connection, or TLS failure).')
        return 1
    except Exception:
        print('Connection failed. Check Cloudflare settings, deployed code, and the bot token; no secret values were logged.')
        return 1
    print('RajasthanMail_bot webhook registered and verified. Ready for /start in Telegram.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
