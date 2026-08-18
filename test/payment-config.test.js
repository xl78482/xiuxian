import assert from 'node:assert/strict';
import test from 'node:test';
import { DujiaoPayProvider } from '../packages/payment/dujiaopay.js';

const configured = {
  enabled: true,
  baseUrl: 'https://www.dujiaopay.com',
  keyId: 'merchant-key',
  secret: 'merchant-secret',
  webhookSecret: 'webhook-secret',
  chain: 'tron',
  tokenId: 'tron-usdt',
  ttlMinutes: 15,
};

test('distinguishes configured DujiaoPay credentials from accepting new orders', async () => {
  const provider = new DujiaoPayProvider({ ...configured, enabled: false });
  assert.equal(provider.isConfigured(), true);
  assert.equal(provider.isEnabled(), false);
  await assert.rejects(
    provider.createPayment({ amountFen: 100, merchantOrderId: 'XXTEST' }),
    (error) => error.code === 'payment_disabled',
  );
  provider.updateConfig(configured);
  assert.equal(provider.isEnabled(), true);
});

test('reports an unconfigured DujiaoPay channel without issuing requests', async () => {
  const provider = new DujiaoPayProvider({ ...configured, keyId: '', secret: '', webhookSecret: '', enabled: false });
  assert.equal(provider.isConfigured(), false);
  await assert.rejects(
    provider.whoAmI(),
    (error) => error.code === 'payment_not_configured',
  );
});
