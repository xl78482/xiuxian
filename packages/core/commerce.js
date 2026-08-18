import crypto from 'node:crypto';
import { many, nowIso, one, parseJson, run, transaction } from './database.js';
import { randomId } from './crypto.js';
import { canonicalDecimal, isSameDecimal, normalizePaymentInstructions } from '../payment/index.js';

export class DomainError extends Error {
  constructor(message, code = 'domain_error', status = 400) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

function addMinutes(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function orderNumber() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `XX${stamp}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function rechargeNumber() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `RC${stamp}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function asBoolean(value) {
  return Boolean(Number(value));
}

function isSqliteUniqueError(error) {
  return error && typeof error === 'object' && String(error.code ?? '').includes('SQLITE_CONSTRAINT');
}

const orderWithPayment = `
  SELECT
    o.id, o.order_no, o.user_id, o.product_id, o.variant_id,
    o.product_title_snapshot, o.variant_name_snapshot, o.quantity,
    o.unit_price_fen, o.total_price_fen, o.currency, o.status,
    o.fulfillment_status, o.payment_deadline, o.fulfilled_at,
    o.failure_reason, o.created_at, o.updated_at,
    pt.provider, pt.provider_order_id, pt.merchant_order_id,
    pt.status AS payment_status, pt.fiat_amount, pt.fiat_currency,
    pt.payable_amount, pt.chain, pt.token_id, pt.pay_address,
    pt.checkout_url, pt.provider_expires_at, pt.paid_at,
    pt.transaction_id, pt.provider_payload, pt.payment_instructions
  FROM orders o
  JOIN payment_transactions pt ON pt.order_id = o.id
`;

function toUser(row) {
  return row
    ? {
        id: row.id,
        telegramId: row.telegram_id,
        username: row.username,
        firstName: row.first_name,
        lastName: row.last_name,
        languageCode: row.language_code,
        photoUrl: row.photo_url,
        isActive: Boolean(Number(row.is_active)),
        isAdmin: row.role === 'admin',
        balanceFen: Number(row.balance_fen ?? 0),
      }
    : null;
}

function legacyCryptoInstructions(row) {
  if (!row.pay_address || !row.payable_amount || row.provider === 'mock') return null;
  const token = String(row.token_id ?? 'USDT').toUpperCase();
  try {
    return normalizePaymentInstructions({
      mode: 'qr',
      method: 'crypto',
      label: token === 'TRON-USDT' ? 'USDT' : token,
      amountUnit: token === 'TRON-USDT' ? 'USDT' : token,
      network: row.chain ? String(row.chain).toUpperCase() : null,
      qrContent: row.pay_address,
      address: row.pay_address,
    });
  } catch {
    return null;
  }
}

function toPaymentSummary(row) {
  let paymentInstructions = null;
  try {
    paymentInstructions = normalizePaymentInstructions(parseJson(row.payment_instructions, null));
  } catch {
    paymentInstructions = null;
  }
  paymentInstructions ??= legacyCryptoInstructions(row);
  return {
    provider: row.provider,
    status: row.payment_status,
    checkoutUrl: paymentInstructions ? null : row.checkout_url,
    chain: row.chain,
    tokenId: row.token_id,
    payableAmount: row.payable_amount,
    payAddress: row.pay_address,
    expiresAt: row.provider_expires_at ?? row.payment_deadline,
    serverTime: nowIso(),
    paymentInstructions,
  };
}

function toOrderSummary(row) {
  return {
    orderNo: row.order_no,
    productTitle: row.product_title_snapshot,
    variantName: row.variant_name_snapshot,
    quantity: Number(row.quantity),
    totalPriceFen: Number(row.total_price_fen),
    currency: row.currency,
    status: row.status,
    fulfillmentStatus: row.fulfillment_status,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    failureReason: row.failure_reason,
    payment: toPaymentSummary(row),
  };
}

function assertIdempotentOrderMatches(order, variantId, quantity) {
  if (order.variant_id !== variantId || Number(order.quantity) !== quantity) {
    throw new DomainError('相同 Idempotency-Key 不能用于不同的商品或数量。', 'idempotency_conflict', 409);
  }
  return order;
}

function assertText(value, name, minimum = 1, maximum = 1000) {
  if (typeof value !== 'string' || value.trim().length < minimum || value.trim().length > maximum) {
    throw new DomainError(`${name} 无效。`, 'invalid_request', 422);
  }
  return value.trim();
}

function assertSlug(value) {
  const slug = assertText(value, 'Slug', 1, 120);
  if (!/^[a-z0-9-]+$/.test(slug)) throw new DomainError('Slug 只能包含小写字母、数字和连字符。', 'invalid_request', 422);
  return slug;
}

// 将任意名称（分类名、商品名）转成小写字母数字连字符形式，供 slug 自动生成使用。
function slugifyName(value) {
  const slug = String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug;
}

// 找一个数据库中当前不冲突的唯一 slug：给定基本 slug，若已存在则追加 -2、-3……；
// slugify 后为空时使用随机短尾。用于用户可选择留空 slug 时自动生成。
function uniqueSlug(db, table, column, base, excludeId = null) {
  const raw = slugifyName(base);
  const baseSlug = raw.length ? raw : `item-${randomId('').slice(0, 8)}`;
  let slug = baseSlug;
  let counter = 2;
  const exclusive = excludeId ? `AND id != ?` : '';
  const args = [slug];
  if (excludeId) args.push(excludeId);
  while (one(db, `SELECT id FROM ${table} WHERE ${column} = ? ${exclusive}`, ...args)) {
    slug = `${baseSlug}-${counter++}`;
    args[0] = slug;
  }
  return slug;
}

function assertImagePath(value) {
  if (value === null || value === undefined || value === '') return null;
  const imagePath = assertText(String(value), '图片路径', 1, 300);
  if (!/^\/assets\/[A-Za-z0-9._/-]+$/.test(imagePath) || imagePath.includes('..')) {
    throw new DomainError('图片必须使用 /assets/ 下的本地路径。', 'invalid_request', 422);
  }
  return imagePath;
}

function assertInteger(value, name, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw new DomainError(`${name} 无效。`, 'invalid_request', 422);
  }
  return numeric;
}

export class CommerceService {
  constructor({ db, config, paymentProvider, cardCrypto }) {
    this.db = db;
    this.config = config;
    this.paymentProvider = paymentProvider;
    this.cardCrypto = cardCrypto;
  }

  getUser(userId) {
    return toUser(one(this.db, 'SELECT * FROM users WHERE id = ?', userId));
  }

