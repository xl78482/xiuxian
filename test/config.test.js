import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../packages/core/config.js';

const baseEnvironment = {
  NODE_ENV: 'development',
  PAYMENT_PROVIDER: 'dujiaopay',
  APP_ORIGIN: 'http://localhost:3000',
  SESSION_SECRET: 's'.repeat(32),
  CARD_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  DUJIAOPAY_BASE_URL: 'https://www.dujiaopay.com',
  DUJIAOPAY_KEY_ID: 'test-key',
  DUJIAOPAY_SECRET: 'test-secret',
  DUJIAOPAY_WEBHOOK_SECRET: 'test-webhook-secret',
  DUJIAOPAY_CHAIN: 'tron',
  DUJIAOPAY_TOKEN_ID: 'tron-usdt',
};

function temporaryRoot() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-config-'));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '1.0.7' }));
  return directory;
}

function withEnvironment(overrides, callback) {
  const keys = new Set([...Object.keys(baseEnvironment), ...Object.keys(overrides)]);
  const previous = new Map([...keys].map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      const value = overrides[key] ?? baseEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('rejects the removed mock payment provider', () => {
  const root = temporaryRoot();
  try {
    withEnvironment({ PAYMENT_PROVIDER: 'mock' }, () => {
      assert.throws(() => loadConfig(root), /PAYMENT_PROVIDER must be dujiaopay/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('requires all real DujiaoPay credentials', () => {
  const root = temporaryRoot();
  try {
    withEnvironment({ DUJIAOPAY_WEBHOOK_SECRET: '' }, () => {
      assert.throws(() => loadConfig(root), /DUJIAOPAY_WEBHOOK_SECRET is required/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loads the real DujiaoPay provider configuration', () => {
  const root = temporaryRoot();
  try {
    withEnvironment({}, () => {
      const config = loadConfig(root);
      assert.equal(config.paymentProvider, 'dujiaopay');
      assert.equal(config.dujiaopay.chain, 'tron');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
