import { loadConfig } from './config.js';
import { AdminAccountStore } from './admin-auth.js';
import { createCardCrypto } from './crypto.js';
import { openDatabase } from './database.js';
import { SettingsStore } from './settings.js';
import { CommerceService } from './commerce.js';
import { UpstreamService } from './upstream.js';
import { DujiaoPayProvider } from '../payment/dujiaopay.js';
import { normalizeDujiaoPayConfig, validateDujiaoPayConfig } from '../payment/config.js';

export function createRuntime(rootDirectory = process.cwd()) {
  const config = loadConfig(rootDirectory);
  const db = openDatabase(config.databasePath);
  const cardCrypto = createCardCrypto(config.cardEncryptionKey);
  const settings = new SettingsStore(db, cardCrypto);
  const adminAccounts = new AdminAccountStore(db);
  const configuredBotToken = settings.getTelegramBotToken();
  if (configuredBotToken) config.telegramBotToken = configuredBotToken;
  const storedPaymentConfig = settings.getPaymentConfig();
  if (storedPaymentConfig) {
    const mergedPaymentConfig = normalizeDujiaoPayConfig(storedPaymentConfig, config.dujiaopay);
    config.dujiaopay = validateDujiaoPayConfig(mergedPaymentConfig, {
      production: config.isProduction,
    });
    config.paymentTtlMinutes = config.dujiaopay.ttlMinutes;
  }
  if (adminAccounts.count() === 0) {
    const username = process.env.ADMIN_USERNAME ?? '';
    const password = process.env.ADMIN_PASSWORD ?? '';
    if (username && password) adminAccounts.create(username, password);
  }
  if (adminAccounts.count() === 0) {
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD are required to initialize the first admin account.');
  }
  const paymentProvider = new DujiaoPayProvider(config.dujiaopay);
  const refreshPaymentConfig = (overrides = {}, options = {}) => {
    const candidate = normalizeDujiaoPayConfig(overrides, config.dujiaopay);
    const next = validateDujiaoPayConfig(candidate, {
      production: config.isProduction,
      requireComplete: options.requireComplete ?? candidate.enabled,
    });
    config.dujiaopay = next;
    config.paymentTtlMinutes = next.ttlMinutes;
    paymentProvider.updateConfig(next);
    return next;
  };
  const reloadPaymentConfig = () => {
    const stored = settings.getPaymentConfig();
    if (!stored) return config.dujiaopay;
    const merged = normalizeDujiaoPayConfig(stored, config.dujiaopay);
    return refreshPaymentConfig(merged, { requireComplete: false });
  };
  const commerce = new CommerceService({
    db,
    config,
    paymentProvider,
    cardCrypto,
  });
  const upstream = new UpstreamService({
    db,
    config,
    cardCrypto,
    commerce,
  });
  return { config, db, settings, adminAccounts, paymentProvider, commerce, upstream, refreshPaymentConfig, reloadPaymentConfig };
}
