import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../packages/core/database.js';
import { createCardCrypto } from '../packages/core/crypto.js';
import { CommerceService, makeMockPaymentProvider } from '../packages/core/commerce.js';

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-test-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const config = {
    appOrigin: 'http://localhost:3000',
    paymentTtlMinutes: 15,
    adminTelegramIds: new Set(['100000001']),
  };
  const commerce = new CommerceService({
    db,
    config,
    paymentProvider: makeMockPaymentProvider(config.appOrigin),
    cardCrypto: createCardCrypto('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
  });
  const admin = commerce.upsertTelegramUser({ id: 100000001, first_name: 'Admin', username: 'admin' });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO categories (id, name, slug, position, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`).run('cat-test', 'Test', 'test', now, now);
  db.prepare(`INSERT INTO products (id, category_id, title, slug, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`).run('prd-test', 'cat-test', 'Test product', 'test-product', now, now);
  db.prepare(`INSERT INTO product_variants (id, product_id, name, sku, price_fen, max_per_order, created_at, updated_at) VALUES (?, ?, ?, ?, 1990, 3, ?, ?)`).run('sku-test', 'prd-test', 'Test SKU', 'TEST-1', now, now);
  commerce.importCards(admin, { variantId: 'sku-test', batchLabel: 'test-batch', cards: [{ code: 'SECRET-CODE-1', password: 'PW-1' }, { code: 'SECRET-CODE-2' }] });
  return { db, commerce, admin, directory };
}

test('creates an order, preserves idempotency, and issues encrypted cards once', async () => {
  const { db, commerce, admin, directory } = setup();
  try {
    const [first, second] = await Promise.all([
      commerce.createOrder(admin, { variantId: 'sku-test', quantity: 1, idempotencyKey: 'request-001' }),
      commerce.createOrder(admin, { variantId: 'sku-test', quantity: 1, idempotencyKey: 'request-001' }),
    ]);
    assert.equal(first.orderNo, second.orderNo);
    assert.equal(first.status, 'pending_payment');
    assert.equal(commerce.markMockPaymentPaid(first.orderNo, admin.id), true);
    assert.equal(commerce.processJobs(5), 1);
    const order = commerce.getOrderForUser(first.orderNo, admin.id);
    assert.equal(order.status, 'completed');
    assert.equal(order.cards.length, 1);
    assert.match(order.cards[0].code, /^SECRET-CODE-/);
    const orderId = db.prepare('SELECT id FROM orders WHERE order_no = ?').get(first.orderNo).id;
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM card_issuances WHERE order_id = ?').get(orderId).count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM card_credentials WHERE state = 'available'").get().count, 1);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('does not expose stored card plaintext in the database', async () => {
  const { db, commerce, admin, directory } = setup();
  try {
    const stored = db.prepare('SELECT code_ciphertext FROM card_credentials LIMIT 1').get();
    assert.notEqual(stored.code_ciphertext, 'SECRET-CODE-1');
    assert.match(stored.code_ciphertext, /^v1\./);
    const order = await commerce.createOrder(admin, {
      variantId: 'sku-test',
      quantity: 1,
      idempotencyKey: 'request-002',
    });
    commerce.markMockPaymentPaid(order.orderNo, admin.id);
    commerce.processJobs(5);
    assert.equal(commerce.getOrderForUser(order.orderNo, admin.id).cards.length, 1);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
