import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../packages/core/database.js';
import { createCardCrypto } from '../packages/core/crypto.js';
import { CommerceService } from '../packages/core/commerce.js';
import { makeTestPaymentProvider, markTestPaymentPaid } from './payment-helpers.js';

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-test-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  const config = {
    appOrigin: 'http://localhost:3000',
    paymentTtlMinutes: 15,
  };
  const commerce = new CommerceService({
    db,
    config,
    paymentProvider: makeTestPaymentProvider(),
    cardCrypto: createCardCrypto('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
  });
  const adminUser = commerce.upsertTelegramUser({ id: 100000001, first_name: 'Admin', username: 'admin' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminUser.id);
  const admin = commerce.getUser(adminUser.id);
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
    assert.equal(markTestPaymentPaid(db, commerce, first.orderNo, admin.id), true);
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

test('stores Telegram profiles and manages buyer status with order metrics', async () => {
  const { db, commerce, admin, directory } = setup();
  try {
    const buyer = commerce.upsertTelegramUser({
      id: 200000001,
      first_name: 'Buyer',
      last_name: 'Example',
      username: 'buyer_example',
      language_code: 'zh-hans',
      photo_url: 'https://t.me/i/userpic/320/example.jpg',
    });
    assert.equal(buyer.photoUrl, 'https://t.me/i/userpic/320/example.jpg');
    assert.equal(buyer.lastName, 'Example');
    assert.equal(buyer.isActive, true);
    const order = await commerce.createOrder(buyer, { variantId: 'sku-test', quantity: 1, idempotencyKey: 'buyer-profile-order' });
    markTestPaymentPaid(db, commerce, order.orderNo, buyer.id);
    commerce.processJobs(5);
    const summary = commerce.listAdminUsers().find((user) => user.id === buyer.id);
    assert.equal(commerce.listAdminUsers().some((user) => user.id === admin.id), false);
    assert.equal(summary.orderCount, 1);
    assert.equal(summary.paidOrderCount, 1);
    assert.equal(summary.spentFen, 1990);
    assert.equal(commerce.updateUserStatus(admin, buyer.id, false).isActive, false);
    assert.equal(commerce.listAdminUsers().find((user) => user.id === buyer.id).isActive, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'user.disabled' AND entity_id = ?").get(buyer.id).count, 1);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('generates a unique slug automatically when slug is left empty', () => {
  const { db, commerce, admin, directory } = setup();
  try {
    // 分类 slug 留空时按名称自动生成
    const cat = commerce.createCategory(admin, { name: '我的_软件 Class' });
    assert.match(cat.slug, /^[a-z0-9-]+$/);
    assert.ok(cat.slug.length > 0);
    // 同名分类不应冲突
    const cat2 = commerce.createCategory(admin, { name: '我的_软件 Class' });
    assert.notEqual(cat2.slug, cat.slug);

    // 商品 slug 留空时按标题自动生成
    const prod = commerce.createProduct(admin, { title: 'Stream Pass 年度会员', status: 'draft' });
    assert.match(prod.slug, /^[a-z0-9-]+$/);
    assert.ok(prod.slug.length > 0);
    // 同名商品 slug 也能去重
    const prod2 = commerce.createProduct(admin, { title: 'Stream Pass 年度会员', status: 'draft' });
    assert.notEqual(prod2.slug, prod.slug);

    // 商品更新时 slug 留空：按新标题重新生成，并避开自身已有 slug
    const updated = commerce.updateProduct(admin, prod.id, { title: 'Stream Plus 年费', slug: '' });
    const stored = db.prepare('SELECT slug FROM products WHERE id = ?').get(prod.id);
    assert.equal(stored.slug, updated.slug);
    assert.match(updated.slug, /^[a-z0-9-]+$/);
    assert.notEqual(updated.slug, prod.slug);
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
    markTestPaymentPaid(db, commerce, order.orderNo, admin.id);
    commerce.processJobs(5);
    assert.equal(commerce.getOrderForUser(order.orderNo, admin.id).cards.length, 1);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
