// Upstream OpenAPI：站点间对接协议（参考 Dujiao-Next OpenAPI）
// 提供：HMAC-SHA256 签名、API 凭证管理、对接连接管理、采购单与回调处理。
import crypto from 'node:crypto';
import { DomainError } from './commerce.js';
import { hmacHex, randomId, safeEqual } from './crypto.js';
import { nowIso, json, one, many, run, transaction, parseJson } from './database.js';

const SIGN_HEADER_KEY = 'dujiao-next-api-key';
const SIGN_HEADER_TIMESTAMP = 'dujiao-next-timestamp';
const SIGN_HEADER_SIGNATURE = 'dujiao-next-signature';
const TIMESTAMP_TOLERANCE_SECONDS = 60;
const EMPTY_BODY_MD5 = crypto.createHash('md5').update('').digest('hex');

export function md5Hex(value) {
  return crypto.createHash('md5').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

// 签名串：{METHOD}\n{PATH}\n{TIMESTAMP}\n{MD5(BODY)}
export function buildSignString(method, path, timestamp, body) {
  const bodyBuffer = body == null || body === '' ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return `${String(method).toUpperCase()}\n${path}\n${String(timestamp)}\n${md5Hex(bodyBuffer)}`;
}

export function computeSignature(secret, method, path, timestamp, body) {
  return hmacHex(secret, buildSignString(method, path, timestamp, body));
}

export function verifySignature(secret, method, path, timestamp, body, suppliedSignature) {
  const expected = computeSignature(secret, method, path, timestamp, body);
  return typeof suppliedSignature === 'string' && safeEqual(suppliedSignature.toLowerCase(), expected);
}

function readRawHeaders(request) {
  const headers = {};
  for (const [key, value] of Object.entries(request.headers ?? {})) headers[key.toLowerCase()] = value;
  return headers;
}

export class UpstreamService {
  constructor({ db, config, cardCrypto, commerce }) {
    this.db = db;
    this.config = config;
    this.cardCrypto = cardCrypto;
    this.commerce = commerce;
  }

  // ---- 签名校验（本站作为 B 站被对接方，接收 A 站的请求） ----

  authenticateRequest(request, rawBody) {
    const headers = readRawHeaders(request);
    const apiKey = headers[SIGN_HEADER_KEY];
    const timestamp = headers[SIGN_HEADER_TIMESTAMP];
    const signature = headers[SIGN_HEADER_SIGNATURE];
    if (!apiKey || !timestamp || !signature) {
      throw new DomainError('缺少签名请求头。', 'missing_auth_headers', 401);
    }
    const ts = Number(timestamp);
    if (!Number.isSafeInteger(ts)) throw new DomainError('时间戳格式错误。', 'invalid_timestamp', 401);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > TIMESTAMP_TOLERANCE_SECONDS) {
      throw new DomainError('时间戳过期。', 'timestamp_expired', 401);
    }
    const credential = one(
      this.db,
      'SELECT * FROM api_credentials WHERE api_key = ?',
      apiKey,
    );
    if (!credential) throw new DomainError('API Key 无效。', 'invalid_api_key', 401);
    if (!Number(credential.is_active)) throw new DomainError('API Key 已停用。', 'invalid_api_key', 401);
    const owner = one(this.db, 'SELECT is_active FROM users WHERE id = ?', credential.owner_user_id);
    if (!owner || !Number(owner.is_active)) throw new DomainError('API Key 所属账号已被禁用。', 'user_disabled', 403);
    const body = rawBody ?? Buffer.alloc(0);
    const path = String(request.url ?? '').split('?')[0] ?? '/';
    // secret 加密存储（AES-256-GCM），验证时解密后按标准 HMAC-SHA256 校验。
    const secret = this.cardCrypto.decrypt(credential.secret_ciphertext);
    if (!verifySignature(secret, request.method, path, timestamp, body, signature)) {
      throw new DomainError('签名验证失败。', 'invalid_signature', 401);
    }
    return { credential, ownerUserId: credential.owner_user_id };
  }

  // ---- 凭证管理 ----

  createApiCredential(actor, { label }) {
    const apiKey = `dj_${crypto.randomBytes(12).toString('hex')}`;
    const secret = crypto.randomBytes(32).toString('hex');
    const id = randomId('cred_');
    const now = nowIso();
    // secret 加密存储（AES-256-GCM），只在创建时向用户展示一次。
    const secretCiphertext = this.cardCrypto.encrypt(secret);
    run(
      this.db,
      'INSERT INTO api_credentials (id, owner_user_id, api_key, secret_ciphertext, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      id,
      actor.id,
      apiKey,
      secretCiphertext,
      now,
      now,
    );
    this.commerce.audit(actor.id, 'upstream.credential.create', 'api_credential', id, { label: label ?? '' });
    return { id, apiKey, secret, label: label ?? '', isActive: true, createdAt: now };
  }

  listApiCredentials() {
    return many(
      this.db,
      'SELECT id, owner_user_id, api_key, is_active, created_at, updated_at FROM api_credentials ORDER BY created_at DESC',
    ).map((row) => ({
      id: row.id,
      ownerUserId: row.owner_user_id,
      apiKey: row.api_key,
      isActive: Boolean(Number(row.is_active)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  setApiCredentialActive(id, isActive) {
    const row = one(this.db, 'SELECT * FROM api_credentials WHERE id = ?', id);
    if (!row) throw new DomainError('API 凭证不存在。', 'credential_not_found', 404);
    run(this.db, 'UPDATE api_credentials SET is_active = ?, updated_at = ? WHERE id = ?', isActive ? 1 : 0, nowIso(), id);
    return { id, isActive: Boolean(isActive) };
  }

  // ---- 对接连接管理 ----

  createConnection(actor, { name, baseUrl, apiKey, apiSecret, callbackUrl }) {
    if (!name || !baseUrl || !apiKey || !apiSecret) {
      throw new DomainError('连接名称、站点地址、API Key、API Secret 均为必填。', 'invalid_request', 422);
    }
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new DomainError('站点地址格式无效。', 'invalid_request', 422);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new DomainError('站点地址必须使用 http/https。', 'invalid_request', 422);
    }
    if (callbackUrl) {
      try {
        const cb = new URL(callbackUrl);
        if (cb.protocol !== 'https:' && cb.protocol !== 'http:') throw new Error();
      } catch {
        throw new DomainError('回调地址格式无效。', 'invalid_callback_url', 422);
      }
    }
    const id = randomId('conn_');
    const now = nowIso();
    const secretCiphertext = this.cardCrypto.encrypt(apiSecret);
    run(
      this.db,
      `INSERT INTO upstream_connections (id, name, base_url, api_key, secret_ciphertext, callback_url, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      id,
      name,
      url.origin,
      apiKey,
      secretCiphertext,
      callbackUrl ?? null,
      now,
      now,
    );
    this.commerce.audit(actor.id, 'upstream.connection.create', 'upstream_connection', id, { name });
    return this.getConnection(id);
  }

  getConnection(id) {
    const row = one(this.db, 'SELECT * FROM upstream_connections WHERE id = ?', id);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      apiKey: row.api_key,
      callbackUrl: row.callback_url,
      isActive: Boolean(Number(row.is_active)),
      lastPingAt: row.last_ping_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listConnections() {
    return many(this.db, 'SELECT * FROM upstream_connections ORDER BY created_at DESC').map((row) => ({
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      apiKey: row.api_key,
      callbackUrl: row.callback_url,
      isActive: Boolean(Number(row.is_active)),
      lastPingAt: row.last_ping_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  setConnectionActive(id, isActive) {
    const row = one(this.db, 'SELECT * FROM upstream_connections WHERE id = ?', id);
    if (!row) throw new DomainError('对接连接不存在。', 'connection_not_found', 404);
    run(this.db, 'UPDATE upstream_connections SET is_active = ?, updated_at = ? WHERE id = ?', isActive ? 1 : 0, nowIso(), id);
    return this.getConnection(id);
  }

  deleteConnection(id) {
    const row = one(this.db, 'SELECT * FROM upstream_connections WHERE id = ?', id);
    if (!row) throw new DomainError('对接连接不存在。', 'connection_not_found', 404);
    run(this.db, 'DELETE FROM upstream_connections WHERE id = ?', id);
    return { id, deleted: true };
  }

  // 测试连接：调用上游 /ping（携带签名）
  async testConnection(id, options = {}) {
    const connection = this.getConnection(id);
    if (!connection) throw new DomainError('对接连接不存在。', 'connection_not_found', 404);
    const secret = this.cardCrypto.decrypt(one(this.db, 'SELECT secret_ciphertext FROM upstream_connections WHERE id = ?', id).secret_ciphertext);
    const basePath = `${connection.baseUrl}/api/v1/upstream`;
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = computeSignature(secret, 'POST', `${new URL(basePath).pathname}/ping`, timestamp, '');
    let response;
    try {
      response = await fetch(`${basePath}/ping`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [SIGN_HEADER_KEY]: connection.apiKey,
          [SIGN_HEADER_TIMESTAMP]: String(timestamp),
          [SIGN_HEADER_SIGNATURE]: signature,
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
      });
    } catch (error) {
      throw new DomainError(`连接失败：${error instanceof Error ? error.message : '网络错误'}`, 'connection_failed', 502);
    }
    const data = await response.json().catch(() => ({}));
    run(this.db, 'UPDATE upstream_connections SET last_ping_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), id);
    if (!response.ok || data.ok !== true) {
      throw new DomainError(data.error_message ?? `上游返回错误（HTTP ${response.status}）`, 'connection_failed', 502);
    }
    return { ok: true, siteName: data.site_name ?? null, balance: data.balance ?? null, currency: data.currency ?? null };
  }

  // 拉取上游商品列表（对接方 A 站使用）
  async syncUpstreamProducts(id, options = {}) {
    const connection = this.getConnection(id);
    if (!connection) throw new DomainError('对接连接不存在。', 'connection_not_found', 404);
    const secret = this.cardCrypto.decrypt(one(this.db, 'SELECT secret_ciphertext FROM upstream_connections WHERE id = ?', id).secret_ciphertext);
    const basePath = `${connection.baseUrl}/api/v1/upstream`;
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = computeSignature(secret, 'GET', `${new URL(basePath).pathname}/products`, timestamp, '');
    let response;
    try {
      response = await fetch(`${basePath}/products`, {
        method: 'GET',
        headers: {
          [SIGN_HEADER_KEY]: connection.apiKey,
          [SIGN_HEADER_TIMESTAMP]: String(timestamp),
          [SIGN_HEADER_SIGNATURE]: signature,
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
      });
    } catch (error) {
      throw new DomainError(`拉取上游商品失败：${error instanceof Error ? error.message : '网络错误'}`, 'connection_failed', 502);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true) {
      throw new DomainError(data.error_message ?? `上游返回错误（HTTP ${response.status}）`, 'connection_failed', 502);
    }
    return Array.isArray(data.items) ? data.items : [];
  }

  // 创建采购单（对接方 A 站向 B 站采购；B 站钱包扣款）
  async createProcurementOrder(connectionId, input, options = {}) {
    const connection = this.getConnection(connectionId);
    if (!connection) throw new DomainError('对接连接不存在。', 'connection_not_found', 404);
    if (!connection.isActive) throw new DomainError('对接连接已停用。', 'connection_disabled', 409);
    const secret = this.cardCrypto.decrypt(one(this.db, 'SELECT secret_ciphertext FROM upstream_connections WHERE id = ?', connectionId).secret_ciphertext);
    const basePath = `${connection.baseUrl}/api/v1/upstream`;
    const body = JSON.stringify({
      sku_id: input.skuId,
      quantity: input.quantity,
      downstream_order_no: input.downstreamOrderNo,
      callback_url: connection.callbackUrl,
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = computeSignature(secret, 'POST', `${new URL(basePath).pathname}/orders`, timestamp, body);
    let response;
    try {
      response = await fetch(`${basePath}/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [SIGN_HEADER_KEY]: connection.apiKey,
          [SIGN_HEADER_TIMESTAMP]: String(timestamp),
          [SIGN_HEADER_SIGNATURE]: signature,
        },
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
      });
    } catch (error) {
      throw new DomainError(`创建采购单失败：${error instanceof Error ? error.message : '网络错误'}`, 'connection_failed', 502);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true) {
      throw new DomainError(data.error_message ?? `上游返回错误（HTTP ${response.status}）`, 'procurement_failed', 502);
    }
    return {
      ok: true,
      orderId: data.order_id ?? null,
      orderNo: data.order_no ?? null,
      status: data.status ?? 'paid',
      amount: data.amount ?? null,
      currency: data.currency ?? null,
    };
  }

  // 查询采购单（对接方 A 站轮询）
  async getProcurementOrder(connectionId, upstreamOrderId, options = {}) {
    const connection = this.getConnection(connectionId);
    if (!connection) throw new DomainError('对接连接不存在。', 'connection_not_found', 404);
    const secret = this.cardCrypto.decrypt(one(this.db, 'SELECT secret_ciphertext FROM upstream_connections WHERE id = ?', connectionId).secret_ciphertext);
    const basePath = `${connection.baseUrl}/api/v1/upstream`;
    const path = `${new URL(basePath).pathname}/orders/${encodeURIComponent(upstreamOrderId)}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = computeSignature(secret, 'GET', path, timestamp, '');
    let response;
    try {
      response = await fetch(`${basePath}/orders/${encodeURIComponent(upstreamOrderId)}`, {
        method: 'GET',
        headers: {
          [SIGN_HEADER_KEY]: connection.apiKey,
          [SIGN_HEADER_TIMESTAMP]: String(timestamp),
          [SIGN_HEADER_SIGNATURE]: signature,
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
      });
    } catch (error) {
      throw new DomainError(`查询采购单失败：${error instanceof Error ? error.message : '网络错误'}`, 'connection_failed', 502);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true) {
      throw new DomainError(data.error_message ?? `上游返回错误（HTTP ${response.status}）`, 'procurement_failed', 502);
    }
    return data;
  }

  // 处理上游回调（本站作为 A 站接收 B 站推送）
  // 回调请求需携带签名头（B 站使用 A 站连接中配置的 api_key/api_secret 签名），
  // 服务端按 api_key 找到对应连接并解密 secret 验签；无签名头时回退为仅校验订单号（本地测试用）。
  authenticateCallback(request, rawBody) {
    const headers = readRawHeaders(request);
    const apiKey = headers[SIGN_HEADER_KEY];
    const timestamp = headers[SIGN_HEADER_TIMESTAMP];
    const signature = headers[SIGN_HEADER_SIGNATURE];
    if (!apiKey || !timestamp || !signature) return { connection: null };
    const ts = Number(timestamp);
    if (!Number.isSafeInteger(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > TIMESTAMP_TOLERANCE_SECONDS) {
      throw new DomainError('回调时间戳无效或过期。', 'timestamp_expired', 401);
    }
    const connection = one(this.db, 'SELECT * FROM upstream_connections WHERE api_key = ?', apiKey);
    if (!connection) throw new DomainError('回调连接不存在。', 'invalid_api_key', 401);
    const secret = this.cardCrypto.decrypt(connection.secret_ciphertext);
    const path = String(request.url ?? '').split('?')[0] ?? '/';
    if (!verifySignature(secret, request.method, path, timestamp, rawBody ?? Buffer.alloc(0), signature)) {
      throw new DomainError('回调签名验证失败。', 'invalid_signature', 401);
    }
    return { connection };
  }

  async handleUpstreamCallback(payload) {
    if (!payload || typeof payload.downstream_order_no !== 'string') {
      throw new DomainError('回调缺少下游订单号。', 'invalid_callback', 400);
    }
    const orderNo = payload.downstream_order_no;
    const order = one(this.db, 'SELECT * FROM orders WHERE order_no = ?', orderNo);
    if (!order) throw new DomainError('回调订单不存在。', 'order_not_found', 404);
    const status = payload.status;
    const now = nowIso();
    if (status === 'delivered' || status === 'completed') {
      const fulfillment = payload.fulfillment;
      const cardCode = fulfillment?.payload ?? null;
      run(
        this.db,
        `UPDATE orders SET status = 'completed', fulfillment_status = 'fulfilled', fulfilled_at = ?, updated_at = ? WHERE id = ?`,
        fulfillment?.delivered_at ?? now,
        now,
        order.id,
      );
      this.commerce.audit(null, 'upstream.callback.delivered', 'order', order.id, {
        orderNo,
        payload: cardCode,
      });
      return { ok: true, message: 'received', status: 'completed' };
    }
    if (status === 'canceled') {
      run(this.db, `UPDATE orders SET status = 'canceled', failure_reason = '上游已取消该采购订单。', updated_at = ? WHERE id = ?`, now, order.id);
      this.commerce.audit(null, 'upstream.callback.canceled', 'order', order.id, { orderNo });
      return { ok: true, message: 'received', status: 'canceled' };
    }
    this.commerce.audit(null, 'upstream.callback.status', 'order', order.id, { orderNo, status });
    return { ok: true, message: 'received', status };
  }
}

export { SIGN_HEADER_KEY, SIGN_HEADER_TIMESTAMP, SIGN_HEADER_SIGNATURE, EMPTY_BODY_MD5 };
