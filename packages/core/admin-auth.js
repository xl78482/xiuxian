import crypto from 'node:crypto';
import { nowIso, one, run, transaction } from './database.js';

function normalizeUsername(value) {
  if (typeof value !== 'string') return null;
  const username = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(username) ? username : null;
}

function passwordBytes(password) {
  return Buffer.from(String(password), 'utf8');
}

export function validateAdminUsername(value) {
  const username = normalizeUsername(value);
  if (!username) throw new Error('管理员账号必须是 3-64 位字母、数字、点、下划线或连字符。');
  return username;
}

export function validateAdminPassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 200) {
    throw new Error('管理员密码必须是 12-200 位。');
  }
  return value;
}

export function hashAdminPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(passwordBytes(password), salt, 32, { N: 16_384, r: 8, p: 1 });
  return `scrypt-v1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyAdminPassword(password, encoded) {
  if (typeof encoded !== 'string') return false;
  const [version, saltEncoded, hashEncoded] = encoded.split('$');
  if (version !== 'scrypt-v1' || !saltEncoded || !hashEncoded) return false;
  try {
    const expected = Buffer.from(hashEncoded, 'base64url');
    const actual = crypto.scryptSync(passwordBytes(password), Buffer.from(saltEncoded, 'base64url'), expected.length, { N: 16_384, r: 8, p: 1 });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function toAccount(row) {
  return row
    ? {
        id: row.id,
        username: row.username,
        isAdmin: true,
        firstName: row.username,
        telegramId: null,
      }
    : null;
}

export class AdminAccountStore {
  constructor(db) {
    this.db = db;
  }

  count() {
    return Number(one(this.db, 'SELECT COUNT(*) AS count FROM admin_accounts').count);
  }

  findByUsername(username) {
    return one(this.db, 'SELECT * FROM admin_accounts WHERE username = ? AND is_active = 1', username);
  }

  findById(id) {
    return toAccount(one(this.db, 'SELECT * FROM admin_accounts WHERE id = ? AND is_active = 1', id));
  }

  create(username, password) {
    const normalizedUsername = validateAdminUsername(username);
    const normalizedPassword = validateAdminPassword(password);
    const id = `adm_${crypto.randomUUID()}`;
    const now = nowIso();
    transaction(this.db, () => {
      run(
        this.db,
        `INSERT INTO users (id, telegram_id, username, first_name, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'admin', ?, ?)`,
        id,
        `admin:${id}`,
        normalizedUsername,
        normalizedUsername,
        now,
        now,
      );
      run(
        this.db,
        `INSERT INTO admin_accounts (id, username, password_hash, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
        id,
        normalizedUsername,
        hashAdminPassword(normalizedPassword),
        now,
        now,
      );
    });
    return this.findById(id);
  }

  authenticate(username, password) {
    if (typeof password !== 'string' || password.length > 200) return null;
    const normalizedUsername = normalizeUsername(username);
    const row = normalizedUsername ? this.findByUsername(normalizedUsername) : null;
    const fallback = row ?? one(this.db, 'SELECT password_hash FROM admin_accounts WHERE is_active = 1 LIMIT 1');
    const valid = fallback ? verifyAdminPassword(password, fallback.password_hash) : false;
    if (!row || !valid) return null;
    const now = nowIso();
    run(this.db, 'UPDATE admin_accounts SET last_login_at = ?, updated_at = ? WHERE id = ?', now, now, row.id);
    return toAccount(row);
  }

  update(id, { username, password }) {
    const current = one(this.db, 'SELECT * FROM admin_accounts WHERE id = ? AND is_active = 1', id);
    if (!current) throw new Error('管理员账号不存在。');
    const nextUsername = username === undefined ? current.username : validateAdminUsername(username);
    const nextPasswordHash = password === undefined ? current.password_hash : hashAdminPassword(validateAdminPassword(password));
    const now = nowIso();
    transaction(this.db, () => {
      run(
        this.db,
        'UPDATE admin_accounts SET username = ?, password_hash = ?, updated_at = ? WHERE id = ?',
        nextUsername,
        nextPasswordHash,
        now,
        id,
      );
      run(
        this.db,
        'UPDATE users SET username = ?, first_name = ?, updated_at = ? WHERE id = ?',
        nextUsername,
        nextUsername,
        now,
        id,
      );
    });
    return this.findById(id);
  }
}
