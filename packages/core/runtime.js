import { loadConfig } from './config.js';
import { createCardCrypto } from './crypto.js';
import { openDatabase } from './database.js';
import { CommerceService, makeMockPaymentProvider } from './commerce.js';
import { DujiaoPayProvider } from '../payment/dujiaopay.js';

export function createRuntime(rootDirectory = process.cwd()) {
  const config = loadConfig(rootDirectory);
  const db = openDatabase(config.databasePath);
  const paymentProvider =
    config.paymentProvider === 'dujiaopay'
      ? new DujiaoPayProvider(config.dujiaopay)
      : makeMockPaymentProvider(config.appOrigin);
  const commerce = new CommerceService({
    db,
    config,
    paymentProvider,
    cardCrypto: createCardCrypto(config.cardEncryptionKey),
  });
  return { config, db, paymentProvider, commerce };
}
