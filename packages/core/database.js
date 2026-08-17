import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const schema = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT,
  language_code TEXT,
  role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('customer', 'admin')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT NOT NULL UNIQUE,
  price_fen INTEGER NOT NULL CHECK(price_fen > 0),
  max_per_order INTEGER NOT NULL DEFAULT 5 CHECK(max_per_order BETWEEN 1 AND 20),
  position INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  variant_id TEXT NOT NULL REFERENCES product_variants(id),
  product_title_snapshot TEXT NOT NULL,
  variant_name_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 20),
  unit_price_fen INTEGER NOT NULL CHECK(unit_price_fen > 0),
  total_price_fen INTEGER NOT NULL CHECK(total_price_fen > 0),
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL DEFAULT 'pending_payment' CHECK(status IN ('pending_payment', 'payment_confirming', 'paid', 'fulfilling', 'completed', 'payment_expired', 'canceled', 'fulfillment_failed', 'refunded')),
  fulfillment_status TEXT NOT NULL DEFAULT 'pending' CHECK(fulfillment_status IN ('pending', 'processing', 'fulfilled', 'failed')),
  payment_deadline TEXT NOT NULL,
  client_request_key TEXT NOT NULL,
  fulfilled_at TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, client_request_key)
);
CREATE TABLE IF NOT EXISTS card_batches (
  id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  imported_by TEXT REFERENCES users(id),
  total_count INTEGER NOT NULL DEFAULT 0,
  valid_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS card_credentials (
  id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  batch_id TEXT REFERENCES card_batches(id) ON DELETE SET NULL,
  code_ciphertext TEXT NOT NULL,
  code_fingerprint TEXT NOT NULL UNIQUE,
  password_ciphertext TEXT,
  note_ciphertext TEXT,
  expires_at TEXT,
  state TEXT NOT NULL DEFAULT 'available' CHECK(state IN ('available', 'reserved', 'issued', 'disabled')),
  reserved_for_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  reserved_at TEXT,
  issued_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_transactions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_order_id TEXT UNIQUE,
  merchant_order_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK(status IN ('awaiting_payment', 'pending', 'confirming', 'paid', 'expired', 'canceled', 'failed', 'refunded')),
  fiat_amount TEXT NOT NULL,
  fiat_currency TEXT NOT NULL DEFAULT 'CNY',
  payable_amount TEXT,
  chain TEXT,
  token_id TEXT,
  pay_address TEXT,
  checkout_url TEXT,
  provider_expires_at TEXT,
  paid_at TEXT,
  transaction_id TEXT,
  provider_payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  processing_error TEXT,
  UNIQUE(provider, provider_event_id)
);
CREATE TABLE IF NOT EXISTS fulfillment_jobs (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL,
  locked_at TEXT,
  last_error TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS card_issuances (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL UNIQUE REFERENCES card_credentials(id) ON DELETE RESTRICT,
  issued_at TEXT NOT NULL,
  UNIQUE(order_id, card_id)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_available ON card_credentials(variant_id, state, expires_at);
CREATE INDEX IF NOT EXISTS idx_cards_order ON card_credentials(reserved_for_order_id, state);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_expiry ON orders(status, payment_deadline);
CREATE INDEX IF NOT EXISTS idx_fulfillment_ready ON fulfillment_jobs(status, run_after);
CREATE INDEX IF NOT EXISTS idx_payments_provider ON payment_transactions(provider, provider_order_id);
`;

export function nowIso() {
  return new Date().toISOString();
}

export function openDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const migrations = [
    { version: 1, sql: schema },
    {
      version: 2,
      sql: `ALTER TABLE payment_transactions
            ADD COLUMN payment_instructions TEXT NOT NULL DEFAULT '{}';`,
    },
    {
      version: 3,
      sql: `CREATE TABLE IF NOT EXISTS admin_accounts (
              id TEXT PRIMARY KEY,
              username TEXT NOT NULL UNIQUE,
              password_hash TEXT NOT NULL,
              is_active INTEGER NOT NULL DEFAULT 1,
              last_login_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS app_settings (
              key TEXT PRIMARY KEY,
              value_ciphertext TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );`,
    },
    {
      version: 4,
      sql: `ALTER TABLE users ADD COLUMN photo_url TEXT;
            ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
            INSERT OR IGNORE INTO users (id, telegram_id, username, first_name, role, created_at, updated_at)
            SELECT id, 'admin:' || id, username, username, 'admin', created_at, updated_at
            FROM admin_accounts;`,
    },
    {
      version: 5,
      sql: `UPDATE users
            SET telegram_id = 'admin:legacy:' || id
            WHERE role = 'admin' AND telegram_id NOT LIKE 'admin:%';
            UPDATE card_credentials
            SET state = 'available', reserved_for_order_id = NULL, reserved_at = NULL
            WHERE state = 'reserved' AND reserved_for_order_id IN (
              SELECT o.id
              FROM orders o JOIN payment_transactions pt ON pt.order_id = o.id
              WHERE pt.provider = 'mock'
                AND pt.status IN ('awaiting_payment', 'pending', 'confirming')
                AND o.status IN ('pending_payment', 'payment_confirming')
            );
            UPDATE orders
            SET status = 'canceled',
                failure_reason = '本地测试支付已停用，请重新下单。',
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ')
            WHERE id IN (
              SELECT o.id
              FROM orders o JOIN payment_transactions pt ON pt.order_id = o.id
              WHERE pt.provider = 'mock'
                AND pt.status IN ('awaiting_payment', 'pending', 'confirming')
                AND o.status IN ('pending_payment', 'payment_confirming')
            );
            UPDATE payment_transactions
            SET status = 'canceled',
                provider_payload = '{"migration":"mock_payment_disabled"}',
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ')
            WHERE provider = 'mock' AND status IN ('awaiting_payment', 'pending', 'confirming')
              AND order_id IN (
                SELECT id FROM orders WHERE status = 'canceled'
              );`,
    },
  ];
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row.version)));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      const alreadyApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(migration.version);
      if (!alreadyApplied) {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, nowIso());
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  return db;
}

export function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function one(db, sql, ...params) {
  return db.prepare(sql).get(...params) ?? null;
}

export function many(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}

export function json(value) {
  return JSON.stringify(value ?? {});
}

export function parseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
