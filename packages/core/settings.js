import { one, run, nowIso } from './database.js';

const TELEGRAM_BOT_TOKEN_KEY = 'telegram_bot_token';

export class SettingsStore {
  constructor(db, secretCrypto) {
    this.db = db;
    this.secretCrypto = secretCrypto;
  }

  get(key) {
    const row = one(this.db, 'SELECT value_ciphertext FROM app_settings WHERE key = ?', key);
    if (!row) return null;
    try {
      return this.secretCrypto.decrypt(row.value_ciphertext);
    } catch {
      throw new Error(`设置 ${key} 无法解密，请检查 CARD_ENCRYPTION_KEY。`);
    }
  }

  set(key, value) {
    const ciphertext = this.secretCrypto.encrypt(value);
    const now = nowIso();
    run(
      this.db,
      `INSERT INTO app_settings (key, value_ciphertext, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_ciphertext = excluded.value_ciphertext, updated_at = excluded.updated_at`,
      key,
      ciphertext,
      now,
    );
    return now;
  }

  getMetadata(key) {
    const row = one(this.db, 'SELECT updated_at FROM app_settings WHERE key = ?', key);
    return { configured: Boolean(row), updatedAt: row?.updated_at ?? null };
  }

  getTelegramBotToken() {
    return this.get(TELEGRAM_BOT_TOKEN_KEY);
  }

  getTelegramBotTokenMetadata() {
    return this.getMetadata(TELEGRAM_BOT_TOKEN_KEY);
  }

  setTelegramBotToken(token) {
    return this.set(TELEGRAM_BOT_TOKEN_KEY, token);
  }

  isTelegramBotTokenConfigured() {
    return Boolean(this.getTelegramBotToken());
  }
}

export { TELEGRAM_BOT_TOKEN_KEY };