  upsertTelegramUser(telegramUser) {
    const telegramId = String(telegramUser.id);
    let photoUrl = null;
    if (typeof telegramUser.photo_url === 'string' && telegramUser.photo_url.length <= 1000) {
      try {
        const parsed = new URL(telegramUser.photo_url);
        if (parsed.protocol === 'https:') photoUrl = parsed.toString();
      } catch { /* Ignore malformed Telegram profile photos. */ }
    }
    const now = nowIso();
    const current = one(this.db, 'SELECT * FROM users WHERE telegram_id = ?', telegramId);
    const role = 'customer';
    if (current) {
      run(
        this.db,
        `UPDATE users
         SET username = ?, first_name = ?, last_name = ?, language_code = ?, photo_url = COALESCE(?, photo_url), role = ?, updated_at = ?
         WHERE id = ?`,
        telegramUser.username ?? null,
        telegramUser.first_name,
        telegramUser.last_name ?? null,
        telegramUser.language_code ?? null,
        photoUrl,
        role,
        now,
        current.id,
      );
      return this.getUser(current.id);
    }
    const id = randomId('usr_');
    run(
      this.db,
      `INSERT INTO users (id, telegram_id, username, first_name, last_name, language_code, photo_url, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      telegramId,
      telegramUser.username ?? null,
      telegramUser.first_name,
      telegramUser.last_name ?? null,
      telegramUser.language_code ?? null,
      photoUrl,
      role,
      now,
      now,
    );
    return this.getUser(id);
  }

  listCatalog() {
    const rows = many(
      this.db,
      `SELECT
         c.id AS category_id, c.name AS category_name, c.slug AS category_slug, c.position AS category_position,
         p.id AS product_id, p.title AS product_title, p.slug AS product_slug, p.description,
         p.instructions, p.image_url,
         v.id AS variant_id, v.name AS variant_name, v.sku, v.price_fen, v.max_per_order, v.position AS variant_position,
         (SELECT COUNT(*) FROM card_credentials cc
          WHERE cc.variant_id = v.id AND cc.state = 'available'
            AND (cc.expires_at IS NULL OR cc.expires_at > ?)) AS stock,
         (SELECT COUNT(*) FROM card_issuances ci
          JOIN card_credentials issued_card ON issued_card.id = ci.card_id
          WHERE issued_card.variant_id = v.id) AS sold
       FROM products p
       JOIN product_variants v ON v.product_id = p.id AND v.is_active = 1
       LEFT JOIN categories c ON c.id = p.category_id AND c.is_active = 1
       WHERE p.status = 'active'
       ORDER BY c.position, c.name, p.created_at DESC, v.position, v.name`,
      nowIso(),
    );
    const products = new Map();
    for (const row of rows) {
      let product = products.get(row.product_id);
      if (!product) {
        product = {
          id: row.product_id,
          title: row.product_title,
          slug: row.product_slug,
          description: row.description,
          instructions: row.instructions,
          imageUrl: row.image_url,
          category:
            row.category_id && row.category_name
              ? { id: row.category_id, name: row.category_name, slug: row.category_slug }
              : null,
          variants: [],
        };
        products.set(row.product_id, product);
      }
      product.variants.push({
        id: row.variant_id,
        name: row.variant_name,
        sku: row.sku,
        priceFen: Number(row.price_fen),
        maxPerOrder: Number(row.max_per_order),
        stock: Number(row.stock),
        sold: Number(row.sold),
      });
    }
    return [...products.values()];
  }

  createOrder(user, input) {
    const variantId = assertText(input.variantId, '商品规格', 1, 128);
    const quantity = assertInteger(input.quantity, '购买数量', 1, 20);
    const requestKey = assertText(input.idempotencyKey, '请求标识', 8, 128);

    const existing = this.findOrderByRequest(user.id, requestKey);
    if (existing) return this.ensurePaymentSession(assertIdempotentOrderMatches(existing, variantId, quantity), user.id);

    let localOrder;
    try {
      localOrder = transaction(this.db, () => {
        const concurrent = this.findOrderByRequest(user.id, requestKey);
        if (concurrent) return assertIdempotentOrderMatches(concurrent, variantId, quantity);
        const variant = one(
          this.db,
          `SELECT p.id AS product_id, p.title AS product_title, p.status AS product_status,
                  v.id AS variant_id, v.name AS variant_name, v.price_fen, v.max_per_order, v.is_active
           FROM product_variants v JOIN products p ON p.id = v.product_id
           WHERE v.id = ?`,
          variantId,
        );
        if (!variant || variant.product_status !== 'active' || !asBoolean(variant.is_active)) {
          throw new DomainError('商品当前不可购买。', 'product_unavailable', 409);
        }
        if (quantity > Number(variant.max_per_order)) {
          throw new DomainError(`该商品单次最多购买 ${variant.max_per_order} 件。`, 'quantity_exceeded', 422);
        }
        const cards = many(
          this.db,
          `SELECT id FROM card_credentials
           WHERE variant_id = ? AND state = 'available'
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY created_at, id LIMIT ?`,
          variantId,
          nowIso(),
          quantity,
        );
        if (cards.length !== quantity) {
          throw new DomainError('库存不足，请稍后重试。', 'insufficient_stock', 409);
        }
        const now = nowIso();
        const id = randomId('ord_');
        const orderNo = orderNumber();
        const totalPriceFen = Number(variant.price_fen) * quantity;
        run(
          this.db,
          `INSERT INTO orders (
             id, order_no, user_id, product_id, variant_id, product_title_snapshot,
             variant_name_snapshot, quantity, unit_price_fen, total_price_fen,
             status, fulfillment_status, payment_deadline, client_request_key, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment', 'pending', ?, ?, ?, ?)`,
          id,
          orderNo,
          user.id,
          variant.product_id,
          variant.variant_id,
          variant.product_title,
          variant.variant_name,
          quantity,
          Number(variant.price_fen),
          totalPriceFen,
          addMinutes(this.config.paymentTtlMinutes),
          requestKey,
          now,
          now,
        );
        for (const card of cards) {
          const changed = run(
            this.db,
            `UPDATE card_credentials
             SET state = 'reserved', reserved_for_order_id = ?, reserved_at = ?
             WHERE id = ? AND state = 'available'`,
            id,
            now,
            card.id,
          ).changes;
          if (changed !== 1) throw new DomainError('库存锁定冲突，请重新下单。', 'inventory_conflict', 409);
        }
        run(
          this.db,
          `INSERT INTO payment_transactions (
             id, order_id, provider, merchant_order_id, idempotency_key, status,
             fiat_amount, fiat_currency, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'awaiting_payment', ?, 'CNY', ?, ?)`,
          randomId('pay_'),
          id,
          this.paymentProvider.name,
          orderNo,
          orderNo,
          (totalPriceFen / 100).toFixed(2),
          now,
          now,
        );
        return this.findOrderByNo(orderNo, user.id);
      });
    } catch (error) {
      if (isSqliteUniqueError(error)) {
        const duplicate = this.findOrderByRequest(user.id, requestKey);
        if (duplicate) return this.ensurePaymentSession(assertIdempotentOrderMatches(duplicate, variantId, quantity), user.id);
      }
      throw error;
    }
    return this.ensurePaymentSession(localOrder, user.id);
  }

  async ensurePaymentSession(order, userId) {
    if (!order) throw new Error('Order was not created.');
    if (order.checkout_url || order.payment_instructions !== '{}' || order.payment_status === 'paid' || order.status !== 'pending_payment') {
      return toOrderSummary(order);
    }
    let session;
    try {
      session = await this.paymentProvider.createPayment({
        merchantOrderId: order.merchant_order_id,
        amountFen: Number(order.total_price_fen),
        metadata: { order_no: order.order_no, user_id: userId },
        successUrl: new URL(`/orders/${order.order_no}?payment=success`, this.config.appOrigin).toString(),
        cancelUrl: new URL(`/orders/${order.order_no}?payment=cancel`, this.config.appOrigin).toString(),
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const now = nowIso();
      run(
        this.db,
        `UPDATE payment_transactions
         SET provider_payload = ?, updated_at = ?
         WHERE order_id = ? AND status != 'paid'`,
        JSON.stringify({
          sessionError: typeof error?.code === 'string' ? error.code : 'payment_session_error',
          attemptedAt: now,
        }),
        now,
        order.id,
      );
      // Keep the reservation: an upstream timeout can mean the idempotent order exists remotely.
      throw new DomainError(
        '支付渠道暂时不可用，订单与库存已保留，请从订单列表再次打开支付。',
        'payment_session_pending',
        503,
      );
    }

    if (!session || session.provider !== this.paymentProvider.name || typeof session.providerOrderId !== 'string' || !session.providerOrderId) {
      throw new DomainError('支付渠道返回了无效订单。', 'invalid_payment_session', 502);
    }
    const providerStatuses = ['awaiting_payment', 'pending', 'confirming', 'paid', 'expired', 'canceled'];
    if (!providerStatuses.includes(session.status)) {
      throw new DomainError('支付渠道返回了无效状态。', 'invalid_payment_session', 502);
    }
    let paymentInstructions = null;
    if (session.paymentInstructions) {
      try {
        paymentInstructions = normalizePaymentInstructions(session.paymentInstructions);
      } catch {
        throw new DomainError('支付渠道返回了无效的内嵌付款信息。', 'invalid_payment_session', 502);
      }
    }
    if (session.status === 'paid' && (!session.fiatCurrency || !session.fiatAmount)) {
      try {
        const verified = await this.paymentProvider.getOrder(session.providerOrderId);
        session = {
          ...session,
          ...verified,
          provider: this.paymentProvider.name,
          checkoutUrl: session.checkoutUrl ?? null,
          expiresAt: session.expiresAt ?? null,
          raw: verified.raw ?? session.raw ?? {},
        };
      } catch {
        throw new DomainError('支付订单已完成，但暂时无法核验金额，已停止自动发卡。', 'payment_confirmation_incomplete', 503);
      }
    }
    if (['awaiting_payment', 'pending'].includes(session.status) && !paymentInstructions) {
      throw new DomainError('支付渠道未返回可用的内嵌付款信息。', 'invalid_payment_session', 502);
    }
    if (session.checkoutUrl) {
      let checkoutUrl;
      try {
        checkoutUrl = new URL(session.checkoutUrl);
      } catch {
        throw new DomainError('支付渠道返回了无效收银台地址。', 'invalid_payment_session', 502);
      }
      if (!['http:', 'https:'].includes(checkoutUrl.protocol) || (this.config.isProduction && checkoutUrl.protocol !== 'https:')) {
        throw new DomainError('支付渠道返回了不安全的收银台地址。', 'invalid_payment_session', 502);
      }
    }
    if (session.payableAmount && !canonicalDecimal(session.payableAmount)) {
      throw new DomainError('支付渠道返回了无效金额。', 'invalid_payment_session', 502);
    }
    const parsedExpiry = session.expiresAt ? new Date(session.expiresAt) : null;
    if (parsedExpiry && Number.isNaN(parsedExpiry.getTime())) {
      throw new DomainError('支付渠道返回了无效过期时间。', 'invalid_payment_session', 502);
    }

    transaction(this.db, () => {
      const current = this.findOrderByNo(order.order_no, userId);
      if (!current || current.checkout_url || current.payment_status === 'paid') return;
      const now = nowIso();
      const expiry = session.expiresAt ?? current.payment_deadline;
      const sessionIsTerminal = !['awaiting_payment', 'pending'].includes(session.status);
      run(
        this.db,
        `UPDATE payment_transactions
         SET provider_order_id = COALESCE(provider_order_id, ?),
             status = CASE WHEN status = 'paid' OR ? = 1 THEN status ELSE ? END,
             payable_amount = COALESCE(?, payable_amount),
             chain = COALESCE(?, chain), token_id = COALESCE(?, token_id),
             pay_address = COALESCE(?, pay_address), checkout_url = COALESCE(checkout_url, ?),
             payment_instructions = COALESCE(?, payment_instructions),
             provider_expires_at = COALESCE(?, provider_expires_at), provider_payload = ?, updated_at = ?
         WHERE order_id = ?`,
        session.providerOrderId,
        sessionIsTerminal ? 1 : 0,
        session.status,
        session.payableAmount ?? null,
        session.chain ?? null,
        session.tokenId ?? null,
        session.payAddress ?? null,
        session.checkoutUrl ?? null,
        paymentInstructions ? JSON.stringify(paymentInstructions) : null,
        expiry,
        JSON.stringify(session.raw ?? {}),
        now,
        current.id,
      );
      run(
        this.db,
        `UPDATE orders SET payment_deadline = ?, updated_at = ?
         WHERE id = ? AND status = 'pending_payment'`,
        expiry,
        now,
        current.id,
      );
      if (sessionIsTerminal) {
        const payment = this.findOrderByNo(order.order_no, userId);
        this.applyPaymentState(payment, {
          providerStatus: session.status,
          providerOrderId: session.providerOrderId,
          merchantOrderId: session.merchantOrderId ?? order.merchant_order_id,
          chain: session.chain ?? null,
          tokenId: session.tokenId ?? null,
          payableAmount: session.payableAmount ?? null,
          fiatCurrency: session.fiatCurrency ?? null,
          fiatAmount: session.fiatAmount ?? null,
          paidAt: session.paidAt ?? null,
          transactionId: session.transactionId ?? null,
          payload: session.raw ?? {},
        });
      }
    });
    const refreshed = this.findOrderByNo(order.order_no, userId);
    return toOrderSummary(refreshed);
  }

  retryPaymentSession(orderNo, userId) {
    const order = this.findOrderByNo(orderNo, userId);
    if (!order) throw new DomainError('订单不存在。', 'order_not_found', 404);
    if (order.status !== 'pending_payment') {
      throw new DomainError('当前订单无需重新创建支付会话。', 'payment_not_retryable', 409);
    }
    return this.ensurePaymentSession(order, userId);
  }

  listOrders(userId) {
    return many(
      this.db,
      `${orderWithPayment} WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 100`,
      userId,
    ).map(toOrderSummary);
  }

  getOrderForUser(orderNo, userId) {
    const order = this.findOrderByNo(orderNo, userId);
    if (!order) throw new DomainError('订单不存在。', 'order_not_found', 404);
    const cards = many(
      this.db,
      `SELECT cc.id, cc.code_ciphertext, cc.password_ciphertext, cc.note_ciphertext, cc.expires_at
       FROM card_issuances ci
       JOIN card_credentials cc ON cc.id = ci.card_id
       WHERE ci.order_id = ? ORDER BY ci.issued_at, cc.id`,
      order.id,
    );
    return {
      ...toOrderSummary(order),
      cards: cards.map((card) => ({
        id: card.id,
        code: this.cardCrypto.decrypt(card.code_ciphertext),
        password: card.password_ciphertext ? this.cardCrypto.decrypt(card.password_ciphertext) : null,
        note: card.note_ciphertext ? this.cardCrypto.decrypt(card.note_ciphertext) : null,
        expiresAt: card.expires_at,
      })),
    };
  }

  processWebhook(event) {
    return transaction(this.db, () => {
      const receivedAt = nowIso();
      const eventPayload = JSON.stringify(event);
      const inserted = run(
        this.db,
        `INSERT OR IGNORE INTO payment_webhook_events
         (id, provider, provider_event_id, event_type, payload, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        randomId('evt_'),
        this.paymentProvider.name,
        event.event_id,
        event.event_type,
        eventPayload,
        receivedAt,
      );
      const duplicate = !inserted.changes;
      if (duplicate) {
        const previous = one(
          this.db,
          'SELECT payload, processed_at, processing_error FROM payment_webhook_events WHERE provider = ? AND provider_event_id = ?',
          this.paymentProvider.name,
          event.event_id,
        );
        if (previous?.payload !== eventPayload) {
          run(
            this.db,
            `UPDATE payment_webhook_events
             SET processing_error = 'webhook_payload_conflict: duplicate event ID received with different payload'
             WHERE provider = ? AND provider_event_id = ?`,
            this.paymentProvider.name,
            event.event_id,
          );
          return { duplicate: true, processed: false, error: 'webhook_payload_conflict' };
        }
        if (previous?.processed_at && !previous.processing_error) {
          return { duplicate: true, processed: true, error: null };
        }
      }

      this.db.exec('SAVEPOINT webhook_business');
      try {
        this.applyWebhookEvent(event);
        this.db.exec('RELEASE SAVEPOINT webhook_business');
        run(
          this.db,
          `UPDATE payment_webhook_events
           SET processed_at = ?, processing_error = NULL
           WHERE provider = ? AND provider_event_id = ?`,
          nowIso(),
          this.paymentProvider.name,
          event.event_id,
        );
        return { duplicate, processed: true, error: null };
      } catch (error) {
        this.db.exec('ROLLBACK TO SAVEPOINT webhook_business');
        this.db.exec('RELEASE SAVEPOINT webhook_business');
        const code = error instanceof DomainError ? error.code : 'webhook_processing_failed';
        const message = `${code}: ${error instanceof Error ? error.message : 'Unknown webhook processing error'}`.slice(0, 900);
        run(
          this.db,
          `UPDATE payment_webhook_events
           SET processed_at = NULL, processing_error = ?
           WHERE provider = ? AND provider_event_id = ?`,
          message,
          this.paymentProvider.name,
          event.event_id,
        );
        return { duplicate, processed: false, error: code };
      }
    });
  }

  listWebhookFailures(limit = 100) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    return many(
      this.db,
      `SELECT provider_event_id, event_type, processing_error, received_at, processed_at
       FROM payment_webhook_events
       WHERE processing_error IS NOT NULL
       ORDER BY received_at DESC LIMIT ?`,
      safeLimit,
    );
  }

  applyWebhookEvent(event) {
    if (['webhook.test', 'unmatched_claim.claimed'].includes(event.event_type)) return;
    const data = event.data ?? {};
    const merchantOrderId = data.merchant_order_id;
    const providerOrderId = data.order_id;

    if (event.event_type === 'refund.recorded') {
      const payment = typeof merchantOrderId === 'string' ? this.findOrderByMerchantId(merchantOrderId) : null;
      this.audit(null, 'refund.recorded', payment ? 'order' : 'payment_refund', payment?.id ?? event.event_id, {
        eventId: event.event_id,
        providerOrderId: typeof providerOrderId === 'string' ? providerOrderId : null,
        merchantOrderId: typeof merchantOrderId === 'string' ? merchantOrderId : null,
        refundStatus: typeof data.status === 'string' ? data.status : null,
      });
      return;
    }

    if (typeof merchantOrderId !== 'string' || typeof providerOrderId !== 'string') {
      throw new DomainError('支付回调缺少订单标识。', 'invalid_webhook', 400);
    }

    // 余额充值走独立的充值支付状态，不参与订单发卡
    if (typeof merchantOrderId === 'string' && merchantOrderId.startsWith('RC')) {
      const payloadStatus = data.status === 'created' ? 'awaiting_payment' : data.status;
      const statusByEventType = {
        'order.method_selected': 'pending',
        'order.confirming': 'confirming',
        'order.paid': 'paid',
        'order.expired': 'expired',
        'order.canceled': 'canceled',
      };
      const status = event.event_type === 'order.created' ? payloadStatus : statusByEventType[event.event_type];
      if (!status || (event.event_type === 'order.created' && !['awaiting_payment', 'pending'].includes(status))) {
        throw new DomainError('支付回调事件状态无效。', 'invalid_webhook', 400);
      }
      this.applyRechargeProviderStatus(null, {
        providerStatus: status,
        providerOrderId,
        merchantOrderId,
        chain: typeof data.chain === 'string' ? data.chain : null,
        tokenId: typeof data.token_id === 'string' ? data.token_id : null,
        payableAmount: typeof data.payable_amount === 'string' ? data.payable_amount : null,
        transactionId: typeof data.tx_hash === 'string' ? data.tx_hash : typeof data.tx_id === 'string' ? data.tx_id : null,
        paidAt: event.event_type === 'order.paid' ? (data.paid_at ?? event.created_at) : null,
        payload: event,
      });
      return;
    }

    const payment = this.findOrderByMerchantId(merchantOrderId);
    if (!payment) throw new DomainError('支付回调对应的订单不存在。', 'unknown_payment_order', 404);
    if (payment.provider_order_id && payment.provider_order_id !== providerOrderId) {
      throw new DomainError('支付渠道订单号不匹配。', 'payment_order_mismatch', 409);
    }

    const payloadStatus = data.status === 'created' ? 'awaiting_payment' : data.status;
    const statusByEventType = {
      'order.method_selected': 'pending',
      'order.confirming': 'confirming',
      'order.paid': 'paid',
      'order.expired': 'expired',
      'order.canceled': 'canceled',
    };
    const status = event.event_type === 'order.created' ? payloadStatus : statusByEventType[event.event_type];
    if (!status || (event.event_type === 'order.created' && !['awaiting_payment', 'pending'].includes(status))) {
      throw new DomainError('支付回调事件状态无效。', 'invalid_webhook', 400);
    }
    if (event.event_type !== 'order.created' && typeof payloadStatus === 'string' && payloadStatus !== status) {
      throw new DomainError('支付回调状态与事件类型不匹配。', 'payment_status_mismatch', 409);
    }
    this.applyPaymentState(payment, {
      providerStatus: status,
      providerOrderId,
      merchantOrderId,
      chain: typeof data.chain === 'string' ? data.chain : null,
      tokenId: typeof data.token_id === 'string' ? data.token_id : null,
      payableAmount: typeof data.payable_amount === 'string' ? data.payable_amount : null,
      fiatCurrency: typeof data.fiat_currency === 'string' ? data.fiat_currency : null,
      fiatAmount: typeof data.fiat_amount === 'string' ? data.fiat_amount : null,
      paidAt: event.event_type === 'order.paid' ? (data.paid_at ?? event.created_at) : null,
      transactionId: typeof data.tx_hash === 'string' ? data.tx_hash : typeof data.tx_id === 'string' ? data.tx_id : null,
      payload: event,
    });
  }

  applyProviderOrder(providerOrder) {
    return transaction(this.db, () => {
      const payment = this.findOrderByProviderId(providerOrder.providerOrderId);
      if (!payment) return false;
      this.applyPaymentState(payment, {
        providerStatus: providerOrder.status,
        providerOrderId: providerOrder.providerOrderId,
        merchantOrderId: providerOrder.merchantOrderId,
        chain: providerOrder.chain,
        tokenId: providerOrder.tokenId,
        payableAmount: providerOrder.payableAmount,
        fiatCurrency: providerOrder.fiatCurrency,
        fiatAmount: providerOrder.fiatAmount,
        paidAt: providerOrder.paidAt,
        transactionId: providerOrder.transactionId,
        payload: providerOrder.raw ?? {},
      });
      return true;
    });
  }

  applyPaymentState(payment, incoming) {
    const status = incoming.providerStatus;
    if (!['awaiting_payment', 'pending', 'confirming', 'paid', 'expired', 'canceled'].includes(status)) return;
    if (incoming.merchantOrderId && incoming.merchantOrderId !== payment.merchant_order_id) {
      throw new DomainError('支付渠道订单不匹配。', 'payment_order_mismatch', 409);
    }
    if (payment.provider_order_id && incoming.providerOrderId && payment.provider_order_id !== incoming.providerOrderId) {
      throw new DomainError('支付渠道订单号不匹配。', 'payment_order_mismatch', 409);
    }
    if (payment.status === 'refunded' || payment.payment_status === 'refunded') return;
    const now = nowIso();

    if (status === 'paid') {
      this.assertPaidPaymentMatches(payment, incoming);
      const alreadyCompleted = payment.status === 'completed';
      const reservedCards = alreadyCompleted ? [] : this.refreshReservedCards(payment);
      const inventoryReady = alreadyCompleted || reservedCards.length === Number(payment.quantity);
      run(
        this.db,
        `UPDATE payment_transactions
         SET provider_order_id = COALESCE(provider_order_id, ?), status = 'paid',
             payable_amount = COALESCE(?, payable_amount), chain = COALESCE(?, chain),
             token_id = COALESCE(?, token_id), paid_at = COALESCE(?, paid_at),
             transaction_id = COALESCE(?, transaction_id), provider_payload = ?, updated_at = ?
         WHERE order_id = ?`,
        incoming.providerOrderId,
        incoming.payableAmount,
        incoming.chain,
        incoming.tokenId,
        incoming.paidAt,
        incoming.transactionId,
        JSON.stringify(incoming.payload),
        now,
        payment.id,
      );
      run(
        this.db,
        `UPDATE orders
         SET status = CASE
               WHEN status = 'completed' THEN 'completed'
               WHEN ? = 1 THEN 'paid'
               ELSE 'fulfillment_failed'
             END,
             fulfillment_status = CASE
               WHEN status = 'completed' THEN 'fulfilled'
               WHEN ? = 1 THEN 'pending'
               ELSE 'failed'
             END,
             failure_reason = CASE
               WHEN ? = 1 THEN NULL
               ELSE '付款已确认，但当前可发卡密库存不足，请补充库存后重试发卡。'
             END,
             updated_at = ?
         WHERE id = ?`,
        inventoryReady ? 1 : 0,
        inventoryReady ? 1 : 0,
        inventoryReady ? 1 : 0,
        now,
        payment.id,
      );
      if (!inventoryReady) {
        run(
          this.db,
          `UPDATE fulfillment_jobs
           SET status = 'failed', locked_at = NULL, last_error = 'paid_inventory_shortage', updated_at = ?
           WHERE order_id = ? AND status != 'completed'`,
          now,
          payment.id,
        );
        return;
      }
      run(
        this.db,
        `INSERT INTO fulfillment_jobs (id, order_id, status, attempts, run_after, created_at, updated_at)
         VALUES (?, ?, 'pending', 0, ?, ?, ?)
         ON CONFLICT(order_id) DO UPDATE SET
           status = CASE WHEN fulfillment_jobs.status = 'completed' THEN 'completed' ELSE 'pending' END,
           run_after = CASE WHEN fulfillment_jobs.status = 'completed' THEN fulfillment_jobs.run_after ELSE excluded.run_after END,
           locked_at = NULL, last_error = NULL, updated_at = excluded.updated_at`,
        randomId('job_'),
        payment.id,
        now,
        now,
        now,
      );
      return;
    }

    if (status === 'confirming') {
      if (payment.payment_status === 'paid') return;
      run(
        this.db,
        `UPDATE payment_transactions SET status = 'confirming', provider_payload = ?, updated_at = ? WHERE order_id = ?`,
        JSON.stringify(incoming.payload),
        now,
        payment.id,
      );
      run(
        this.db,
        `UPDATE orders SET status = 'payment_confirming', updated_at = ?
         WHERE id = ? AND status = 'pending_payment'`,
        now,
        payment.id,
      );
      return;
    }

    if (status === 'expired' || status === 'canceled') {
      if (payment.payment_status === 'paid' || ['paid', 'fulfilling', 'completed', 'fulfillment_failed'].includes(payment.status)) return;
      run(
        this.db,
        `UPDATE payment_transactions SET status = ?, provider_payload = ?, updated_at = ? WHERE order_id = ?`,
        status,
        JSON.stringify(incoming.payload),
        now,
        payment.id,
      );
      run(
        this.db,
        `UPDATE orders SET status = ?, updated_at = ?, failure_reason = NULL
         WHERE id = ? AND status IN ('pending_payment', 'payment_confirming')`,
        status === 'expired' ? 'payment_expired' : 'canceled',
        now,
        payment.id,
      );
      this.releaseCards(payment.id);
      return;
    }

    if (payment.payment_status !== 'paid') {
      run(
        this.db,
        `UPDATE payment_transactions
         SET provider_order_id = COALESCE(provider_order_id, ?), status = ?,
             payable_amount = COALESCE(?, payable_amount), chain = COALESCE(?, chain),
             token_id = COALESCE(?, token_id), provider_payload = ?, updated_at = ?
         WHERE order_id = ?`,
        incoming.providerOrderId,
        status,
        incoming.payableAmount,
        incoming.chain,
        incoming.tokenId,
        JSON.stringify(incoming.payload),
        now,
        payment.id,
      );
    }
  }

  assertPaidPaymentMatches(payment, incoming) {
    if (!incoming.providerOrderId || !incoming.fiatCurrency || !incoming.fiatAmount) {
      throw new DomainError('支付确认缺少订单金额或币种，已停止自动发卡。', 'payment_confirmation_incomplete', 409);
    }
    if (incoming.fiatCurrency !== payment.fiat_currency) {
      throw new DomainError('支付法币不匹配。', 'payment_currency_mismatch', 409);
    }
    if (incoming.fiatAmount && !isSameDecimal(incoming.fiatAmount, payment.fiat_amount)) {
      throw new DomainError('支付金额不匹配。', 'payment_amount_mismatch', 409);
    }
    if (payment.chain && incoming.chain && payment.chain !== incoming.chain) {
      throw new DomainError('支付链不匹配。', 'payment_chain_mismatch', 409);
    }
    if (payment.token_id && incoming.tokenId && payment.token_id !== incoming.tokenId) {
      throw new DomainError('支付代币不匹配。', 'payment_token_mismatch', 409);
    }
    if (payment.payable_amount && incoming.payableAmount && !isSameDecimal(payment.payable_amount, incoming.payableAmount)) {
      throw new DomainError('链上应付金额不匹配。', 'payment_amount_mismatch', 409);
    }
  }

  recoverStaleFulfillmentJobs(lockMinutes = 10) {
    return transaction(this.db, () => {
      const cutoff = new Date(Date.now() - lockMinutes * 60_000).toISOString();
      const staleJobs = many(
        this.db,
        `SELECT id, order_id FROM fulfillment_jobs
         WHERE status = 'processing' AND locked_at IS NOT NULL AND locked_at <= ?`,
        cutoff,
      );
      let recovered = 0;
      for (const staleJob of staleJobs) {
        const order = one(this.db, `${orderWithPayment} WHERE o.id = ?`, staleJob.order_id);
        const now = nowIso();
        if (order?.status === 'completed') {
          this.completeJob(staleJob.id);
          continue;
        }
        if (order?.payment_status === 'paid' && ['paid', 'fulfilling', 'fulfillment_failed'].includes(order.status)) {
          run(
            this.db,
            `UPDATE orders
             SET status = 'paid', fulfillment_status = 'pending', failure_reason = NULL, updated_at = ?
             WHERE id = ?`,
            now,
            order.id,
          );
        }
        run(
          this.db,
          `UPDATE fulfillment_jobs
           SET status = 'failed', run_after = ?, locked_at = NULL,
               last_error = 'worker_lock_expired', updated_at = ?
           WHERE id = ? AND status = 'processing'`,
          now,
          now,
          staleJob.id,
        );
        recovered += 1;
      }
      return recovered;
    });
  }

  claimFulfillmentJob() {
    return transaction(this.db, () => {
      const job = one(
        this.db,
        `SELECT fj.* FROM fulfillment_jobs fj
         JOIN orders o ON o.id = fj.order_id
         JOIN payment_transactions pt ON pt.order_id = o.id
         WHERE fj.status IN ('pending', 'failed') AND fj.run_after <= ? AND fj.attempts < 8
           AND o.status IN ('paid', 'fulfilling', 'fulfillment_failed')
           AND pt.status = 'paid'
         ORDER BY fj.run_after, fj.created_at LIMIT 1`,
        nowIso(),
      );
      if (!job) return null;
      const now = nowIso();
      run(
        this.db,
        `UPDATE fulfillment_jobs SET status = 'processing', locked_at = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = ?`,
        now,
        now,
        job.id,
      );
      return { id: job.id, orderId: job.order_id };
    });
  }

  refreshReservedCards(order) {
    const now = nowIso();
    const reserved = many(
      this.db,
      `SELECT * FROM card_credentials
       WHERE reserved_for_order_id = ? AND state = 'reserved'
       ORDER BY reserved_at, id`,
      order.id,
    );
    const activeReserved = reserved.filter((card) => !card.expires_at || card.expires_at > now);
    const expiredReserved = reserved.filter((card) => card.expires_at && card.expires_at <= now);
    for (const card of expiredReserved) {
      run(
        this.db,
        `UPDATE card_credentials
         SET state = 'disabled', reserved_for_order_id = NULL, reserved_at = NULL
         WHERE id = ? AND state = 'reserved'`,
        card.id,
      );
    }
    const missing = Number(order.quantity) - activeReserved.length;
    if (missing > 0) {
      const replacements = many(
        this.db,
        `SELECT id FROM card_credentials
         WHERE variant_id = ? AND state = 'available'
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at, id LIMIT ?`,
        order.variant_id,
        now,
        missing,
      );
      for (const card of replacements) {
        run(
          this.db,
          `UPDATE card_credentials
           SET state = 'reserved', reserved_for_order_id = ?, reserved_at = ?
           WHERE id = ? AND state = 'available'`,
          order.id,
          now,
          card.id,
        );
      }
    }
    return many(
      this.db,
      `SELECT * FROM card_credentials
       WHERE reserved_for_order_id = ? AND state = 'reserved'
       ORDER BY reserved_at, id`,
      order.id,
    );
  }

  fulfillJob(job) {
    try {
      transaction(this.db, () => {
        const order = one(this.db, 'SELECT * FROM orders WHERE id = ?', job.orderId);
        if (!order) throw new Error('Order no longer exists.');
        if (order.status === 'completed') {
          this.completeJob(job.id);
          return;
        }
        if (!['paid', 'fulfilling', 'fulfillment_failed'].includes(order.status)) {
          throw new Error('Order is not eligible for fulfillment.');
        }
        const cards = this.refreshReservedCards(order);
        if (cards.length !== Number(order.quantity)) {
          throw new Error(`Available card count ${cards.length} does not equal order quantity ${order.quantity}.`);
        }
        const now = nowIso();
        run(
          this.db,
          `UPDATE orders SET status = 'fulfilling', fulfillment_status = 'processing', failure_reason = NULL, updated_at = ?
           WHERE id = ?`,
          now,
          order.id,
        );
        for (const card of cards) {
          run(
            this.db,
            `UPDATE card_credentials SET state = 'issued', issued_at = ?, reserved_at = NULL
             WHERE id = ? AND state = 'reserved'`,
            now,
            card.id,
          );
          run(
            this.db,
            `INSERT OR IGNORE INTO card_issuances (id, order_id, card_id, issued_at)
             VALUES (?, ?, ?, ?)`,
            randomId('iss_'),
            order.id,
            card.id,
            now,
          );
        }
        run(
          this.db,
          `UPDATE orders SET status = 'completed', fulfillment_status = 'fulfilled', fulfilled_at = ?, updated_at = ?
           WHERE id = ?`,
          now,
          now,
          order.id,
        );
        this.completeJob(job.id);
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 900) : 'Unknown fulfillment error';
      transaction(this.db, () => {
        const now = nowIso();
        run(
          this.db,
          `UPDATE fulfillment_jobs
           SET status = 'failed', run_after = ?, locked_at = NULL, last_error = ?, updated_at = ?
           WHERE id = ?`,
          addMinutes(1),
          message,
          now,
          job.id,
        );
        run(
          this.db,
          `UPDATE orders SET status = 'fulfillment_failed', fulfillment_status = 'failed', failure_reason = ?, updated_at = ?
           WHERE id = ? AND status NOT IN ('completed', 'refunded')`,
          message,
          now,
          job.orderId,
        );
      });
      throw error;
    }
  }

  processJobs(limit = 20) {
    let completed = 0;
    for (let index = 0; index < limit; index += 1) {
      const job = this.claimFulfillmentJob();
      if (!job) break;
      this.fulfillJob(job);
      completed += 1;
    }
    return completed;
  }

  async reconcileDuePayments(limit = 30) {
    const retryBefore = new Date(Date.now() - 60_000).toISOString();
    const due = many(
      this.db,
      `${orderWithPayment}
       WHERE o.status IN ('pending_payment', 'payment_confirming')
         AND o.payment_deadline <= ?
         AND pt.updated_at <= ?
       ORDER BY o.payment_deadline LIMIT ?`,
      nowIso(),
      retryBefore,
      limit,
    );
    let processed = 0;
    for (const order of due) {
      try {
        if (!order.provider_order_id) {
          await this.ensurePaymentSession(order, order.user_id);
        } else {
          const providerOrder = await this.paymentProvider.getOrder(order.provider_order_id);
          this.applyProviderOrder(providerOrder);
        }
        processed += 1;
      } catch (error) {
        const now = nowIso();
        run(
          this.db,
          `UPDATE payment_transactions
           SET provider_payload = ?, updated_at = ?
           WHERE order_id = ? AND status != 'paid'`,
          JSON.stringify({
            reconciliationError: typeof error?.code === 'string' ? error.code : 'payment_reconciliation_error',
            attemptedAt: now,
          }),
          now,
          order.id,
        );
        // Keep stock reserved until the provider confirms an expired or canceled state.
      }
    }
    return processed;
  }

  async reconcileDueRecharges(limit = 30) {
    const retryBefore = new Date(Date.now() - 60_000).toISOString();
    const due = many(
      this.db,
      `SELECT r.id, r.recharge_no, r.user_id, r.amount_fen, r.payment_deadline,
              p.provider_order_id, p.status AS payment_status
       FROM recharge_orders r
       JOIN recharge_payments p ON p.recharge_id = r.id
       WHERE r.status IN ('pending_payment', 'payment_confirming')
         AND r.payment_deadline <= ?
         AND p.updated_at <= ?
       ORDER BY r.payment_deadline LIMIT ?`,
      nowIso(),
      retryBefore,
      limit,
    );
    let processed = 0;
    for (const recharge of due) {
      try {
        if (!recharge.provider_order_id) {
          const summary = this.rechargeByNo(recharge.user_id, recharge.recharge_no);
          await this.ensureRechargeSession(summary, recharge.user_id);
        } else {
          const providerOrder = await this.paymentProvider.getOrder(recharge.provider_order_id);
          this.applyRechargeProviderStatus(null, {
            providerStatus: providerOrder.status,
            providerOrderId: providerOrder.providerOrderId,
            merchantOrderId: providerOrder.merchantOrderId ?? recharge.recharge_no,
            chain: providerOrder.chain,
            tokenId: providerOrder.tokenId,
            payableAmount: providerOrder.payableAmount,
            transactionId: providerOrder.transactionId ?? null,
            paidAt: providerOrder.paidAt ?? null,
            payload: providerOrder.raw ?? {},
          });
        }
        processed += 1;
      } catch (error) {
        const now = nowIso();
        run(
          this.db,
          `UPDATE recharge_payments SET provider_payload = ?, updated_at = ? WHERE recharge_id = ? AND status != 'paid'`,
          JSON.stringify({
            reconciliationError: typeof error?.code === 'string' ? error.code : 'recharge_reconciliation_error',
            attemptedAt: now,
          }),
          now,
          recharge.id,
        );
      }
    }
    return processed;
  }

  listPendingRechargeForWorker(limit = 5) {
    // 供 Worker 心跳展示是否还有待确认的充值
    return one(
      this.db,
      `SELECT COUNT(*) AS count FROM recharge_orders WHERE status IN ('pending_payment', 'payment_confirming')`,
    )?.count ?? 0;
  }

  importCards(actor, input) {
    const variantId = assertText(input.variantId, 'SKU', 1, 128);
    const label = assertText(input.batchLabel, '批次名称', 1, 120);
    if (!Array.isArray(input.cards) || input.cards.length < 1 || input.cards.length > 5000) {
      throw new DomainError('一次导入的卡密数量必须在 1 到 5000 之间。', 'invalid_request', 422);
    }
    return transaction(this.db, () => {
      if (!one(this.db, 'SELECT id FROM product_variants WHERE id = ?', variantId)) {
        throw new DomainError('SKU 不存在。', 'variant_not_found', 404);
      }
      const batchId = randomId('batch_');
      const now = nowIso();
      run(
        this.db,
        `INSERT INTO card_batches (id, variant_id, label, imported_by, total_count, valid_count, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
        batchId,
        variantId,
        label,
        actor.id,
        input.cards.length,
        now,
      );
      let imported = 0;
      for (const rawCard of input.cards) {
        const code = assertText(rawCard.code, '卡密', 1, 4096);
        const fingerprint = this.cardCrypto.fingerprint(code);
        const exists = one(this.db, 'SELECT id FROM card_credentials WHERE code_fingerprint = ?', fingerprint);
        if (exists) continue;
        let expiresAt = null;
        if (rawCard.expiresAt) {
          const parsedExpiry = new Date(rawCard.expiresAt);
          if (Number.isNaN(parsedExpiry.getTime())) {
            throw new DomainError('卡密有效期格式无效。', 'invalid_request', 422);
          }
          expiresAt = parsedExpiry.toISOString();
        }
        run(
          this.db,
          `INSERT INTO card_credentials
           (id, variant_id, batch_id, code_ciphertext, code_fingerprint, password_ciphertext, note_ciphertext, expires_at, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?)`,
          randomId('card_'),
          variantId,
          batchId,
          this.cardCrypto.encrypt(code),
          fingerprint,
          rawCard.password ? this.cardCrypto.encrypt(String(rawCard.password).trim()) : null,
          rawCard.note ? this.cardCrypto.encrypt(String(rawCard.note).trim()) : null,
          expiresAt,
          now,
        );
        imported += 1;
      }
      run(this.db, 'UPDATE card_batches SET valid_count = ? WHERE id = ?', imported, batchId);
      this.audit(actor.id, 'cards.imported', 'card_batch', batchId, {
        variantId,
        received: input.cards.length,
        imported,
        duplicate: input.cards.length - imported,
      });
      return { batchId, received: input.cards.length, imported, duplicate: input.cards.length - imported };
    });
  }

  createCategory(actor, input) {
    const id = randomId('cat_');
    const now = nowIso();
    const categoryName = assertText(input.name, '分类名称', 1, 80);
    const category = {
      id,
      name: categoryName,
      slug: input.slug && String(input.slug).trim() ? assertSlug(input.slug) : uniqueSlug(this.db, 'categories', 'slug', categoryName),
      position: assertInteger(input.position ?? 0, '排序', 0, 10000),
    };
    run(
      this.db,
      `INSERT INTO categories (id, name, slug, position, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      category.id,
      category.name,
      category.slug,
      category.position,
      now,
      now,
    );
    this.audit(actor.id, 'category.created', 'category', id, { slug: category.slug });
    return category;
  }

  createProduct(actor, input) {
    const now = nowIso();
    const id = randomId('prd_');
    const status = ['draft', 'active', 'archived'].includes(input.status) ? input.status : 'draft';
    const categoryId = input.categoryId || null;
    if (categoryId && !one(this.db, 'SELECT id FROM categories WHERE id = ?', categoryId)) {
      throw new DomainError('分类不存在。', 'category_not_found', 404);
    }
    const productTitle = assertText(input.title, '商品名称', 1, 160);
    const productSlug = input.slug && String(input.slug).trim() ? assertSlug(input.slug) : uniqueSlug(this.db, 'products', 'slug', productTitle);
    run(
      this.db,
      `INSERT INTO products (id, category_id, title, slug, description, instructions, image_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      categoryId,
      productTitle,
      productSlug,
      String(input.description ?? '').trim(),
      String(input.instructions ?? '').trim(),
      assertImagePath(input.imageUrl),
      status,
      now,
      now,
    );
    this.audit(actor.id, 'product.created', 'product', id, { slug: productSlug });
    return { id, slug: productSlug };
  }

  updateProduct(actor, productId, input) {
    const current = one(this.db, 'SELECT * FROM products WHERE id = ?', productId);
    if (!current) throw new DomainError('商品不存在。', 'product_not_found', 404);
    const categoryId = input.categoryId === undefined ? current.category_id : input.categoryId || null;
    if (categoryId && !one(this.db, 'SELECT id FROM categories WHERE id = ?', categoryId)) {
      throw new DomainError('分类不存在。', 'category_not_found', 404);
    }
    const status = input.status === undefined ? current.status : input.status;
    if (!['draft', 'active', 'archived'].includes(status)) throw new DomainError('商品状态无效。', 'invalid_request', 422);
    const nextTitle = input.title === undefined ? current.title : assertText(input.title, '商品名称', 1, 160);
    const nextSlug =
      input.slug === undefined
        ? current.slug
        : input.slug && String(input.slug).trim()
          ? assertSlug(input.slug)
          : uniqueSlug(this.db, 'products', 'slug', nextTitle, productId);
    run(
      this.db,
      `UPDATE products SET category_id = ?, title = ?, slug = ?, description = ?, instructions = ?, image_url = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      categoryId,
      nextTitle,
      nextSlug,
      input.description === undefined ? current.description : String(input.description).trim(),
      input.instructions === undefined ? current.instructions : String(input.instructions).trim(),
      input.imageUrl === undefined ? current.image_url : assertImagePath(input.imageUrl),
      status,
      nowIso(),
      productId,
    );
    this.audit(actor.id, 'product.updated', 'product', productId, { fields: Object.keys(input) });
    return { id: productId, slug: nextSlug, title: nextTitle };
  }

  createVariant(actor, input) {
    if (!one(this.db, 'SELECT id FROM products WHERE id = ?', input.productId)) {
      throw new DomainError('商品不存在。', 'product_not_found', 404);
    }
    const id = randomId('sku_');
    const now = nowIso();
    run(
      this.db,
      `INSERT INTO product_variants (id, product_id, name, sku, price_fen, max_per_order, position, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.productId,
      assertText(input.name, '规格名称', 1, 120),
      assertText(input.sku, 'SKU', 1, 100),
      assertInteger(input.priceFen, '价格', 1, 100000000),
      assertInteger(input.maxPerOrder ?? 5, '单次限购', 1, 20),
      assertInteger(input.position ?? 0, '排序', 0, 10000),
      input.isActive === false ? 0 : 1,
      now,
      now,
    );
    this.audit(actor.id, 'variant.created', 'variant', id, { sku: input.sku });
    return { id };
  }

  updateVariant(actor, variantId, input) {
    const current = one(this.db, 'SELECT * FROM product_variants WHERE id = ?', variantId);
    if (!current) throw new DomainError('SKU 不存在。', 'variant_not_found', 404);
    run(
      this.db,
      `UPDATE product_variants
       SET name = ?, sku = ?, price_fen = ?, max_per_order = ?, position = ?, is_active = ?, updated_at = ?
       WHERE id = ?`,
      input.name === undefined ? current.name : assertText(input.name, '规格名称', 1, 120),
      input.sku === undefined ? current.sku : assertText(input.sku, 'SKU', 1, 100),
      input.priceFen === undefined ? current.price_fen : assertInteger(input.priceFen, '价格', 1, 100000000),
      input.maxPerOrder === undefined ? current.max_per_order : assertInteger(input.maxPerOrder, '单次限购', 1, 20),
      input.position === undefined ? current.position : assertInteger(input.position, '排序', 0, 10000),
      input.isActive === undefined ? current.is_active : input.isActive ? 1 : 0,
      nowIso(),
      variantId,
    );
    this.audit(actor.id, 'variant.updated', 'variant', variantId, { fields: Object.keys(input) });
  }

  dashboard() {
    const row = one(
      this.db,
      `SELECT
        COALESCE(SUM(total_price_fen) FILTER (WHERE status IN ('paid', 'fulfilling', 'completed')), 0) AS paid_revenue_fen,
        COUNT(*) FILTER (WHERE status IN ('paid', 'fulfilling', 'completed')) AS paid_orders,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed_orders,
        COUNT(*) FILTER (WHERE status = 'fulfillment_failed') AS failed_fulfillments
       FROM orders`,
    );
    return {
      paidRevenueFen: Number(row.paid_revenue_fen),
      paidOrders: Number(row.paid_orders),
      completedOrders: Number(row.completed_orders),
      failedFulfillments: Number(row.failed_fulfillments),
      issuedCards: Number(one(this.db, 'SELECT COUNT(*) AS total FROM card_issuances').total),
      availableCards: Number(one(this.db, `SELECT COUNT(*) AS total FROM card_credentials WHERE state = 'available' AND (expires_at IS NULL OR expires_at > ?)`, nowIso()).total),
      activeProducts: Number(one(this.db, `SELECT COUNT(*) AS total FROM products WHERE status = 'active'`).total),
    };
  }

  listAdminUsers() {
    return many(
      this.db,
      `SELECT
         u.id, u.telegram_id, u.username, u.first_name, u.last_name,
         u.language_code, u.photo_url, u.is_active, u.created_at, u.updated_at,
         COUNT(o.id) AS order_count,
         SUM(CASE WHEN o.status IN ('paid', 'fulfilling', 'completed') THEN 1 ELSE 0 END) AS paid_order_count,
         COALESCE(SUM(CASE WHEN o.status IN ('paid', 'fulfilling', 'completed') THEN o.total_price_fen ELSE 0 END), 0) AS spent_fen,
         MAX(o.created_at) AS last_order_at
       FROM users u
       LEFT JOIN orders o ON o.user_id = u.id
       WHERE u.role != 'admin' AND u.telegram_id NOT LIKE 'admin:%'
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT 500`,
    ).map((user) => ({
      id: user.id,
      telegramId: user.telegram_id,
      username: user.username,
      firstName: user.first_name,
      lastName: user.last_name,
      languageCode: user.language_code,
      photoUrl: user.photo_url,
      isActive: asBoolean(user.is_active),
      balanceFen: Number(user.balance_fen),
      orderCount: Number(user.order_count),
      paidOrderCount: Number(user.paid_order_count),
      spentFen: Number(user.spent_fen),
      lastOrderAt: user.last_order_at,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
    }));
  }

  adjustUserBalance(actor, userId, deltaFen, options = {}) {
    const kind = options.kind ?? 'adjust';
    const memo = options.memo ?? '';
    deltaFen = Number(deltaFen);
    if (!Number.isInteger(deltaFen) || deltaFen === 0) throw new DomainError('变动金额必须是整数分且不能为 0。', 'invalid_request', 422);
    const user = one(this.db, `SELECT * FROM users WHERE id = ? AND role != 'admin' AND telegram_id NOT LIKE 'admin:%'`, userId);
    if (!user) throw new DomainError('用户不存在。', 'user_not_found', 404);
    const current = Number(user.balance_fen ?? 0);
    const next = current + deltaFen;
    if (next < 0) throw new DomainError('余额不足，无法扣减。', 'insufficient_balance', 422);
    const id = randomId('bal_');
    const now = nowIso();
    transaction(this.db, () => {
      run(this.db, 'UPDATE users SET balance_fen = ?, updated_at = ? WHERE id = ?', next, now, userId);
      run(
        this.db,
        `INSERT INTO balance_entries (id, user_id, change_fen, balance_after_fen, kind, memo, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        userId,
        deltaFen,
        next,
        ['recharge', 'adjust', 'purchase', 'refund', 'expire'].includes(kind) ? kind : 'adjust',
        memo,
        options.source ?? 'manual',
        now,
      );
    });
    this.audit(actor.id, `balance.${deltaFen > 0 ? 'credit' : 'debit'}`, 'user', userId, {
      changeFen: deltaFen,
      balanceAfterFen: next,
      kind,
      memo,
    });
    return this.getUser(userId);
  }

  // ---- 余额充值（DujiaoPay） ----

  rechargeOrderMapper(row, paymentRow) {
    if (!row) return null;
    let paymentInstructions = null;
    try { paymentInstructions = normalizePaymentInstructions(parseJson((paymentRow?.payment_instructions ?? '{}'), null)); } catch { paymentInstructions = null; }
    return {
      rechargeNo: row.recharge_no,
      amountFen: Number(row.amount_fen),
      status: row.status,
      paymentDeadline: row.payment_deadline,
      paidAt: row.paid_at,
      createdAt: row.created_at,
      payment: paymentRow
        ? {
            provider: paymentRow.provider,
            providerOrderId: paymentRow.provider_order_id,
            merchantOrderId: paymentRow.merchant_order_id,
            status: paymentRow.status,
            fiatAmount: paymentRow.fiat_amount,
            fiatCurrency: paymentRow.fiat_currency,
            payableAmount: paymentRow.payable_amount,
            chain: paymentRow.chain,
            tokenId: paymentRow.token_id,
            checkoutUrl: paymentRow.checkout_url,
            expiresAt: paymentRow.expires_at,
            paymentInstructions,
          }
        : null,
    };
  }

  rechargeByClientKey(userId, requestKey) {
    const row = one(
      this.db,
      `SELECT r.*, p.provider, p.provider_order_id, p.merchant_order_id, p.status AS payment_status,
              p.fiat_amount, p.fiat_currency, p.payable_amount, p.chain, p.token_id,
              p.checkout_url, p.expires_at, p.paid_at, p.transaction_id, p.payment_instructions
       FROM recharge_orders r LEFT JOIN recharge_payments p ON p.recharge_id = r.id
       WHERE r.user_id = ? AND r.client_request_key = ?`,
      userId,
      requestKey,
    );
    return this.rechargeOrderMapper(row, row);
  }

  rechargeByNo(userId, rechargeNo) {
    const row = one(
      this.db,
      `SELECT r.*, p.provider, p.provider_order_id, p.merchant_order_id, p.status AS payment_status,
              p.fiat_amount, p.fiat_currency, p.payable_amount, p.chain, p.token_id,
              p.checkout_url, p.expires_at, p.paid_at, p.transaction_id, p.payment_instructions
       FROM recharge_orders r LEFT JOIN recharge_payments p ON p.recharge_id = r.id
       WHERE r.user_id = ? AND r.recharge_no = ?`,
      userId,
      rechargeNo,
    );
    return this.rechargeOrderMapper(row, row);
  }

  rechargePaymentByMerchantId(merchantOrderId) {
    const row = one(
      this.db,
      `SELECT r.*, p.provider, p.provider_order_id, p.merchant_order_id, p.status AS payment_status,
              p.fiat_amount, p.fiat_currency, p.payable_amount, p.chain, p.token_id,
              p.checkout_url, p.expires_at, p.paid_at, p.transaction_id, p.payment_instructions
       FROM recharge_payments p JOIN recharge_orders r ON r.id = p.recharge_id
       WHERE p.merchant_order_id = ?`,
      merchantOrderId,
    );
    return this.rechargeOrderMapper(row, row);
  }

  async createRecharge(user, input) {
    const amountFen = assertInteger(input.amountFen, '充值金额', 1, 100000000);
    const requestKey = assertText(input.idempotencyKey, '请求标识', 8, 128);
    const existing = this.rechargeByClientKey(user.id, requestKey);
    if (existing) return this.ensureRechargeSession(existing, user.id);
    const enabled = this.paymentProvider.isEnabled !== false;
    const configured = typeof this.paymentProvider.isConfigured === 'function' ? this.paymentProvider.isConfigured() : true;
    if (!enabled || !configured) {
      throw new DomainError('支付渠道未配置，暂无法充值。', 'payment_not_configured', 503);
    }
    let local;
    try {
      local = transaction(this.db, () => {
        const concurrent = this.rechargeByClientKey(user.id, requestKey);
        if (concurrent) return this.ensureRechargeSession(concurrent, user.id);
        const now = nowIso();
        const id = randomId('rcg_');
        const rechargeNo = rechargeNumber();
        run(
          this.db,
          `INSERT INTO recharge_orders (id, recharge_no, user_id, amount_fen, status, client_request_key, payment_deadline, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending_payment', ?, ?, ?, ?)`,
          id,
          rechargeNo,
          user.id,
          amountFen,
          requestKey,
          addMinutes(this.config.paymentTtlMinutes),
          now,
          now,
        );
        run(
          this.db,
          `INSERT INTO recharge_payments (id, recharge_id, provider, merchant_order_id, idempotency_key, status, fiat_amount, fiat_currency, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'awaiting_payment', ?, 'CNY', ?, ?)`,
          randomId('rcpay_'),
          id,
          this.paymentProvider.name,
          rechargeNo,
          rechargeNo,
          (amountFen / 100).toFixed(2),
          now,
          now,
        );
        const row = this.rechargeByNo(user.id, rechargeNo);
        return { row, no: rechargeNo };
      });
    } catch (error) {
      if (isSqliteUniqueError(error)) {
        const duplicate = this.rechargeByClientKey(user.id, requestKey);
        if (duplicate) return this.ensureRechargeSession(duplicate, user.id);
      }
      throw error;
    }
    return this.ensureRechargeSession(local.row, user.id);
  }

  async ensureRechargeSession(recharge, userId) {
    if (!recharge || !['pending_payment', 'payment_confirming'].includes(recharge.status)) return recharge;
    const payment = recharge.payment;
    if (payment?.paymentInstructions || payment?.checkoutUrl || payment?.status === 'paid') return recharge;
    let session;
    try {
      session = await this.paymentProvider.createPayment({
        merchantOrderId: recharge.rechargeNo,
        amountFen: Number(recharge.amountFen),
        metadata: { recharge_no: recharge.rechargeNo, user_id: userId, kind: 'recharge' },
        successUrl: new URL(`/wallet`, this.config.appOrigin).toString(),
        cancelUrl: new URL(`/wallet`, this.config.appOrigin).toString(),
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('支付渠道暂时不可用，请稍后重试。', 'payment_session_pending', 503);
    }
    if (!session || session.provider !== this.paymentProvider.name || typeof session.providerOrderId !== 'string') {
      throw new DomainError('支付渠道返回了无效订单。', 'invalid_payment_session', 502);
    }
    let paymentInstructions = null;
    if (session.paymentInstructions) {
      try { paymentInstructions = normalizePaymentInstructions(session.paymentInstructions); } catch { throw new DomainError('支付渠道返回了无效的内嵌付款信息。', 'invalid_payment_session', 502); }
    }
    run(
      this.db,
      `UPDATE recharge_payments SET
         provider_order_id = COALESCE(provider_order_id, ?),
         checkout_url = COALESCE(?, checkout_url),
         expires_at = COALESCE(?, expires_at),
         payment_instructions = ?,
         provider_payload = ?, updated_at = ?
       WHERE recharge_id = ?`,
      session.providerOrderId,
      session.checkoutUrl ?? null,
      session.expiresAt ?? null,
      JSON.stringify(paymentInstructions ?? {}),
      JSON.stringify(session.raw ?? {}),
      nowIso(),
      one(this.db, 'SELECT id FROM recharge_orders WHERE recharge_no = ?', recharge.rechargeNo)?.id,
    );
    return this.rechargeByNo(userId, recharge.rechargeNo);
  }

  applyRechargeProviderStatus(rechargeEntry, incoming) {
    const status = incoming.providerStatus;
    const rechargeNo = incoming.merchantOrderId;
    const payment = one(this.db, 'SELECT * FROM recharge_payments WHERE merchant_order_id = ?', rechargeNo);
    if (!payment) throw new DomainError('充值回调对应的订单不存在。', 'unknown_payment_order', 404);
    if (incoming.providerOrderId && payment.provider_order_id && payment.provider_order_id !== incoming.providerOrderId) {
      throw new DomainError('支付渠道订单号不匹配。', 'payment_order_mismatch', 409);
    }
    if (incoming.providerOrderId && !payment.provider_order_id) {
      run(this.db, 'UPDATE recharge_payments SET provider_order_id = ?, updated_at = ? WHERE id = ?', incoming.providerOrderId, nowIso(), payment.id);
    }
    const current = one(this.db, 'SELECT * FROM recharge_orders WHERE id = ?', payment.recharge_id);
    if (!current) throw new DomainError('充值订单不存在。', 'unknown_payment_order', 404);
    // 已到账则忽略重复事件（Webhook 已按 event id 去重）
    if (current.status === 'paid') return this.rechargeByNo(current.user_id, current.recharge_no);

    const now = nowIso();
    if (status === 'paid') {
      // 锁定充值，防止并发重复入账
      const locked = run(
        this.db,
        `UPDATE recharge_orders SET status = ?, paid_at = ?, updated_at = ? WHERE id = ? AND status != 'paid'`,
        'paid',
        incoming.paidAt ?? now,
        now,
        payment.recharge_id,
      ).changes;
      if (locked === 1) {
        run(
          this.db,
          `UPDATE recharge_payments SET status = 'paid', payable_amount = COALESCE(?, payable_amount),
             chain = COALESCE(?, chain), token_id = COALESCE(?, token_id),
             paid_at = COALESCE(?, paid_at), transaction_id = COALESCE(?, transaction_id),
             provider_payload = ?, updated_at = ? WHERE id = ?`,
          incoming.payableAmount,
          incoming.chain,
          incoming.tokenId,
          incoming.paidAt,
          incoming.transactionId,
          JSON.stringify(incoming.payload ?? {}),
          now,
          payment.id,
        );
        const amount = Number(current.amount_fen);
        const userRow = one(this.db, 'SELECT balance_fen FROM users WHERE id = ?', current.user_id);
        const nextBalance = Number(userRow?.balance_fen ?? 0) + amount;
        run(this.db, 'UPDATE users SET balance_fen = ?, updated_at = ? WHERE id = ?', nextBalance, now, current.user_id);
        run(
          this.db,
          `INSERT INTO balance_entries (id, user_id, change_fen, balance_after_fen, kind, memo, source, created_at)
           VALUES (?, ?, ?, ?, 'recharge', ?, 'recharge', ?)`,
          randomId('bal_'),
          current.user_id,
          amount,
          nextBalance,
          `支付渠道充值 ${rechargeNo}`,
          now,
        );
        this.audit(null, 'balance.recharge', 'user', current.user_id, { rechargeNo, changeFen: amount });
      }
      return this.rechargeByNo(current.user_id, current.recharge_no);
    }

    if (status === 'confirming') {
      run(
        this.db,
        `UPDATE recharge_payments SET status = 'confirming', provider_payload = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify(incoming.payload ?? {}),
        now,
        payment.id,
      );
      run(this.db, "UPDATE recharge_orders SET status = 'payment_confirming', updated_at = ? WHERE id = ?", now, payment.recharge_id);
      return this.rechargeByNo(current.user_id, current.recharge_no);
    }

    if (['expired', 'canceled'].includes(status)) {
      run(
        this.db,
        `UPDATE recharge_payments SET status = ?, provider_payload = ?, updated_at = ? WHERE id = ? AND status != 'paid'`,
        status,
        JSON.stringify(incoming.payload ?? {}),
        now,
        payment.id,
      );
      run(this.db, "UPDATE recharge_orders SET status = ?, updated_at = ? WHERE id = ? AND status != 'paid'", status === 'expired' ? 'payment_expired' : 'canceled', now, payment.recharge_id);
      return this.rechargeByNo(current.user_id, current.recharge_no);
    }

    return this.rechargeByNo(current.user_id, current.recharge_no);
  }

  listUserRecharges(userId, limit = 20) {
    return many(
      this.db,
      `SELECT recharge_no, amount_fen, status, paid_at, created_at FROM recharge_orders
       WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
      userId,
      Number(limit),
    );
  }


  listBalanceEntries(userId, limit = 50) {
    return many(
      this.db,
      `SELECT * FROM balance_entries WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      userId,
      Number(limit),
    ).map((row) => ({
      id: row.id,
      changeFen: Number(row.change_fen),
      balanceAfterFen: Number(row.balance_after_fen),
      kind: row.kind,
      memo: row.memo,
      source: row.source,
      createdAt: row.created_at,
    }));
  }

  updateUserStatus(actor, userId, isActive) {
    if (typeof isActive !== 'boolean') throw new DomainError('用户状态无效。', 'invalid_request', 422);
    const user = one(this.db, `SELECT * FROM users WHERE id = ? AND role != 'admin' AND telegram_id NOT LIKE 'admin:%'`, userId);
    if (!user) throw new DomainError('用户不存在。', 'user_not_found', 404);
    run(this.db, 'UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?', isActive ? 1 : 0, nowIso(), userId);
    this.audit(actor.id, isActive ? 'user.enabled' : 'user.disabled', 'user', userId, { telegramId: user.telegram_id });
    return this.getUser(userId);
  }

  listAdminProducts() {
    const products = many(
      this.db,
      `SELECT p.*, c.name AS category_name
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       ORDER BY p.created_at DESC`,
    );
    return products.map((product) => ({
      id: product.id,
      title: product.title,
      slug: product.slug,
      description: product.description,
      instructions: product.instructions,
      imageUrl: product.image_url,
      status: product.status,
      categoryId: product.category_id,
      categoryName: product.category_name,
      variants: many(
        this.db,
        `SELECT v.*, 
          (SELECT COUNT(*) FROM card_credentials cc WHERE cc.variant_id = v.id AND cc.state = 'available' AND (cc.expires_at IS NULL OR cc.expires_at > ?)) AS stock,
          (SELECT COUNT(*) FROM card_issuances ci JOIN card_credentials ic ON ic.id = ci.card_id WHERE ic.variant_id = v.id) AS sold
         FROM product_variants v WHERE v.product_id = ? ORDER BY v.position, v.name`,
        nowIso(),
        product.id,
      ).map((variant) => ({
        id: variant.id,
        name: variant.name,
        sku: variant.sku,
        priceFen: Number(variant.price_fen),
        maxPerOrder: Number(variant.max_per_order),
        isActive: asBoolean(variant.is_active),
        stock: Number(variant.stock),
        sold: Number(variant.sold),
      })),
    }));
  }

  listCategories() {
    return many(
      this.db,
      `SELECT c.id, c.name, c.slug, c.position, c.is_active,
              COUNT(p.id) AS product_count
       FROM categories c LEFT JOIN products p ON p.category_id = c.id
       GROUP BY c.id ORDER BY c.position, c.name`,
    ).map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      position: Number(category.position),
      isActive: asBoolean(category.is_active),
      productCount: Number(category.product_count),
    }));
  }

  listAdminOrders(filter = {}) {
    const conditions = [];
    const params = [];
    const statuses = Array.isArray(filter.statuses)
      ? filter.statuses.filter((status) => typeof status === 'string' && status)
      : filter.status
        ? [filter.status]
        : [];
    if (statuses.length === 1) {
      conditions.push('o.status = ?');
      params.push(statuses[0]);
    } else if (statuses.length > 1) {
      conditions.push(`o.status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (filter.paymentStatus) {
      conditions.push('pt.status = ?');
      params.push(filter.paymentStatus);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    return many(this.db, `${orderWithPayment}${where} ORDER BY o.created_at DESC LIMIT 200`, ...params).map(toOrderSummary);
  }

  updateCategory(actor, categoryId, input) {
    const category = one(this.db, 'SELECT * FROM categories WHERE id = ?', categoryId);
    if (!category) throw new DomainError('分类不存在。', 'category_not_found', 404);
    const nextName = input.name !== undefined ? assertText(input.name, '分类名称', 1, 80) : category.name;
    const nextSlug = input.slug !== undefined && String(input.slug).trim()
      ? assertSlug(String(input.slug).trim())
      : category.slug;
    const nextPosition = input.position !== undefined ? assertInteger(input.position, '排序', 0, 10000) : Number(category.position);
    const nextActive = input.isActive !== undefined ? Boolean(input.isActive) : asBoolean(category.is_active);
    const now = nowIso();
    run(
      this.db,
      'UPDATE categories SET name = ?, slug = ?, position = ?, is_active = ?, updated_at = ? WHERE id = ?',
      nextName,
      nextSlug,
      nextPosition,
      nextActive ? 1 : 0,
      now,
      categoryId,
    );
    this.audit(actor.id, 'category.updated', 'category', categoryId, { slug: nextSlug, isActive: nextActive });
    return this.listCategories().find((item) => item.id === categoryId) ?? { id: categoryId };
  }

  retryFulfillment(actor, orderNo) {
    return transaction(this.db, () => {
      const order = one(this.db, `${orderWithPayment} WHERE o.order_no = ?`, orderNo);
      if (!order) throw new DomainError('订单不存在。', 'order_not_found', 404);
      if (order.status === 'completed') {
        throw new DomainError('订单已经完成，无需重新发卡。', 'fulfillment_not_retryable', 409);
      }
      if (order.payment_status !== 'paid') {
        throw new DomainError('订单支付状态不允许重新发卡。', 'fulfillment_not_retryable', 409);
      }
      if (!['paid', 'fulfilling', 'fulfillment_failed'].includes(order.status)) {
        throw new DomainError('当前订单尚未具备重新发卡条件。', 'fulfillment_not_retryable', 409);
      }
      const now = nowIso();
      run(
        this.db,
        `UPDATE orders
         SET status = 'paid', fulfillment_status = 'pending', failure_reason = NULL, updated_at = ?
         WHERE id = ?`,
        now,
        order.id,
      );
      run(
        this.db,
        `INSERT INTO fulfillment_jobs (id, order_id, status, attempts, run_after, created_at, updated_at)
         VALUES (?, ?, 'pending', 0, ?, ?, ?)
         ON CONFLICT(order_id) DO UPDATE SET
           status = 'pending', attempts = 0, run_after = excluded.run_after,
           locked_at = NULL, last_error = NULL, updated_at = excluded.updated_at`,
        randomId('job_'),
        order.id,
        now,
        now,
        now,
      );
      this.audit(actor.id, 'fulfillment.retried', 'order', order.id, { orderNo });
      return { orderNo, queued: true };
    });
  }

  audit(actorUserId, action, entityType, entityId, detail) {
    run(
      this.db,
      `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      randomId('audit_'),
      actorUserId,
      action,
      entityType,
      entityId,
      JSON.stringify(detail ?? {}),
      nowIso(),
    );
  }

  releaseCards(orderId) {
    const now = nowIso();
    run(
      this.db,
      `UPDATE card_credentials
       SET state = CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 'disabled' ELSE 'available' END,
           reserved_for_order_id = NULL, reserved_at = NULL
       WHERE reserved_for_order_id = ? AND state = 'reserved'`,
      now,
      orderId,
    );
  }

  completeJob(jobId) {
    run(
      this.db,
      `UPDATE fulfillment_jobs SET status = 'completed', completed_at = ?, locked_at = NULL, updated_at = ? WHERE id = ?`,
      nowIso(),
      nowIso(),
      jobId,
    );
  }

  findOrderByRequest(userId, requestKey) {
    return one(this.db, `${orderWithPayment} WHERE o.user_id = ? AND o.client_request_key = ?`, userId, requestKey);
  }

  findOrderByNo(orderNo, userId) {
    return one(this.db, `${orderWithPayment} WHERE o.order_no = ? AND o.user_id = ?`, orderNo, userId);
  }

  findOrderByMerchantId(merchantOrderId) {
    return one(this.db, `${orderWithPayment} WHERE pt.merchant_order_id = ?`, merchantOrderId);
  }

  findOrderByProviderId(providerOrderId) {
    return one(this.db, `${orderWithPayment} WHERE pt.provider_order_id = ?`, providerOrderId);
  }
}
