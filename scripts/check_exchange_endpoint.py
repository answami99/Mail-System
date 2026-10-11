"""Public endpoint diagnostics. No login, response body, private URL or credentials."""
import re
from urllib.error import HTTPError
from urllib.request import Request, HTTPRedirectHandler, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


for label, path in [('EWS', '/EWS/Exchange.asmx'), ('OWA', '/owa/')]:
    request = Request('https://mail.rajasthan.gov.in' + path, headers={
        'User-Agent': 'RajasthanMailNotifier/1.0 (+https://github.com/answami99/Mail-System)'})
    try:
        try:
            response = build_opener(NoRedirect).open(request, timeout=25)
        except HTTPError as error:
            response = error
        with response:
            header = response.headers.get('WWW-Authenticate', '')
            schemes = [name for name in ('NTLM', 'Negotiate', 'Basic', 'Bearer')
                       if re.search(r'\b' + name + r'\b', header, re.I)]
            print(f'{label} public endpoint: HTTP {response.code}; advertised authentication: '
                  + (', '.join(schemes) or 'none'))
    except Exception as error:
        print(f'{label} public endpoint: verified HTTPS request failed ({type(error).__name__}).')
