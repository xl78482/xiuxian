import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../packages/core/database.js';

const now = '2026-08-18T00:00:00.000Z';

test('migration 5 cancels legacy mock orders and releases reserved cards', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-db-'));
  const databasePath = path.join(directory, 'test.sqlite');
  let db = openDatabase(databasePath);
  try {
    db.prepare(`INSERT INTO users (id, telegram_id, first_name, role, created_at, updated_at) VALUES (?, ?, ?, 'admin', ?, ?)`).run('legacy-user', '100000001', 'Legacy', now, now);
    db.prepare(`INSERT INTO categories (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run('cat', 'Test', 'test', now, now);
    db.prepare(`INSERT INTO products (id, category_id, title, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run('product', 'cat', 'Product', 'product', now, now);
    db.prepare(`INSERT INTO product_variants (id, product_id, name, sku, price_fen, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('variant', 'product', 'Variant', 'SKU-1', 1990, now, now);
    db.prepare(`INSERT INTO orders (id, order_no, user_id, product_id, variant_id, product_title_snapshot, variant_name_snapshot, quantity, unit_price_fen, total_price_fen, payment_deadline, client_request_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1990, 1990, ?, ?, ?, ?)`).run('order', 'XX20260818000000ABCDEF12', 'legacy-user', 'product', 'variant', 'Product', 'Variant', now, 'legacy-key', now, now);
    db.prepare(`INSERT INTO payment_transactions (id, order_id, provider, provider_order_id, merchant_order_id, idempotency_key, status, fiat_amount, created_at, updated_at) VALUES (?, ?, 'mock', ?, ?, ?, 'awaiting_payment', '19.90', ?, ?)`).run('payment', 'order', 'mock-provider-order', 'XX20260818000000ABCDEF12', 'legacy-key', now, now);
    db.prepare(`INSERT INTO card_credentials (id, variant_id, code_ciphertext, code_fingerprint, state, reserved_for_order_id, reserved_at, created_at) VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?)`).run('card', 'variant', 'cipher', 'fingerprint', 'order', now, now);
    db.prepare(`DELETE FROM schema_migrations WHERE version = 5`).run();
  } finally {
    db.close();
  }

  db = openDatabase(databasePath);
  try {
    const legacyUser = db.prepare(`SELECT role, telegram_id FROM users WHERE id = 'legacy-user'`).get();
    assert.equal(legacyUser.role, 'admin');
    assert.match(legacyUser.telegram_id, /^admin:legacy:/);
    assert.equal(db.prepare(`SELECT status FROM orders WHERE id = 'order'`).get().status, 'canceled');
    assert.equal(db.prepare(`SELECT status FROM payment_transactions WHERE id = 'payment'`).get().status, 'canceled');
    assert.equal(db.prepare(`SELECT state, reserved_for_order_id FROM card_credentials WHERE id = 'card'`).get().state, 'available');
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 5);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
