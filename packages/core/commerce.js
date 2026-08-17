import crypto from 'node:crypto';
import { many, nowIso, one, parseJson, run, transaction } from './database.js';
import { randomId } from './crypto.js';
import { canonicalDecimal, isSameDecimal } from '../payment/index.js';

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
    pt.transaction_id, pt.provider_payload
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
        isAdmin: row.role === 'admin',
      }
    : null;
}

function toPaymentSummary(row) {
  return {
    provider: row.provider,
    status: row.payment_status,
    checkoutUrl: row.checkout_url,
    chain: row.chain,
    tokenId: row.token_id,
    payableAmount: row.payable_amount,
    payAddress: row.pay_address,
    expiresAt: row.provider_expires_at ?? row.payment_deadline,
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
    const now = nowIso();
    const role = this.config.adminTelegramIds.has(telegramId) ? 'admin' : 'customer';
    const current = one(this.db, 'SELECT * FROM users WHERE telegram_id = ?', telegramId);
    if (current) {
      run(
        this.db,
        `UPDATE users
         SET username = ?, first_name = ?, last_name = ?, language_code = ?, role = ?, updated_at = ?
         WHERE id = ?`,
        telegramUser.username ?? null,
        telegramUser.first_name,
        telegramUser.last_name ?? null,
        telegramUser.language_code ?? null,
        role,
        now,
        current.id,
      );
      return this.getUser(current.id);
    }
    const id = randomId('usr_');
    run(
      this.db,
      `INSERT INTO users (id, telegram_id, username, first_name, last_name, language_code, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      telegramId,
      telegramUser.username ?? null,
      telegramUser.first_name,
      telegramUser.last_name ?? null,
      telegramUser.language_code ?? null,
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
    if (existing) return this.ensurePaymentSession(existing, user.id);

    let localOrder;
    try {
      localOrder = transaction(this.db, () => {
        const concurrent = this.findOrderByRequest(user.id, requestKey);
        if (concurrent) return concurrent;
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
        if (duplicate) return this.ensurePaymentSession(duplicate, user.id);
      }
      throw error;
    }
    return this.ensurePaymentSession(localOrder, user.id);
  }

  async ensurePaymentSession(order, userId) {
    if (!order) throw new Error('Order was not created.');
    if (order.checkout_url || order.payment_status === 'paid' || order.status !== 'pending_payment') {
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
      // Do not release cards: an upstream timeout can mean the idempotent order exists remotely.
      throw new DomainError(
        '支付渠道暂时不可用，订单与库存已保留，请从订单列表再次打开支付。',
        'payment_session_pending',
        503,
      );
    }

    transaction(this.db, () => {
      const current = this.findOrderByNo(order.order_no, userId);
      if (!current || current.checkout_url || current.payment_status === 'paid') return;
      const now = nowIso();
      const expiry = session.expiresAt ?? current.payment_deadline;
      run(
        this.db,
        `UPDATE payment_transactions
         SET provider_order_id = COALESCE(provider_order_id, ?),
             status = CASE WHEN status = 'paid' THEN 'paid' ELSE ? END,
             payable_amount = COALESCE(?, payable_amount),
             chain = COALESCE(?, chain), token_id = COALESCE(?, token_id),
             pay_address = COALESCE(?, pay_address), checkout_url = COALESCE(checkout_url, ?),
             provider_expires_at = COALESCE(?, provider_expires_at), provider_payload = ?, updated_at = ?
         WHERE order_id = ?`,
        session.providerOrderId,
        session.status,
        session.payableAmount,
        session.chain,
        session.tokenId,
        session.payAddress,
        session.checkoutUrl,
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
      const inserted = run(
        this.db,
        `INSERT OR IGNORE INTO payment_webhook_events
         (id, provider, provider_event_id, event_type, payload, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        randomId('evt_'),
        this.paymentProvider.name,
        event.event_id,
        event.event_type,
        JSON.stringify(event),
        nowIso(),
      );
      if (!inserted.changes) return { duplicate: true };
      this.applyWebhookEvent(event);
      run(
        this.db,
        'UPDATE payment_webhook_events SET processed_at = ? WHERE provider = ? AND provider_event_id = ?',
        nowIso(),
        this.paymentProvider.name,
        event.event_id,
      );
      return { duplicate: false };
    });
  }

  applyWebhookEvent(event) {
    // These platform events are operational records, not a merchant order lifecycle.
    if (['webhook.test', 'unmatched_claim.claimed', 'refund.recorded'].includes(event.event_type)) return;
    const data = event.data ?? {};
    const merchantOrderId = data.merchant_order_id;
    const providerOrderId = data.order_id;
    if (typeof merchantOrderId !== 'string' || typeof providerOrderId !== 'string') {
      throw new DomainError('支付回调缺少订单标识。', 'invalid_webhook', 400);
    }
    const payment = this.findOrderByMerchantId(merchantOrderId);
    if (!payment) throw new DomainError('支付回调对应的订单不存在。', 'unknown_payment_order', 404);
    const status =
      event.event_type === 'order.method_selected'
        ? 'pending'
        : typeof data.status === 'string'
          ? data.status
          : event.event_type.replace('order.', '');
    this.applyPaymentState(payment, {
      providerStatus: status,
      providerOrderId,
      merchantOrderId,
      chain: typeof data.chain === 'string' ? data.chain : null,
      tokenId: typeof data.token_id === 'string' ? data.token_id : null,
      payableAmount: typeof data.payable_amount === 'string' ? data.payable_amount : null,
      fiatCurrency: typeof data.fiat_currency === 'string' ? data.fiat_currency : null,
      fiatAmount: typeof data.fiat_amount === 'string' ? data.fiat_amount : null,
      paidAt: event.event_type === 'order.paid' ? event.created_at : null,
      transactionId: typeof data.tx_id === 'string' ? data.tx_id : null,
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
    const now = nowIso();

    if (status === 'paid') {
      this.assertPaidPaymentMatches(payment, incoming);
      if (['payment_expired', 'canceled'].includes(payment.status)) {
        throw new DomainError('已关闭订单收到迟到支付，需要人工处理。', 'late_payment', 409);
      }
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
        `UPDATE orders SET status = CASE WHEN status = 'completed' THEN 'completed' ELSE 'paid' END,
         updated_at = ? WHERE id = ?`,
        now,
        payment.id,
      );
      run(
        this.db,
        `INSERT INTO fulfillment_jobs (id, order_id, status, attempts, run_after, created_at, updated_at)
         VALUES (?, ?, 'pending', 0, ?, ?, ?)
         ON CONFLICT(order_id) DO UPDATE SET
           status = CASE WHEN fulfillment_jobs.status = 'completed' THEN 'completed' ELSE 'pending' END,
           run_after = CASE WHEN fulfillment_jobs.status = 'completed' THEN fulfillment_jobs.run_after ELSE excluded.run_after END,
           locked_at = NULL, updated_at = excluded.updated_at`,
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
    if (incoming.fiatCurrency && incoming.fiatCurrency !== payment.fiat_currency) {
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

  markMockPaymentPaid(orderNo, userId) {
    return transaction(this.db, () => {
      const payment = this.findOrderByNo(orderNo, userId);
      if (!payment) throw new DomainError('订单不存在。', 'order_not_found', 404);
      if (payment.provider !== 'mock') throw new DomainError('当前订单不使用本地测试支付。', 'invalid_provider', 409);
      this.applyPaymentState(payment, {
        providerStatus: 'paid',
        providerOrderId: payment.provider_order_id,
        merchantOrderId: payment.merchant_order_id,
        chain: payment.chain,
        tokenId: payment.token_id,
        payableAmount: payment.payable_amount,
        fiatCurrency: payment.fiat_currency,
        fiatAmount: payment.fiat_amount,
        paidAt: nowIso(),
        transactionId: randomId('mock_tx_'),
        payload: { development_only: true },
      });
      return true;
    });
  }

  claimFulfillmentJob() {
    return transaction(this.db, () => {
      const job = one(
        this.db,
        `SELECT * FROM fulfillment_jobs
         WHERE status IN ('pending', 'failed') AND run_after <= ? AND attempts < 8
         ORDER BY run_after, created_at LIMIT 1`,
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
        const cards = many(
          this.db,
          `SELECT * FROM card_credentials
           WHERE reserved_for_order_id = ? AND state = 'reserved'
           ORDER BY reserved_at, id`,
          order.id,
        );
        if (cards.length !== Number(order.quantity)) {
          throw new Error(`Reserved card count ${cards.length} does not equal order quantity ${order.quantity}.`);
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
           WHERE id = ? AND status != 'completed'`,
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
    const due = many(
      this.db,
      `${orderWithPayment}
       WHERE o.status IN ('pending_payment', 'payment_confirming')
         AND o.payment_deadline <= ?
       ORDER BY o.payment_deadline LIMIT ?`,
      nowIso(),
      limit,
    );
    let processed = 0;
    for (const order of due) {
      if (order.provider === 'mock') {
        transaction(this.db, () => this.applyPaymentState(order, {
          providerStatus: 'expired',
          providerOrderId: order.provider_order_id,
          merchantOrderId: order.merchant_order_id,
          chain: order.chain,
          tokenId: order.token_id,
          payableAmount: order.payable_amount,
          fiatCurrency: order.fiat_currency,
          fiatAmount: order.fiat_amount,
          paidAt: null,
          transactionId: null,
          payload: { development_only: true, reason: 'expired' },
        }));
        processed += 1;
        continue;
      }
      if (!order.provider_order_id) continue;
      try {
        const providerOrder = await this.paymentProvider.getOrder(order.provider_order_id);
        this.applyProviderOrder(providerOrder);
        processed += 1;
      } catch {
        // Do not release stock on an unverified timeout; the provider can still settle the payment.
      }
    }
    return processed;
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
    const category = {
      id,
      name: assertText(input.name, '分类名称', 1, 80),
      slug: assertSlug(input.slug),
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
    run(
      this.db,
      `INSERT INTO products (id, category_id, title, slug, description, instructions, image_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      categoryId,
      assertText(input.title, '商品名称', 1, 160),
      assertSlug(input.slug),
      String(input.description ?? '').trim(),
      String(input.instructions ?? '').trim(),
      input.imageUrl ? String(input.imageUrl).trim() : null,
      status,
      now,
      now,
    );
    this.audit(actor.id, 'product.created', 'product', id, { slug: input.slug });
    return { id };
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
    run(
      this.db,
      `UPDATE products SET category_id = ?, title = ?, slug = ?, description = ?, instructions = ?, image_url = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      categoryId,
      input.title === undefined ? current.title : assertText(input.title, '商品名称', 1, 160),
      input.slug === undefined ? current.slug : assertSlug(input.slug),
      input.description === undefined ? current.description : String(input.description).trim(),
      input.instructions === undefined ? current.instructions : String(input.instructions).trim(),
      input.imageUrl === undefined ? current.image_url : input.imageUrl || null,
      status,
      nowIso(),
      productId,
    );
    this.audit(actor.id, 'product.updated', 'product', productId, { fields: Object.keys(input) });
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
    return many(this.db, 'SELECT id, name, slug, position, is_active AS isActive FROM categories ORDER BY position, name')
      .map((category) => ({ ...category, isActive: asBoolean(category.isActive) }));
  }

  listAdminOrders() {
    return many(this.db, `${orderWithPayment} ORDER BY o.created_at DESC LIMIT 200`).map(toOrderSummary);
  }

  retryFulfillment(actor, orderNo) {
    return transaction(this.db, () => {
      const order = one(this.db, `${orderWithPayment} WHERE o.order_no = ?`, orderNo);
      if (!order) throw new DomainError('订单不存在。', 'order_not_found', 404);
      if (order.status === 'completed') {
        throw new DomainError('订单已经完成，无需重新发卡。', 'fulfillment_not_retryable', 409);
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
    run(
      this.db,
      `UPDATE card_credentials SET state = 'available', reserved_for_order_id = NULL, reserved_at = NULL
       WHERE reserved_for_order_id = ? AND state = 'reserved'`,
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

export function makeMockPaymentProvider(appOrigin) {
  return {
    name: 'mock',
    async createPayment(input) {
      const providerOrderId = randomId('mock_');
      return {
        provider: 'mock',
        providerOrderId,
        status: 'pending',
        chain: 'tron',
        tokenId: 'tron-usdt',
        payableAmount: (input.amountFen / 100).toFixed(2),
        payAddress: 'DEVELOPMENT_ONLY',
        checkoutUrl: new URL(`/pay/mock/${encodeURIComponent(input.merchantOrderId)}`, appOrigin).toString(),
        expiresAt: addMinutes(15),
        raw: { development_only: true, provider_order_id: providerOrderId },
      };
    },
    async getOrder(providerOrderId) {
      return { providerOrderId, merchantOrderId: null, status: 'pending', raw: { development_only: true } };
    },
  };
}
