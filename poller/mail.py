"""EWS adapter. Requires live validation against Rajasthan's server before launch."""
from hashlib import sha256
from zoneinfo import ZoneInfo
import base64
import os

EWS_ENDPOINT = 'https://mail.rajasthan.gov.in/EWS/Exchange.asmx'
CLIENT_AGENT = 'RajasthanMailNotifier/1.0 (+https://github.com/answami99/Mail-System)'


def transport_event(request, response):
    """Return only an allowlisted status/stage, never headers, tokens or content."""
    authorization = request.headers.get('Authorization', '')
    stage = 'unauthenticated'
    if authorization.startswith('NTLM '):
        stage = 'ntlm-unknown'
        try:
            token = base64.b64decode(authorization[5:], validate=True)
            if token[:8] == b'NTLMSSP\x00':
                stage = {1: 'ntlm-negotiate', 3: 'ntlm-authenticate'}.get(int.from_bytes(token[8:12], 'little'), stage)
        except Exception:
            pass
    elif authorization:
        stage = 'other-authentication'
    status = response.status_code
    return f'{stage}:HTTP{status}' if type(status) is int and 100 <= status <= 599 else f'{stage}:HTTPunknown'


def message_key(key_id, revision, source_id):
    return sha256(f'{key_id}\n{revision}\n{source_id}'.encode()).hexdigest()


def connect(email, password):
    from exchangelib import Account, Configuration, Credentials, DELEGATE, NTLM, BASIC, FailFast
    from exchangelib.protocol import BaseProtocol
    from requests.adapters import HTTPAdapter
    # Do not disable TLS verification, autodiscover to another host, or impersonate another mailbox.
    if not email.lower().endswith('@rajasthan.gov.in'):
        raise ValueError('Unsupported mailbox domain')
    BaseProtocol.TIMEOUT = 30
    BaseProtocol.USERAGENT = CLIENT_AGENT
    if os.environ.get('EWS_DIAGNOSTICS') == 'true':
        class DiagnosticAdapter(HTTPAdapter):
            def send(self, request, **kwargs):
                response = super().send(request, **kwargs)
                if request.url == EWS_ENDPOINT:
                    print('Exchange transport: ' + transport_event(request, response))
                return response
        BaseProtocol.HTTP_ADAPTER_CLS = DiagnosticAdapter
    auth = {'NTLM': NTLM, 'BASIC': BASIC}[os.environ.get('EWS_AUTH_TYPE', 'NTLM')]
    config = Configuration(service_endpoint=EWS_ENDPOINT, credentials=Credentials(email, password),
                           auth_type=auth, retry_policy=FailFast())
    # Scheduled jobs provide retries. FailFast preserves authentication failures instead of
    # treating HTTP 401 as throttling and hiding it behind a RateLimitError.
    return Account(primary_smtp_address=email, config=config, autodiscover=False, access_type=DELEGATE)


def unread(account, known, key_id, revision, budget_ok=lambda: True):
    # Request only notification metadata. Never request a message body or update the read flag.
    candidates = account.inbox.filter(is_read=False).only('sender', 'subject', 'datetime_received').order_by('datetime_received')
    candidates.page_size = 100
    for item in candidates:
        if not budget_ok():
            raise PartialScan()
        if message_key(key_id, revision, item.id) in known:
            continue
        subject = item.subject or ''
        if len(subject.encode('utf-16-le')) // 2 > 3300:
            # A rare overlong subject remains one Telegram message; clearly mark its truncation.
            subject = subject.encode('utf-16-le')[:6500].decode('utf-16-le', errors='ignore') + '…'
        sender = (item.sender.email_address if item.sender else None) or '(unknown sender)'
        yield {'source_id': item.id, 'subject': subject, 'sender': sender,
               'received': item.datetime_received.astimezone(ZoneInfo('Asia/Kolkata')).strftime('%d %b %Y, %I:%M %p IST')}


class PartialScan(Exception):
    pass


def classify(error):
    if isinstance(error, PartialScan):
        return 'partial'
    name = type(error).__name__
    if name in {'UnauthorizedError', 'ErrorInvalidCredentials', 'ErrorAccessDenied', 'ErrorImpersonateUserDenied'}:
        return 'auth'
    if any(word in name.lower() for word in ('timeout', 'connection', 'transport', 'serverbusy', 'ratelimit')):
        return 'network'
    return 'protocol'
