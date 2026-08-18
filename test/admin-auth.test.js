import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AdminAccountStore } from '../packages/core/admin-auth.js';
import { createCardCrypto } from '../packages/core/crypto.js';
import { openDatabase } from '../packages/core/database.js';
import { SettingsStore } from '../packages/core/settings.js';

const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('authenticates an independent admin and encrypts Telegram settings', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-admin-auth-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  try {
    const accounts = new AdminAccountStore(db);
    const settings = new SettingsStore(db, createCardCrypto(key));
    const account = accounts.create('operator', 'strong-admin-password');
    const auditIdentity = db.prepare('SELECT role, telegram_id FROM users WHERE id = ?').get(account.id);
    assert.equal(auditIdentity.role, 'admin');
    assert.match(auditIdentity.telegram_id, /^admin:adm_/);
    assert.equal(accounts.authenticate('operator', 'wrong-password'), null);
    assert.equal(accounts.authenticate('operator', 'strong-admin-password').id, account.id);
    assert.equal(accounts.findByUsername('operator').password_hash.includes('strong-admin-password'), false);
    settings.setTelegramBotToken('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456');
    assert.equal(settings.isTelegramBotTokenConfigured(), true);
    assert.equal(settings.getTelegramBotToken(), '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456');
    const stored = db.prepare('SELECT value_ciphertext FROM app_settings WHERE key = ?').get('telegram_bot_token');
    assert.notEqual(stored.value_ciphertext, '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456');
    settings.setPaymentConfig({ enabled: true, keyId: 'merchant-key', secret: 'merchant-secret', webhookSecret: 'webhook-secret', baseUrl: 'https://www.dujiaopay.com', chain: 'tron', tokenId: 'tron-usdt', ttlMinutes: 15 });
    assert.equal(settings.getPaymentConfig().secret, 'merchant-secret');
    assert.ok(settings.getPaymentConfigMetadata().updatedAt);
    const paymentStored = db.prepare('SELECT value_ciphertext FROM app_settings WHERE key = ?').get('payment_config');
    assert.equal(paymentStored.value_ciphertext.includes('merchant-secret'), false);
    accounts.update(account.id, { password: 'new-strong-admin-password' });
    assert.equal(accounts.authenticate('operator', 'new-strong-admin-password').id, account.id);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
