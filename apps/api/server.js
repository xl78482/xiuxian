import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../packages/core/runtime.js';
import { AuthError, createSessionToken, verifySessionToken, verifyTelegramInitData } from '../../packages/core/crypto.js';
import { DomainError } from '../../packages/core/commerce.js';
import { PaymentProviderError } from '../../packages/payment/index.js';
import { maskSecret } from '../../packages/payment/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = createRuntime(root);
const { config, commerce, paymentProvider, settings, adminAccounts, refreshPaymentConfig } = runtime;

const requestCounts = new Map();
let lastRateLimitCleanup = 0;
const JSON_LIMIT = 1024 * 1024;
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' https://telegram.org https://*.telegram.org",
    "connect-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
  ].join('; ');
}

function setBaseHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Content-Security-Policy', contentSecurityPolicy());
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  setBaseHeaders(response);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

function sendError(response, error, requestId) {
  if (error instanceof DomainError || error instanceof PaymentProviderError || error instanceof AuthError) {
    return sendJson(response, error.status, { error: { code: error.code, message: error.message, requestId } });
  }
  if (error && typeof error === 'object' && String(error.code ?? '').includes('SQLITE_CONSTRAINT')) {
    return sendJson(response, 409, { error: { code: 'resource_conflict', message: 'Slug、SKU 或卡密已存在，请使用其他值。', requestId } });
  }
  if (error instanceof SyntaxError) {
    return sendJson(response, 400, { error: { code: 'invalid_json', message: '请求 JSON 格式无效。', requestId } });
  }
  console.error(JSON.stringify({ requestId, error: error instanceof Error ? error.stack : String(error) }));
  return sendJson(response, 500, {
    error: {
      code: 'internal_error',
      message: config.isProduction ? '服务暂时不可用，请稍后重试。' : String(error?.message ?? error),
      requestId,
    },
  });
}

function safeJoin(baseDirectory, relativePath) {
  const destination = path.resolve(baseDirectory, relativePath);
  return destination.startsWith(baseDirectory + path.sep) || destination === baseDirectory ? destination : null;
}

function serveFile(response, baseDirectory, relativePath) {
  const target = safeJoin(baseDirectory, relativePath);
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
  const content = fs.readFileSync(target);
  setBaseHeaders(response);
  const extension = path.extname(target).toLowerCase();
  const cacheControl = ['.html', '.js', '.css'].includes(extension)
    ? 'no-cache'
    : 'public, max-age=86400, immutable';
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': cacheControl,
  });
  response.end(content);
  return true;
}

async function readBody(request, maxBytes = JSON_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new DomainError('请求体过大。', 'payload_too_large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const raw = await readBody(request);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
}

function getBearerToken(request) {
  const authorization = request.headers.authorization;
  if (!authorization || !authorization.startsWith('Bearer ')) return null;
  return authorization.slice(7).trim();
}

function requireIdentity(request) {
  const token = verifySessionToken(getBearerToken(request), config.sessionSecret);
  if (!token) {
    const identity = telegramIdentityFromHeader(request);
    if (identity) return { token: { kind: 'user', userId: identity.id }, identity };
    throw new DomainError('登录状态已失效，请重新登录。', 'unauthenticated', 401);
  }
  const identity = token.kind === 'admin'
    ? adminAccounts.findById(token.userId)
    : commerce.getUser(token.userId);
  if (!identity) {
    const refreshedIdentity = telegramIdentityFromHeader(request);
    if (refreshedIdentity) return { token: { kind: 'user', userId: refreshedIdentity.id }, identity: refreshedIdentity };
    throw new DomainError('登录状态已失效，请重新登录。', 'unauthenticated', 401);
  }
  if (token.kind === 'user' && !identity.isActive) throw new DomainError('当前账号已停用，请联系售后。', 'user_disabled', 403);
  return { token, identity };
}

function requireUser(request) {
  const { token, identity } = requireIdentity(request);
  if (token.kind !== 'user') throw new DomainError('管理员会话不能执行买家操作。', 'forbidden', 403);
  if (!identity.isActive) throw new DomainError('当前账号已停用，请联系售后。', 'user_disabled', 403);
  return identity;
}

function requireAdmin(request) {
  const token = verifySessionToken(getBearerToken(request), config.sessionSecret);
  if (!token) throw new DomainError('后台会话已失效，请重新登录。', 'admin_unauthenticated', 401);
  if (token.kind !== 'admin') throw new DomainError('请使用管理员账号密码登录后台。', 'forbidden', 403);
  const account = adminAccounts.findById(token.userId);
  if (!account) throw new DomainError('后台会话已失效，请重新登录。', 'admin_unauthenticated', 401);
  return account;
}

function requireIdempotencyKey(request) {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new DomainError('缺少有效的 Idempotency-Key。', 'invalid_request', 422);
  }
  return value;
}

