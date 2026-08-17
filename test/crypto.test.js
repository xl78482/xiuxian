import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  AuthError,
  createSessionToken,
  verifySessionToken,
  verifyTelegramInitData,
} from '../packages/core/crypto.js';

const botToken = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456';
const user = { id: 8869336080, first_name: '秀用户', last_name: '测试', username: 'xiuxian_user', photo_url: 'https://telegram.org/img/t_logo.png' };

function signedInitData(overrides = {}) {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify(user),
    ...overrides,
  };
  const checkString = Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

test('accepts a fresh signed Telegram Mini App identity', () => {
  assert.deepEqual(verifyTelegramInitData(signedInitData(), botToken), user);
});

test('rejects expired or modified Telegram initData', () => {
  assert.throws(
    () => verifyTelegramInitData(signedInitData({ auth_date: String(Math.floor(Date.now() / 1000) - 86401) }), botToken),
    (error) => error instanceof AuthError && error.message.includes('已过期'),
  );
  const tampered = signedInitData().replace('xiuxian_user', 'other_user');
  assert.throws(
    () => verifyTelegramInitData(tampered, botToken),
    (error) => error instanceof AuthError && error.message.includes('签名无效'),
  );
});

test('invalidates sessions signed with a replaced secret', () => {
  const oldToken = createSessionToken('usr_old', 'o'.repeat(32));
  const newToken = createSessionToken('usr_new', 'n'.repeat(32));
  assert.equal(verifySessionToken(oldToken, 'n'.repeat(32)), null);
  assert.equal(verifySessionToken(newToken, 'n'.repeat(32)).userId, 'usr_new');
});
