"""Create a local, ignored secrets file without printing secrets to logs."""
import base64
import getpass
import json
import os
from pathlib import Path
import secrets


def main():
    destination = Path(__file__).resolve().parent.parent / 'secrets.local.json'
    token = getpass.getpass('Telegram bot token (hidden): ').strip()
    host_key = getpass.getpass('Fixed host access code, 6–8 digits (blank generates 8 digits): ').strip()
    if not host_key:
        host_key = f'{secrets.randbelow(100000000):08d}'
    if not host_key.isascii() or not host_key.isdigit() or not 6 <= len(host_key) <= 8:
        raise ValueError('Host code must contain 6–8 ASCII digits')
    if not token or '\n' in token:
        raise ValueError('Bot token is required')
    values = {'TELEGRAM_BOT_TOKEN':token, 'HOST_ACCESS_KEY':host_key,
              'ENCRYPTION_KEY':base64.b64encode(secrets.token_bytes(32)).decode(),
              'KEY_PEPPER':secrets.token_urlsafe(32), 'RUNNER_TOKEN':secrets.token_urlsafe(32),
              'WEBHOOK_SECRET':secrets.token_urlsafe(32)}
    # O_EXCL prevents accidental regeneration from destroying access to encrypted records.
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file:
        json.dump(values, file, indent=2)
    print('Created secrets.local.json with owner-only permissions. Keep a secure backup; do not commit or share it.')


if __name__ == '__main__':
    main()
