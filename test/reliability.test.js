import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CommerceService, makeMockPaymentProvider } from '../packages/core/commerce.js';
import { createCardCrypto } from '../packages/core/crypto.js';
import { openDatabase } from '../packages/core/database.js';
import { DujiaoPayProvider, signRequest } from '../packages/payment/dujiaopay.js';

const cardKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function setup(paymentProvider) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-reliability-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const config = {
    appOrigin: 'http://localhost:3000',
    isProduction: false,
    paymentTtlMinutes: 15,
    adminTelegramIds: new Set(['100000001']),
  };
  const provider = paymentProvider ?? makeMockPaymentProvider(config.appOrigin);
  const commerce = new CommerceService({
    db,
    config,
    paymentProvider: provider,
    cardCrypto: createCardCrypto(cardKey),
  });
  const admin = commerce.upsertTelegramUser({ id: 100000001, first_name: 'Admin' });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO categories (id, name, slug, position, created_at, updated_at) VALUES ('cat', 'Test', 'test', 0, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO products (id, category_id, title, slug, status, created_at, updated_at) VALUES ('product', 'cat', 'Product', 'product', 'active', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO product_variants (id, product_id, name, sku, price_fen, max_per_order, created_at, updated_at) VALUES ('variant', 'product', 'Variant', 'SKU-1', 1990, 3, ?, ?)`).run(now, now);
  commerce.importCards(admin, {
    variantId: 'variant',
    batchLabel: 'batch',
    cards: [{ code: 'CARD-1' }, { code: 'CARD-2' }, { code: 'CARD-3' }],
  });
  return {
    db,
    commerce,
    admin,
    close() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function paymentRow(db, orderNo) {
  return db.prepare(`SELECT pt.*, o.id AS local_order_id FROM payment_transactions pt JOIN orders o ON o.id = pt.order_id WHERE o.order_no = ?`).get(orderNo);
}

function paidEvent(payment, eventId = 'evt-paid') {
  return {
    event_id: eventId,
    event_type: 'order.paid',
    created_at: new Date().toISOString(),
    data: {
      order_id: payment.provider_order_id,
      merchant_order_id: payment.merchant_order_id,
      status: 'paid',
      chain: payment.chain,
      token_id: payment.token_id,
      payable_amount: payment.payable_amount,
      fiat_currency: payment.fiat_currency,
      fiat_amount: payment.fiat_amount,
      tx_hash: '0xpayment',
    },
  };
}

test('rejects reuse of an idempotency key for a different quantity', async () => {
  const context = setup();
  try {
    await context.commerce.createOrder(context.admin, { variantId: 'variant', quantity: 1, idempotencyKey: 'same-key' });
    assert.throws(
      () => context.commerce.createOrder(context.admin, { variantId: 'variant', quantity: 2, idempotencyKey: 'same-key' }),
      (error) => error.code === 'idempotency_conflict' && error.status === 409,
    );
  } finally {
    context.close();
  }
});

test('records failed webhooks and safely retries the identical event', async () => {
  const context = setup();
  try {
    const order = await context.commerce.createOrder(context.admin, { variantId: 'variant', quantity: 1, idempotencyKey: 'webhook-retry' });
    const payment = paymentRow(context.db, order.orderNo);
    const event = paidEvent(payment);
    context.db.prepare(`UPDATE payment_transactions SET fiat_amount = '20.00' WHERE id = ?`).run(payment.id);
    const failed = context.commerce.processWebhook(event);
    assert.deepEqual(failed, { duplicate: false, processed: false, error: 'payment_amount_mismatch' });
    assert.equal(context.commerce.listWebhookFailures().length, 1);
    assert.equal(context.db.prepare(`SELECT status FROM orders WHERE order_no = ?`).get(order.orderNo).status, 'pending_payment');

    context.db.prepare(`UPDATE payment_transactions SET fiat_amount = '19.90' WHERE id = ?`).run(payment.id);
    const retried = context.commerce.processWebhook(event);
    assert.deepEqual(retried, { duplicate: true, processed: true, error: null });
    assert.equal(context.commerce.processJobs(5), 1);
    assert.equal(context.commerce.getOrderForUser(order.orderNo, context.admin.id).status, 'completed');
    assert.equal(context.commerce.listWebhookFailures().length, 0);
  } finally {
    context.close();
  }
});

test('rejects a duplicate webhook ID carrying different content', () => {
  const context = setup();
  try {
    const first = { event_id: 'evt-conflict', event_type: 'webhook.test', data: { value: 1 } };
    assert.equal(context.commerce.processWebhook(first).processed, true);
    const conflict = context.commerce.processWebhook({ ...first, data: { value: 2 } });
    assert.equal(conflict.error, 'webhook_payload_conflict');
    assert.equal(context.commerce.listWebhookFailures().length, 1);
  } finally {
    context.close();
  }
});

test('records refund registry events without changing payment fulfillment', async () => {
  const context = setup();
  try {
    const order = await context.commerce.createOrder(context.admin, { variantId: 'variant', quantity: 1, idempotencyKey: 'refund-order' });
    context.commerce.markMockPaymentPaid(order.orderNo, context.admin.id);
    const payment = paymentRow(context.db, order.orderNo);
    const result = context.commerce.processWebhook({
      event_id: 'evt-refund',
      event_type: 'refund.recorded',
      data: {
        order_id: payment.provider_order_id,
        merchant_order_id: payment.merchant_order_id,
        status: 'recorded',
      },
    });
    assert.equal(result.processed, true);
    assert.equal(context.commerce.getOrderForUser(order.orderNo, context.admin.id).status, 'paid');
    assert.equal(context.db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'refund.recorded' AND entity_id = ?`).get(payment.local_order_id).count, 1);
    assert.equal(context.commerce.processJobs(5), 1);
    assert.equal(context.commerce.getOrderForUser(order.orderNo, context.admin.id).status, 'completed');
  } finally {
    context.close();
  }
});

