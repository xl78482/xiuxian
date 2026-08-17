import { loadConfig } from './config.js';
import { AdminAccountStore } from './admin-auth.js';
import { createCardCrypto } from './crypto.js';
import { openDatabase } from './database.js';
import { SettingsStore } from './settings.js';
import { CommerceService } from './commerce.js';
import { DujiaoPayProvider } from '../payment/dujiaopay.js';

export function createRuntime(rootDirectory = process.cwd()) {
  const config = loadConfig(rootDirectory);
  const db = openDatabase(config.databasePath);
  const cardCrypto = createCardCrypto(config.cardEncryptionKey);
  const settings = new SettingsStore(db, cardCrypto);
  const adminAccounts = new AdminAccountStore(db);
  const configuredBotToken = settings.getTelegramBotToken();
  if (configuredBotToken) config.telegramBotToken = configuredBotToken;
  if (adminAccounts.count() === 0) {
    const username = process.env.ADMIN_USERNAME ?? '';
    const password = process.env.ADMIN_PASSWORD ?? '';
    if (username && password) adminAccounts.create(username, password);
  }
  if (adminAccounts.count() === 0) {
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD are required to initialize the first admin account.');
  }
  const paymentProvider = new DujiaoPayProvider(config.dujiaopay);
  const commerce = new CommerceService({
    db,
    config,
    paymentProvider,
    cardCrypto,
  });
  return { config, db, settings, adminAccounts, paymentProvider, commerce };
}
