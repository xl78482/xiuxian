import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CommerceService } from '../packages/core/commerce.js';
import { UpstreamService, computeSignature } from '../packages/core/upstream.js';
import { makeTestPaymentProvider, markTestPaymentPaid } from './payment-helpers.js';
import { createCardCrypto } from '../packages/core/crypto.js';
import { openDatabase } from '../packages/core/database.js';

const cardKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-upstream-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const config = {
    appOrigin: 'http://localhost:3000',
    isProduction: false,
    paymentTtlMinutes: 15,
  };
  const provider = makeTestPaymentProvider();
  const cardCrypto = createCardCrypto(cardKey);
  const commerce = new CommerceService({ db, config, paymentProvider: provider, cardCrypto });
  const adminUser = commerce.upsertTelegramUser({ id: 100000001, first_name: 'Admin' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminUser.id);
  const admin = commerce.getUser(adminUser.id);
  const upstream = new UpstreamService({ db, config, cardCrypto, commerce });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO categories (id, name, slug, position, created_at, updated_at) VALUES ('cat', 'Test', 'test', 0, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO products (id, category_id, title, slug, status, created_at, updated_at) VALUES ('product', 'cat', 'Product', 'product', 'active', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO product_variants (id, product_id, name, sku, price_fen, max_per_order, created_at, updated_at) VALUES ('variant', 'product', 'Variant', 'SKU-1', 1990, 3, ?, ?)`).run(now, now);
  commerce.importCards(admin, { variantId: 'variant', batchLabel: 'batch', cards: [{ code: 'CARD-1' }, { code: 'CARD-2' }] });
  return {
    db,
    commerce,
    upstream,
    admin,
    cardCrypto,
    close() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function makeRequest({ method = 'POST', path: requestPath = '/api/v1/upstream/ping', body = '', secret, apiKey, timestamp }) {
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const signature = computeSignature(secret, method, requestPath, timestamp, bodyBuffer);
  return {
    method,
    url: requestPath,
    headers: {
      'dujiao-next-api-key': apiKey,
      'dujiao-next-timestamp': String(timestamp),
      'dujiao-next-signature': signature,
    },
  };
}

test('creates api credentials and authenticates signed upstream requests', () => {
  const ctx = setup();
  try {
    const credential = ctx.upstream.createApiCredential(ctx.admin, { label: 'partner' });
    assert.ok(credential.apiKey.startsWith('dj_'));
    assert.equal(credential.secret.length, 64);

    const timestamp = Math.floor(Date.now() / 1000);
    const request = makeRequest({
      method: 'POST',
      path: '/api/v1/upstream/ping',
      body: '',
      secret: credential.secret,
      apiKey: credential.apiKey,
      timestamp,
    });
    const auth = ctx.upstream.authenticateRequest(request, Buffer.alloc(0));
    assert.equal(auth.ownerUserId, ctx.admin.id);
  } finally {
    ctx.close();
  }
});

test('rejects requests with an invalid signature', () => {
  const ctx = setup();
  try {
    const credential = ctx.upstream.createApiCredential(ctx.admin, { label: 'partner' });
    const timestamp = Math.floor(Date.now() / 1000);
    const request = makeRequest({
      method: 'POST',
      path: '/api/v1/upstream/ping',
      body: '',
      secret: 'wrong-secret-that-does-not-match',
      apiKey: credential.apiKey,
      timestamp,
    });
    assert.throws(
      () => ctx.upstream.authenticateRequest(request, Buffer.alloc(0)),
      (error) => error.code === 'invalid_signature',
    );
  } finally {
    ctx.close();
  }
});

test('rejects requests with an expired timestamp', () => {
  const ctx = setup();
  try {
    const credential = ctx.upstream.createApiCredential(ctx.admin, { label: 'partner' });
    const request = makeRequest({
      method: 'POST',
      path: '/api/v1/upstream/ping',
      body: '',
      secret: credential.secret,
      apiKey: credential.apiKey,
      timestamp: Math.floor(Date.now() / 1000) - 300,
    });
    assert.throws(
      () => ctx.upstream.authenticateRequest(request, Buffer.alloc(0)),
      (error) => error.code === 'timestamp_expired',
    );
  } finally {
    ctx.close();
  }
});

test('lists and toggles api credentials', () => {
  const ctx = setup();
  try {
    ctx.upstream.createApiCredential(ctx.admin, { label: 'a' });
    ctx.upstream.createApiCredential(ctx.admin, { label: 'b' });
    const list = ctx.upstream.listApiCredentials();
    assert.equal(list.length, 2);
    ctx.upstream.setApiCredentialActive(list[0].id, false);
    const updated = ctx.upstream.listApiCredentials().find((item) => item.id === list[0].id);
    assert.equal(updated.isActive, false);
  } finally {
    ctx.close();
  }
});

test('creates and manages upstream connections', () => {
  const ctx = setup();
  try {
    const connection = ctx.upstream.createConnection(ctx.admin, {
      name: 'partner-b',
      baseUrl: 'https://b.example.com',
      apiKey: 'partner-key',
      apiSecret: 'partner-secret',
      callbackUrl: 'https://a.example.com/api/v1/upstream/callback',
    });
    assert.equal(connection.baseUrl, 'https://b.example.com');
    assert.ok(!connection.apiSecret, 'secret must not be returned');

    const list = ctx.upstream.listConnections();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'partner-b');

    ctx.upstream.setConnectionActive(connection.id, false);
    assert.equal(ctx.upstream.getConnection(connection.id).isActive, false);

    ctx.upstream.deleteConnection(connection.id);
    assert.equal(ctx.upstream.listConnections().length, 0);
  } finally {
    ctx.close();
  }
});

test('rejects invalid connection urls', () => {
  const ctx = setup();
  try {
    assert.throws(
      () => ctx.upstream.createConnection(ctx.admin, {
        name: 'bad',
        baseUrl: 'not-a-url',
        apiKey: 'k',
        apiSecret: 's',
      }),
      (error) => error.code === 'invalid_request',
    );
    assert.throws(
      () => ctx.upstream.createConnection(ctx.admin, {
        name: 'bad-callback',
        baseUrl: 'https://b.example.com',
        apiKey: 'k',
        apiSecret: 's',
        callbackUrl: 'javascript:alert(1)',
      }),
      (error) => error.code === 'invalid_callback_url',
    );
  } finally {
    ctx.close();
  }
});

test('refunds a completed order to balance with an entry', async () => {
  const ctx = setup();
  try {
    const buyer = ctx.commerce.upsertTelegramUser({ id: 200000001, first_name: 'Buyer' });
    const order = await ctx.commerce.createOrder(buyer, {
      variantId: 'variant',
      quantity: 1,
      idempotencyKey: 'refund-order-1',
    });
    markTestPaymentPaid(ctx.db, ctx.commerce, order.orderNo, buyer.id);

    // 处理已支付订单：手动完成（模拟发卡完成）
    const orderId = ctx.db.prepare('SELECT id FROM orders WHERE order_no = ?').get(order.orderNo).id;
    ctx.db.prepare("UPDATE orders SET status = 'completed', fulfillment_status = 'fulfilled', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), orderId);

    const before = ctx.commerce.getUser(buyer.id).balanceFen;
    assert.equal(before, 0);

    const result = ctx.commerce.refundOrderToBalance(ctx.admin, order.orderNo, { reason: '测试退款' });
    assert.equal(result.refundedFen, 1990);
    assert.equal(result.balanceAfterFen, 1990);

    const after = ctx.commerce.getUser(buyer.id).balanceFen;
    assert.equal(after, 1990);

    const entries = ctx.commerce.listBalanceEntries(buyer.id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'refund');
    assert.equal(entries[0].changeFen, 1990);

    const updated = ctx.db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
    assert.equal(updated.status, 'refunded');

    // 幂等：重复退款应拒绝
    assert.throws(
      () => ctx.commerce.refundOrderToBalance(ctx.admin, order.orderNo),
      (error) => error.code === 'refund_already_recorded',
    );
  } finally {
    ctx.close();
  }
});

test('rejects refund for unpaid or cancelable orders', async () => {
  const ctx = setup();
  try {
    const buyer = ctx.commerce.upsertTelegramUser({ id: 200000002, first_name: 'Buyer' });
    const order = await ctx.commerce.createOrder(buyer, {
      variantId: 'variant',
      quantity: 1,
      idempotencyKey: 'refund-order-2',
    });
    assert.throws(
      () => ctx.commerce.refundOrderToBalance(ctx.admin, order.orderNo),
      (error) => error.code === 'refund_not_allowed',
    );
  } finally {
    ctx.close();
  }
});

test('handles upstream callback for delivered orders', async () => {
  const ctx = setup();
  try {
    const buyer = ctx.commerce.upsertTelegramUser({ id: 200000003, first_name: 'Buyer' });
    const order = await ctx.commerce.createOrder(buyer, {
      variantId: 'variant',
      quantity: 1,
      idempotencyKey: 'callback-order-1',
    });
    const result = await ctx.upstream.handleUpstreamCallback({
      event: 'order.delivered',
      order_id: 101,
      order_no: 'DJ2026...',
      downstream_order_no: order.orderNo,
      status: 'delivered',
      fulfillment: { type: 'auto', status: 'delivered', payload: 'UPSTREAM-CARD-1' },
      timestamp: Math.floor(Date.now() / 1000),
    });
    assert.equal(result.status, 'completed');
    const row = ctx.db.prepare('SELECT status, fulfillment_status FROM orders WHERE order_no = ?').get(order.orderNo);
    assert.equal(row.status, 'completed');
    assert.equal(row.fulfillment_status, 'fulfilled');
  } finally {
    ctx.close();
  }
});

test('handles upstream callback for canceled orders', async () => {
  const ctx = setup();
  try {
    const buyer = ctx.commerce.upsertTelegramUser({ id: 200000004, first_name: 'Buyer' });
    const order = await ctx.commerce.createOrder(buyer, {
      variantId: 'variant',
      quantity: 1,
      idempotencyKey: 'callback-order-2',
    });
    const result = await ctx.upstream.handleUpstreamCallback({
      downstream_order_no: order.orderNo,
      status: 'canceled',
    });
    assert.equal(result.status, 'canceled');
    const row = ctx.db.prepare('SELECT status FROM orders WHERE order_no = ?').get(order.orderNo);
    assert.equal(row.status, 'canceled');
  } finally {
    ctx.close();
  }
});

test('rejects upstream callback with unknown order', async () => {
  const ctx = setup();
  try {
    await assert.rejects(
      () => ctx.upstream.handleUpstreamCallback({ downstream_order_no: 'XX9999', status: 'delivered' }),
      (error) => error.code === 'order_not_found',
    );
  } finally {
    ctx.close();
  }
});

test('authenticates signed callbacks against upstream connection credentials', async () => {
  const ctx = setup();
  try {
    const connection = ctx.upstream.createConnection(ctx.admin, {
      name: 'partner-b',
      baseUrl: 'https://b.example.com',
      apiKey: 'partner-callback-key',
      apiSecret: 'partner-callback-secret',
      callbackUrl: 'https://a.example.com/api/v1/upstream/callback',
    });
    assert.ok(connection.id);

    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v1/upstream/callback';
    const body = Buffer.from(JSON.stringify({ downstream_order_no: 'XX1', status: 'delivered' }));
    const signature = computeSignature('partner-callback-secret', 'POST', path, timestamp, body);
    const request = {
      method: 'POST',
      url: path,
      headers: {
        'dujiao-next-api-key': 'partner-callback-key',
        'dujiao-next-timestamp': String(timestamp),
        'dujiao-next-signature': signature,
      },
    };
    const auth = ctx.upstream.authenticateCallback(request, body);
    assert.ok(auth.connection);
    assert.equal(auth.connection.id, connection.id);

    // 错误签名应拒绝
    const badRequest = {
      method: 'POST',
      url: path,
      headers: {
        'dujiao-next-api-key': 'partner-callback-key',
        'dujiao-next-timestamp': String(timestamp),
        'dujiao-next-signature': 'f'.repeat(64),
      },
    };
    assert.throws(
      () => ctx.upstream.authenticateCallback(badRequest, body),
      (error) => error.code === 'invalid_signature',
    );

    // 无签名头时回退（返回 connection: null，不抛错）
    const noAuth = ctx.upstream.authenticateCallback({ method: 'POST', url: path, headers: {} }, body);
    assert.equal(noAuth.connection, null);
  } finally {
    ctx.close();
  }
});