function requestAddress(request) {
  const directAddress = request.socket.remoteAddress ?? 'unknown';
  if (!config.trustProxy) return directAddress;
  const forwarded = request.headers['x-forwarded-for'];
  const candidate = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
  return isIP(candidate) ? candidate : directAddress;
}

function checkRateLimit(request, response, limit = 120, windowMs = 60_000) {
  const now = Date.now();
  if (now - lastRateLimitCleanup >= 60_000) {
    for (const [key, value] of requestCounts) {
      if (now - value.startedAt > Math.max(windowMs * 2, 300_000)) requestCounts.delete(key);
    }
    lastRateLimitCleanup = now;
  }
  const address = requestAddress(request);
  const key = `${address}:${new URL(request.url, config.appOrigin).pathname}`;
  const state = requestCounts.get(key) ?? { startedAt: now, count: 0 };
  if (now - state.startedAt >= windowMs) {
    state.startedAt = now;
    state.count = 0;
  }
  state.count += 1;
  requestCounts.set(key, state);
  if (state.count > limit) {
    sendJson(response, 429, { error: { code: 'rate_limited', message: '请求过于频繁，请稍后再试。' } });
    return false;
  }
  return true;
}

function telegramBotToken() {
  return settings.getTelegramBotToken() ?? config.telegramBotToken;
}

function telegramBotTokenStatus() {
  const storedToken = settings.getTelegramBotToken();
  const metadata = settings.getTelegramBotTokenMetadata();
  const environmentToken = config.telegramBotToken;
  return {
    telegramBotTokenConfigured: Boolean(storedToken || environmentToken),
    telegramBotTokenStored: Boolean(storedToken),
    telegramBotTokenSource: storedToken ? 'database' : environmentToken ? 'environment' : 'none',
    telegramBotTokenUpdatedAt: metadata.updatedAt,
  };
}

function paymentConfigStatus() {
  const payment = config.dujiaopay;
  return {
    paymentProvider: 'dujiaopay',
    paymentEnabled: Boolean(payment.enabled),
    paymentConfigured: paymentProvider.isConfigured(),
    paymentSource: settings.getPaymentConfigMetadata().configured ? 'database' : paymentProvider.isConfigured() ? 'environment' : 'none',
    paymentReady: paymentProvider.isEnabled(),
    paymentBaseUrl: payment.baseUrl,
    paymentKeyId: maskSecret(payment.keyId),
    paymentSecretConfigured: Boolean(payment.secret),
    paymentWebhookSecretConfigured: Boolean(payment.webhookSecret),
    paymentChain: payment.chain,
    paymentTokenId: payment.tokenId,
    paymentTtlMinutes: payment.ttlMinutes,
    paymentUpdatedAt: settings.getPaymentConfigMetadata().updatedAt,
  };
}

function paymentConfigInput(body) {
  const current = config.dujiaopay;
  const next = {
    enabled: body.enabled,
    baseUrl: body.baseUrl || current.baseUrl,
    keyId: body.keyId || current.keyId,
    secret: body.secret || current.secret,
    webhookSecret: body.webhookSecret || current.webhookSecret,
    chain: body.chain || current.chain,
    tokenId: body.tokenId || current.tokenId,
    ttlMinutes: body.ttlMinutes === '' ? undefined : body.ttlMinutes,
  };
  return next;
}

function syncPaymentConfig() {
  runtime.reloadPaymentConfig();
}