test('replaces a reserved card that expires before payment confirmation', async () => {
  const context = setup();
  try {
    const order = await context.commerce.createOrder(context.admin, { variantId: 'variant', quantity: 1, idempotencyKey: 'expiry-card' });
    const payment = paymentRow(context.db, order.orderNo);
    const reserved = context.db.prepare(`SELECT id FROM card_credentials WHERE reserved_for_order_id = ?`).get(payment.local_order_id);
    context.db.prepare(`UPDATE card_credentials SET expires_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), reserved.id);
    context.commerce.markMockPaymentPaid(order.orderNo, context.admin.id);
    context.commerce.processJobs(5);
    const issued = context.db.prepare(`SELECT card_id FROM card_issuances WHERE order_id = ?`).get(payment.local_order_id);
    assert.notEqual(issued.card_id, reserved.id);
    assert.equal(context.db.prepare(`SELECT state FROM card_credentials WHERE id = ?`).get(reserved.id).state, 'disabled');
    assert.equal(context.commerce.getOrderForUser(order.orderNo, context.admin.id).status, 'completed');
  } finally {
    context.close();
  }
});

test('recovers a fulfillment job left locked by a crashed worker', async () => {
  const context = setup();
  try {
    const order = await context.commerce.createOrder(context.admin, { variantId: 'variant', quantity: 1, idempotencyKey: 'stale-job' });
    context.commerce.markMockPaymentPaid(order.orderNo, context.admin.id);
    const claimed = context.commerce.claimFulfillmentJob();
    assert.ok(claimed);
    context.db.prepare(`UPDATE fulfillment_jobs SET locked_at = ? WHERE id = ?`).run(new Date(Date.now() - 20 * 60_000).toISOString(), claimed.id);
    assert.equal(context.commerce.recoverStaleFulfillmentJobs(), 1);
    assert.equal(context.commerce.processJobs(5), 1);
    assert.equal(context.commerce.getOrderForUser(order.orderNo, context.admin.id).status, 'completed');
  } finally {
    context.close();
  }
});

test('handles an already-paid idempotent provider response atomically', async () => {
  const provider = {
    name: 'terminal-test',
    async createPayment(input) {
      return {
        provider: 'terminal-test',
        providerOrderId: 'provider-paid',
        merchantOrderId: input.merchantOrderId,
        status: 'paid',
        chain: 'tron',
        tokenId: 'tron-usdt',
        payableAmount: '19.90',
        fiatCurrency: 'CNY',
        fiatAmount: '19.90',
        paidAt: new Date().toISOString(),
        transactionId: 'tx-paid',
        checkoutUrl: null,
        expiresAt: null,
        raw: { status: 'paid' },
      };
    },
  };
  const context = setup(provider);
  try {
    const order = await context.commerce.createOrder(context.admin, { variantId: 'variant', quantity: 1, idempotencyKey: 'terminal-payment' });
    assert.equal(order.status, 'paid');
    assert.equal(context.commerce.processJobs(5), 1);
    assert.equal(context.commerce.getOrderForUser(order.orderNo, context.admin.id).status, 'completed');
  } finally {
    context.close();
  }
});

test('updates SKU pricing and rejects external product image URLs', () => {
  const context = setup();
  try {
    context.commerce.updateVariant(context.admin, 'variant', {
      name: 'Updated Variant',
      sku: 'SKU-UPDATED',
      priceFen: 2990,
      maxPerOrder: 2,
      isActive: false,
    });
    const variant = context.commerce.listAdminProducts()[0].variants[0];
    assert.equal(variant.name, 'Updated Variant');
    assert.equal(variant.priceFen, 2990);
    assert.equal(variant.maxPerOrder, 2);
    assert.equal(variant.isActive, false);
    assert.equal(context.commerce.listCatalog().length, 0);
    assert.throws(() => context.commerce.createProduct(context.admin, {
      title: 'External image',
      slug: 'external-image',
      imageUrl: 'https://example.com/tracker.png',
    }), (error) => error.code === 'invalid_request');
  } finally {
    context.close();
  }
});

test('rejects a pending provider session without embedded payment instructions', async () => {
  const provider = {
    name: 'external-only',
    async createPayment(input) {
      return {
        provider: 'external-only',
        providerOrderId: 'provider-external',
        merchantOrderId: input.merchantOrderId,
        status: 'pending',
        checkoutUrl: 'https://payments.example.com/checkout',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        raw: {},
      };
    },
  };
  const context = setup(provider);
  try {
    await assert.rejects(
      context.commerce.createOrder(context.admin, { variantId: 'variant', quantity: 1, idempotencyKey: 'external-only' }),
      (error) => error.code === 'invalid_payment_session' && /内嵌付款信息/.test(error.message),
    );
  } finally {
    context.close();
  }
});

test('creates a DujiaoPay order using the documented request contract', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({
      order_id: 'do_documented',
      chain: 'tron',
      token_id: 'tron-usdt',
      pay_address: 'TAddress',
      payable_amount: '19.9001',
      status: 'pending',
      expires_at: '2026-08-17T10:00:00Z',
      checkout_url: 'https://www.dujiaopay.com/checkout/ct_once',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const provider = new DujiaoPayProvider({
      baseUrl: 'https://www.dujiaopay.com',
      keyId: 'key-id',
      secret: 'request-secret',
      webhookSecret: 'webhook-secret',
      chain: 'tron',
      tokenId: 'tron-usdt',
    });
    const payment = await provider.createPayment({
      merchantOrderId: 'merchant-order-1',
      amountFen: 1990,
      metadata: { order_no: 'merchant-order-1' },
      successUrl: 'https://shop.example.com/success',
      cancelUrl: 'https://shop.example.com/cancel',
    });
    const body = JSON.parse(captured.options.body);
    assert.equal(captured.url, 'https://www.dujiaopay.com/v1/orders');
    assert.equal(captured.options.redirect, 'error');
    assert.equal(body.fiat_amount, '19.90');
    assert.equal(body.chain, 'tron');
    assert.equal(body.token_id, 'tron-usdt');
    assert.equal(payment.status, 'pending');
    assert.equal(payment.payableAmount, '19.9001');
    assert.deepEqual(payment.paymentInstructions, {
      mode: 'qr',
      method: 'crypto',
      label: 'USDT',
      amountUnit: 'USDT',
      network: 'TRON',
      qrContent: 'TAddress',
      address: 'TAddress',
    });
    const expected = signRequest({
      secret: 'request-secret',
      method: 'POST',
      path: '/v1/orders',
      body: captured.options.body,
      timestamp: Number(captured.options.headers['DJP-Timestamp']),
      nonce: captured.options.headers['DJP-Nonce'],
    });
    assert.equal(captured.options.headers['DJP-Signature'], expected);
    assert.equal(captured.options.headers['Idempotency-Key'], 'merchant-order-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('signs requests and verifies DujiaoPay webhooks over raw bytes', () => {
  const secret = 'request-secret';
  const signature = signRequest({
    secret,
    method: 'POST',
    path: '/v1/orders',
    rawQuery: 'z=2&a=2&a=1',
    body: '{"amount":"19.90"}',
    timestamp: 1700000000,
    nonce: 'nonce-1',
  });
  assert.match(signature, /^[a-f0-9]{64}$/);
  assert.equal(signature, signRequest({ secret, method: 'POST', path: '/v1/orders', rawQuery: 'a=1&a=2&z=2', body: '{"amount":"19.90"}', timestamp: 1700000000, nonce: 'nonce-1' }));

  const webhookSecret = 'webhook-secret';
  const event = { event_id: 'evt-signed', event_type: 'webhook.test', event_version: 'v1', created_at: new Date().toISOString(), data: {} };
  const rawBody = Buffer.from(JSON.stringify(event));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const webhookSignature = crypto.createHmac('sha256', webhookSecret).update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody])).digest('hex');
  const provider = new DujiaoPayProvider({ baseUrl: 'https://www.dujiaopay.com', keyId: 'key', secret, webhookSecret, chain: 'tron', tokenId: 'tron-usdt' });
  assert.deepEqual(provider.verifyWebhook(rawBody, {
    'djp-webhook-timestamp': timestamp,
    'djp-webhook-signature': webhookSignature,
    'djp-webhook-id': event.event_id,
  }), event);
  const unsupported = Buffer.from(JSON.stringify({ ...event, event_version: 'v2' }));
  const unsupportedSignature = crypto.createHmac('sha256', webhookSecret).update(Buffer.concat([Buffer.from(`${timestamp}.`), unsupported])).digest('hex');
  assert.throws(() => provider.verifyWebhook(unsupported, {
    'djp-webhook-timestamp': timestamp,
    'djp-webhook-signature': unsupportedSignature,
    'djp-webhook-id': event.event_id,
  }), /payload is invalid/);
  assert.throws(() => provider.verifyWebhook(Buffer.from(`${rawBody} `), {
    'djp-webhook-timestamp': timestamp,
    'djp-webhook-signature': webhookSignature,
    'djp-webhook-id': event.event_id,
  }), /signature verification failed/);
});
