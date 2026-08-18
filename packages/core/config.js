import fs from 'node:fs';
import path from 'node:path';
import { normalizeDujiaoPayConfig, validateDujiaoPayConfig } from '../payment/config.js';

function loadEnvFile(filename) {
  if (!fs.existsSync(filename)) return;
  for (const rawLine of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function loadConfig(rootDirectory = process.cwd()) {
  loadEnvFile(path.join(rootDirectory, '.env'));
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(rootDirectory, 'package.json'), 'utf8'));
  const appVersion = packageMetadata.version;
  if (typeof appVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(appVersion)) {
    throw new Error('package.json version must use MAJOR.MINOR.PATCH format.');
  }
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const paymentProvider = process.env.PAYMENT_PROVIDER ?? 'dujiaopay';
  if (paymentProvider !== 'dujiaopay') {
    throw new Error('PAYMENT_PROVIDER must be dujiaopay.');
  }

  const sessionSecret = required('SESSION_SECRET');
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');

  const cardEncryptionKey = required('CARD_ENCRYPTION_KEY');
  if (!/^[a-fA-F0-9]{64}$/.test(cardEncryptionKey)) {
    throw new Error('CARD_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters.');
  }

  const config = {
    rootDirectory,
    appVersion,
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port: Number(process.env.PORT ?? 3000),
    appOrigin: process.env.APP_ORIGIN ?? 'http://localhost:3000',
    databasePath: path.resolve(rootDirectory, process.env.DATABASE_PATH ?? './data/xiuxian.sqlite'),
    sessionSecret,
    cardEncryptionKey,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    supportUrl: process.env.SUPPORT_URL ?? '',
    trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? ''),
    paymentProvider,
    paymentTtlMinutes: Number(process.env.ORDER_PAYMENT_TTL_MINUTES ?? 15),
    dujiaopay: normalizeDujiaoPayConfig({
      baseUrl: process.env.DUJIAOPAY_BASE_URL,
      keyId: process.env.DUJIAOPAY_KEY_ID,
      secret: process.env.DUJIAOPAY_SECRET,
      webhookSecret: process.env.DUJIAOPAY_WEBHOOK_SECRET,
      chain: process.env.DUJIAOPAY_CHAIN,
      tokenId: process.env.DUJIAOPAY_TOKEN_ID,
      ttlMinutes: process.env.ORDER_PAYMENT_TTL_MINUTES,
    }),
  };

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('PORT must be a valid TCP port.');
  }
  let appUrl;
  try {
    appUrl = new URL(config.appOrigin);
  } catch {
    throw new Error('APP_ORIGIN must be an absolute URL.');
  }
  if (config.isProduction && appUrl.protocol !== 'https:') {
    throw new Error('APP_ORIGIN must use HTTPS in production.');
  }
  try {
    config.dujiaopay = validateDujiaoPayConfig(config.dujiaopay, { production: config.isProduction });
    config.paymentTtlMinutes = config.dujiaopay.ttlMinutes;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'DujiaoPay configuration is invalid.');
  }
  if (config.supportUrl) {
    try {
      const supportUrl = new URL(config.supportUrl);
      if (!['https:', 'tg:'].includes(supportUrl.protocol)) throw new Error('unsupported protocol');
    } catch {
      throw new Error('SUPPORT_URL must be a valid https:// or tg:// URL.');
    }
  }
  return config;
}