function assertPaymentReady() {
  if (!paymentProvider.isEnabled()) {
    throw new DomainError('支付渠道尚未配置完成，请联系管理员。', 'payment_not_configured', 503);
  }
}

function assertPaymentConfigured() {
  if (!paymentProvider.isConfigured()) {
    throw new DomainError('支付渠道凭据尚未配置完成。', 'payment_not_configured', 503);
  }
}

function telegramIdentityFromHeader(request) {
  const initData = request.headers['x-telegram-init-data'];
  if (typeof initData !== 'string' || !initData.trim() || initData.length > 8192) return null;
  const telegramUser = verifyTelegramInitData(initData, telegramBotToken());
  const user = commerce.upsertTelegramUser(telegramUser);
  if (!user.isActive) throw new DomainError('当前账号已停用，请联系售后。', 'user_disabled', 403);
  return user;
}

function issueSession(user) {
  return { accessToken: createSessionToken(user.id, config.sessionSecret), user };
}

function issueBuyerSession(user) {
  if (!user.isActive) throw new DomainError('当前账号已停用，请联系售后。', 'user_disabled', 403);
  return issueSession(user);
}

function issueAdminSession(account) {
  return { accessToken: createSessionToken(account.id, config.sessionSecret, 60 * 60 * 8, 'admin'), user: account };
}

function assertObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('请求参数无效。', 'invalid_request', 422);
  }
  return value;
}

function parseCardLines(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [code, password = '', note = ''] = line.split(/[,\t]/).map((part) => part.trim());
      return { code, password, note };
    });
}

