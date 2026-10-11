import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Telegram, TelegramError} from '../src/common.js';

test('Telegram transport does not follow redirects or expose credentials in errors', async t => {
  const token = '123456:test-private-token';
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    return new Response(null, {status: 302, headers: {Location: 'https://other.example/'}});
  });
  await assert.rejects(new Telegram({TELEGRAM_BOT_TOKEN: token}).call('getMe', {}), error => {
    assert(error instanceof TelegramError);
    assert.equal(error.code, 302);
    assert.equal(error.message.includes(token), false);
    return true;
  });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('Telegram transport returns API results and preserves safe error codes', async t => {
  const replies = [
    Response.json({ok: true, result: {username: 'RajasthanMail_bot'}}),
    new Response('upstream unavailable', {status: 502}),
    Response.json({ok: false, error_code: 429, parameters: {retry_after: 12}})
  ];
  t.mock.method(globalThis, 'fetch', async () => replies.shift());
  const tg = new Telegram({TELEGRAM_BOT_TOKEN: '123456:test-private-token'});
  assert.equal((await tg.call('getMe', {})).username, 'RajasthanMail_bot');
  await assert.rejects(tg.call('getMe', {}), error => error.code === 502);
  await assert.rejects(tg.call('getMe', {}), error => error.code === 429 && error.retry === 12);
});
