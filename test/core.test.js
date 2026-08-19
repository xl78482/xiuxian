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

test('adjusts user balance with audit trail and guards negative totals', () => {
  const { db, commerce, admin, directory } = setup();
  try {
    const buyer = commerce.upsertTelegramUser({ id: 300000001, first_name: 'Balance', username: 'balance_user' });
    assert.equal(buyer.balanceFen, 0);

    // 管理员加款
    const credited = commerce.adjustUserBalance(admin, buyer.id, 5000, { memo: '人工充值' });
    assert.equal(credited.balanceFen, 5000);

    // 再减款后余额正确
    const debited = commerce.adjustUserBalance(admin, buyer.id, -1500, { memo: '扣减' });
    assert.equal(debited.balanceFen, 3500);

    // 流水记录
    const entries = commerce.listBalanceEntries(buyer.id);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].changeFen, -1500);
    assert.equal(entries[0].balanceAfterFen, 3500);
    assert.equal(entries[1].changeFen, 5000);

    // 余额不足应拒绝
    assert.throws(() => commerce.adjustUserBalance(admin, buyer.id, -99999), /余额不足/);

    // 审计日志
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action LIKE 'balance.%'").get().count, 2);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('recharges balance via payment provider and credits idempotently', async () => {
  const { db, commerce, admin, directory } = setup();
  try {
    const buyer = commerce.upsertTelegramUser({ id: 400000001, first_name: 'Recharge', username: 'recharge_user' });
    assert.equal(buyer.balanceFen, 0);

    // 创建充值会话（测试渠道返回内嵌付款信息）
    const recharge = await commerce.createRecharge(buyer, { amountFen: 10000, idempotencyKey: 'recharge-request-001' });
    assert.equal(recharge.amountFen, 10000);
    assert.equal(recharge.status, 'pending_payment');
    assert.ok(recharge.payment?.paymentInstructions?.qrContent);
    const rechargeNo = recharge.rechargeNo;
    assert.match(rechargeNo, /^RC/);

    // 重复创建同一幂等键应返回同一充值
    const dup = await commerce.createRecharge(buyer, { amountFen: 10000, idempotencyKey: 'recharge-request-001' });
    assert.equal(dup.rechargeNo, rechargeNo);

    // 模拟到账回调 → 入账
    const paymentRow = db.prepare('SELECT * FROM recharge_payments WHERE merchant_order_id = ?').get(rechargeNo);
    const payArgs = {
      providerStatus: 'paid',
      providerOrderId: paymentRow.provider_order_id,
      merchantOrderId: rechargeNo,
      chain: 'tron',
      tokenId: 'tron-usdt',
      payableAmount: '100.00',
      paidAt: new Date().toISOString(),
      transactionId: 'tx-1',
      payload: { test_only: true },
    };
    await commerce.applyRechargeProviderStatus(null, payArgs);
    let refreshed = commerce.getUser(buyer.id);
    assert.equal(refreshed.balanceFen, 10000);
    const entries = commerce.listBalanceEntries(buyer.id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'recharge');
    assert.equal(entries[0].changeFen, 10000);

    // 重复 paid 回调应幂等，不重复入账
    await commerce.applyRechargeProviderStatus(null, payArgs);
    refreshed = commerce.getUser(buyer.id);
    assert.equal(refreshed.balanceFen, 10000, '重复回调不应重复入账');
    assert.equal(commerce.listBalanceEntries(buyer.id).length, 1);
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

test('公开分类接口返回启用分类（含空分类，不依赖在售商品）', () => {
  const { db, commerce, admin, directory } = setup();
  try {
    const now = new Date().toISOString();
    // 空分类（无商品）：应出现在公开分类中
    db.prepare(`INSERT INTO categories (id, name, slug, position, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`).run('cat-empty', '空分类', 'empty', now, now);
    // 停用分类：不应出现在公开分类中
    db.prepare(`INSERT INTO categories (id, name, slug, position, is_active, created_at, updated_at) VALUES (?, ?, ?, 2, 0, ?, ?)`).run('cat-disabled', '停用分类', 'disabled', now, now);

    const publicCategories = commerce.listPublicCategories();
    const names = publicCategories.map((item) => item.name);
    assert.ok(names.includes('Test'), '有商品的启用分类应返回');
    assert.ok(names.includes('空分类'), '空分类也应返回，便于买家端分类栏展示');
    assert.ok(!names.includes('停用分类'), '停用分类不应返回');
    assert.ok(publicCategories.every((item) => !('productCount' in item)), '公开分类不应包含后台字段');

    // 管理端分类列表应包含全部（含停用）并带商品数
    const adminCategories = commerce.listCategories();
    assert.equal(adminCategories.length, 3);
    const testCategory = adminCategories.find((item) => item.slug === 'test');
    assert.equal(testCategory.productCount, 1);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