async function handleApi(request, response, pathname) {
  const method = request.method ?? 'GET';

  if (method === 'GET' && pathname === '/api/health') {
    syncPaymentConfig();
    const database = runtime.db.prepare('SELECT MAX(version) AS schemaVersion FROM schema_migrations').get();
    return sendJson(response, 200, {
      ok: true,
      version: config.appVersion,
      database: 'ok',
      schemaVersion: Number(database.schemaVersion ?? 0),
      provider: paymentProvider.name,
      paymentConfigured: paymentProvider.isConfigured(),
      paymentReady: paymentProvider.isEnabled(),
      environment: config.nodeEnv,
    });
  }

  if (method === 'POST' && pathname === '/api/auth/telegram') {
    if (!checkRateLimit(request, response, 20)) return;
    const body = assertObject(await readJson(request));
    if (typeof body.initData !== 'string' || body.initData.length > 8192) {
      throw new DomainError('Telegram 登录数据无效。', 'invalid_request', 422);
    }
    const telegramUser = verifyTelegramInitData(body.initData, telegramBotToken());
    const user = commerce.upsertTelegramUser(telegramUser);
    return sendJson(response, 200, issueBuyerSession(user));
  }

  if (method === 'POST' && pathname === '/api/auth/admin/password') {
    if (!checkRateLimit(request, response, 10)) return;
    const body = assertObject(await readJson(request));
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const account = adminAccounts.authenticate(username, password);
    if (!account) throw new DomainError('管理员账号或密码错误。', 'invalid_admin_credentials', 401);
    return sendJson(response, 200, issueAdminSession(account));
  }

  if (method === 'GET' && pathname === '/api/admin/settings') {
    const user = requireAdmin(request);
    syncPaymentConfig();
    return sendJson(response, 200, {
      username: user.username,
      ...telegramBotTokenStatus(),
      ...paymentConfigStatus(),
    });
  }

  if (method === 'PATCH' && pathname === '/api/admin/settings') {
    const user = requireAdmin(request);
    syncPaymentConfig();
    const body = assertObject(await readJson(request));
    let telegramSavedAt = null;
    let paymentSavedAt = null;
    if (body.telegramBotToken !== undefined) {
      if (typeof body.telegramBotToken !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(body.telegramBotToken.trim())) {
        throw new DomainError('Telegram Bot Token 格式无效。', 'invalid_request', 422);
      }
      const telegramBotToken = body.telegramBotToken.trim();
      telegramSavedAt = settings.setTelegramBotToken(telegramBotToken);
      config.telegramBotToken = telegramBotToken;
      commerce.audit(user.id, 'settings.telegram_bot_token.updated', 'app_setting', 'telegram_bot_token', { configured: true });
    }
    const paymentBody = body.payment && typeof body.payment === 'object' && !Array.isArray(body.payment) ? body.payment : body;
    const paymentKeys = ['enabled', 'baseUrl', 'keyId', 'secret', 'webhookSecret', 'chain', 'tokenId', 'ttlMinutes'];
    const hasPaymentUpdate = body.payment !== undefined || paymentKeys.some((key) => Object.prototype.hasOwnProperty.call(body, key));
    if (hasPaymentUpdate) {
      try {
        const nextPaymentConfig = refreshPaymentConfig(paymentConfigInput(paymentBody));
        paymentSavedAt = settings.setPaymentConfig(nextPaymentConfig);
        commerce.audit(user.id, 'settings.payment.updated', 'app_setting', 'payment_config', {
          provider: 'dujiaopay',
          enabled: nextPaymentConfig.enabled,
        });
      } catch (error) {
        throw new DomainError(error instanceof Error ? error.message : '支付配置无效。', 'invalid_payment_config', 422);
      }
    }
    return sendJson(response, 200, {
      ...telegramBotTokenStatus(),
      ...paymentConfigStatus(),
      savedAt: telegramSavedAt ?? paymentSavedAt,
      telegramSavedAt,
      paymentSavedAt,
    });
  }

  if (method === 'POST' && pathname === '/api/admin/settings/test-payment') {
    requireAdmin(request);
    syncPaymentConfig();
    assertPaymentConfigured();
    const identity = await paymentProvider.whoAmI();
    return sendJson(response, 200, { ok: true, provider: paymentProvider.name, ...identity });
  }

  if (method === 'PATCH' && pathname === '/api/admin/account') {
    const user = requireAdmin(request);
    const body = assertObject(await readJson(request));
    const update = {};
    if (body.username !== undefined) update.username = body.username;
    if (body.password !== undefined) update.password = body.password;
    if (!Object.keys(update).length) throw new DomainError('没有需要保存的账号设置。', 'invalid_request', 422);
    try {
      const account = adminAccounts.update(user.id, update);
      commerce.audit(user.id, 'admin.account.updated', 'admin_account', user.id, {
        usernameChanged: update.username !== undefined,
        passwordChanged: update.password !== undefined,
      });
      return sendJson(response, 200, account);
    } catch (error) {
      throw new DomainError(error.message, 'invalid_request', 422);
    }
  }

  if (method === 'GET' && pathname === '/api/me') {
    return sendJson(response, 200, requireIdentity(request).identity);
  }

  if (method === 'GET' && pathname === '/api/public-config') {
    syncPaymentConfig();
    return sendJson(response, 200, {
      version: config.appVersion,
      supportUrl: config.supportUrl || null,
      paymentProvider: paymentProvider.name,
      paymentConfigured: paymentProvider.isConfigured(),
      paymentReady: paymentProvider.isEnabled(),
      paymentEnabled: Boolean(config.dujiaopay.enabled),
      paymentChain: config.dujiaopay.chain,
      paymentToken: config.dujiaopay.tokenId,
    });
  }

  if (method === 'GET' && pathname === '/api/catalog') {
    return sendJson(response, 200, commerce.listCatalog());
  }

  if (method === 'POST' && pathname === '/api/orders') {
    if (!checkRateLimit(request, response, 20)) return;
    const user = requireUser(request);
    syncPaymentConfig();
    assertPaymentReady();
    const body = assertObject(await readJson(request));
    const order = await commerce.createOrder(user, {
      variantId: body.variantId,
      quantity: body.quantity,
      idempotencyKey: requireIdempotencyKey(request),
    });
    return sendJson(response, 201, order);
  }

  if (method === 'GET' && pathname === '/api/orders') {
    return sendJson(response, 200, commerce.listOrders(requireUser(request).id));
  }

  const orderMatch = pathname.match(/^\/api\/orders\/(XX\d{14}[A-F0-9]{8})$/);
  if (method === 'GET' && orderMatch) {
    return sendJson(response, 200, commerce.getOrderForUser(orderMatch[1], requireUser(request).id));
  }

  const retryPaymentMatch = pathname.match(/^\/api\/orders\/(XX\d{14}[A-F0-9]{8})\/payment-session$/);
  if (method === 'POST' && retryPaymentMatch) {
    const user = requireUser(request);
    const order = await commerce.retryPaymentSession(retryPaymentMatch[1], user.id);
    return sendJson(response, 200, order);
  }

  if (method === 'POST' && pathname === '/api/webhooks/dujiaopay') {
    syncPaymentConfig();
    assertPaymentConfigured();
    const event = paymentProvider.verifyWebhook(await readBody(request), request.headers);
    const result = commerce.processWebhook(event);
    const status = result.processed
      ? (result.duplicate ? 200 : 202)
      : result.error === 'webhook_payload_conflict' ? 409 : 500;
    return sendJson(response, status, {
      received: true,
      duplicate: result.duplicate,
      processed: result.processed ?? !result.error,
      errorCode: result.error ?? null,
    });
  }

  if (method === 'GET' && pathname === '/api/admin/users') {
    requireAdmin(request);
    return sendJson(response, 200, commerce.listAdminUsers());
  }
  const adminUserStatusMatch = pathname.match(/^\/api\/admin\/users\/(usr_[A-Za-z0-9-]+)\/status$/);
  if (method === 'PATCH' && adminUserStatusMatch) {
    const user = requireAdmin(request);
    const body = assertObject(await readJson(request));
    return sendJson(response, 200, commerce.updateUserStatus(user, adminUserStatusMatch[1], body.isActive));
  }
  const adminUserBalanceMatch = pathname.match(/^\/api\/admin\/users\/(usr_[A-Za-z0-9-]+)\/balance$/);
  if (method === 'PATCH' && adminUserBalanceMatch) {
    const user = requireAdmin(request);
    const body = assertObject(await readJson(request));
    return sendJson(response, 200, commerce.adjustUserBalance(user, adminUserBalanceMatch[1], body.deltaFen, {
      kind: body.kind ?? 'adjust',
      memo: body.memo ?? '',
    }));
  }
  const adminUserBalanceEntriesMatch = pathname.match(/^\/api\/admin\/users\/(usr_[A-Za-z0-9-]+)\/balance-entries$/);
  if (method === 'GET' && adminUserBalanceEntriesMatch) {
    requireAdmin(request);
    return sendJson(response, 200, commerce.listBalanceEntries(adminUserBalanceEntriesMatch[1]));
  }
  if (method === 'GET' && pathname === '/api/me/balance') {
    const identity = requireIdentity(request).identity;
    return sendJson(response, 200, {
      balanceFen: Number(identity.balanceFen ?? 0),
      entries: commerce.listBalanceEntries(identity.id, 50),
    });
  }

  if (method === 'GET' && pathname === '/api/admin/dashboard') {
    requireAdmin(request);
    return sendJson(response, 200, commerce.dashboard());
  }
  if (method === 'GET' && pathname === '/api/admin/products') {
    requireAdmin(request);
    return sendJson(response, 200, commerce.listAdminProducts());
  }
  if (method === 'GET' && pathname === '/api/admin/categories') {
    requireAdmin(request);
    return sendJson(response, 200, commerce.listCategories());
  }
  if (method === 'GET' && pathname === '/api/admin/orders') {
    requireAdmin(request);
    return sendJson(response, 200, commerce.listAdminOrders());
  }
  if (method === 'GET' && pathname === '/api/admin/webhook-failures') {
    requireAdmin(request);
    return sendJson(response, 200, commerce.listWebhookFailures());
  }
  if (method === 'POST' && pathname === '/api/admin/categories') {
    const user = requireAdmin(request);
    return sendJson(response, 201, commerce.createCategory(user, assertObject(await readJson(request))));
  }
  if (method === 'POST' && pathname === '/api/admin/products') {
    const user = requireAdmin(request);
    return sendJson(response, 201, commerce.createProduct(user, assertObject(await readJson(request))));
  }
  const productMatch = pathname.match(/^\/api\/admin\/products\/([A-Za-z0-9_-]+)$/);
  if (method === 'PATCH' && productMatch) {
    const user = requireAdmin(request);
    commerce.updateProduct(user, productMatch[1], assertObject(await readJson(request)));
    setBaseHeaders(response);
    response.writeHead(204);
    return response.end();
  }
  if (method === 'POST' && pathname === '/api/admin/variants') {
    const user = requireAdmin(request);
    return sendJson(response, 201, commerce.createVariant(user, assertObject(await readJson(request))));
  }
  const variantMatch = pathname.match(/^\/api\/admin\/variants\/([A-Za-z0-9_-]+)$/);
  if (method === 'PATCH' && variantMatch) {
    const user = requireAdmin(request);
    commerce.updateVariant(user, variantMatch[1], assertObject(await readJson(request)));
    setBaseHeaders(response);
    response.writeHead(204);
    return response.end();
  }
  const fulfillmentRetryMatch = pathname.match(/^\/api\/admin\/orders\/(XX\d{14}[A-F0-9]{8})\/retry-fulfillment$/);
  if (method === 'POST' && fulfillmentRetryMatch) {
    const user = requireAdmin(request);
    const queued = commerce.retryFulfillment(user, fulfillmentRetryMatch[1]);
    return sendJson(response, 202, queued);
  }

  if (method === 'POST' && pathname === '/api/admin/cards/import') {
    if (!checkRateLimit(request, response, 10)) return;
    const user = requireAdmin(request);
    const body = assertObject(await readJson(request));
    const cards = Array.isArray(body.cards) ? body.cards : parseCardLines(body.rawCards);
    return sendJson(response, 201, commerce.importCards(user, {
      variantId: body.variantId,
      batchLabel: body.batchLabel,
      cards,
    }));
  }

  throw new DomainError('未找到接口。', 'not_found', 404);
}

function serveApplication(request, response, pathname) {
  const buyerDirectory = path.join(root, 'apps/miniapp');
  if (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname === '/orders/' ||
    pathname.startsWith('/orders/') ||
    pathname.startsWith('/products/')
  ) {
    return serveFile(response, buyerDirectory, 'index.html');
  }
  if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin/index.html') {
    return serveFile(response, path.join(root, 'apps/admin'), 'index.html');
  }
  if (pathname.startsWith('/assets/')) return serveFile(response, buyerDirectory, pathname.slice(1));
  if (pathname.startsWith('/miniapp/')) return serveFile(response, buyerDirectory, pathname.slice('/miniapp/'.length));
  if (pathname.startsWith('/admin/')) return serveFile(response, path.join(root, 'apps/admin'), pathname.slice('/admin/'.length));
  return false;
}

const server = http.createServer(async (request, response) => {
  const requestId = crypto.randomUUID();
  response.setHeader('X-Request-ID', requestId);
  try {
    const url = new URL(request.url ?? '/', config.appOrigin);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url.pathname);
      return;
    }
    if (serveApplication(request, response, url.pathname)) return;
    sendJson(response, 404, { error: { code: 'not_found', message: '资源不存在。', requestId } });
  } catch (error) {
    sendError(response, error, requestId);
  }
});

let ticking = false;
if (!config.isProduction) {
  setInterval(() => {
    if (ticking) return;
    ticking = true;
    Promise.resolve()
      .then(() => runtime.commerce.recoverStaleFulfillmentJobs())
      .then(() => runtime.commerce.processJobs(20))
      .then(() => runtime.commerce.reconcileDuePayments(30))
      .catch((error) => console.error(error instanceof Error ? error.message : error))
      .finally(() => { ticking = false; });
  }, 3000).unref();
}

server.listen(config.port, '0.0.0.0', () => {
  console.log(`XiuXian API listening at ${config.appOrigin}`);
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceClose = setTimeout(() => {
      server.closeAllConnections?.();
      runtime.db.close();
      process.exit(1);
    }, 15_000);
    forceClose.unref();
    server.close(() => {
      clearTimeout(forceClose);
      runtime.db.close();
      process.exit(0);
    });
    server.closeIdleConnections?.();
  });
}
