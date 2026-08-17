import crypto from 'node:crypto';
import { PaymentProviderError } from './index.js';

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function encode(value) {
  return encodeURIComponent(value).replace(/\+/g, '%20');
}

export function canonicalQuery(raw = '') {
  if (!raw) return '';
  const grouped = new Map();
  for (const [key, value] of new URLSearchParams(raw)) {
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }
  return [...grouped.keys()]
    .sort()
    .flatMap((key) => grouped.get(key).sort().map((value) => `${encode(key)}=${encode(value)}`))
    .join('&');
}

export function signRequest({ secret, method, path, rawQuery = '', body = '', timestamp, nonce }) {
  const canonical = [
    method.toUpperCase(),
    path,
    canonicalQuery(rawQuery),
    sha256Hex(body),
    String(timestamp),
    nonce,
  ].join('\n');
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

function header(headers, name) {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return Array.isArray(found) ? found[0] : found;
}

function required(value, name) {
  if (typeof value !== 'string' || !value) throw new PaymentProviderError(`DujiaoPay response missing ${name}.`);
  return value;
}

export class DujiaoPayProvider {
  constructor(config) {
    this.name = 'dujiaopay';
    this.config = config;
    this.baseUrl = new URL(config.baseUrl);
  }

  async createPayment(input) {
    const data = await this.request('POST', '/v1/orders', {
      chain: this.config.chain,
      token_id: this.config.tokenId,
      fiat_currency: 'CNY',
      fiat_amount: (input.amountFen / 100).toFixed(2),
      merchant_order_id: input.merchantOrderId,
      metadata: input.metadata,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    }, input.merchantOrderId);
    return {
      provider: this.name,
      providerOrderId: required(data.order_id, 'order_id'),
      status: data.status === 'awaiting_payment' ? 'awaiting_payment' : 'pending',
      chain: typeof data.chain === 'string' ? data.chain : null,
      tokenId: typeof data.token_id === 'string' ? data.token_id : null,
      payableAmount: typeof data.payable_amount === 'string' ? data.payable_amount : null,
      payAddress: typeof data.pay_address === 'string' ? data.pay_address : null,
      checkoutUrl: required(data.checkout_url, 'checkout_url'),
      expiresAt: typeof data.expires_at === 'string' ? data.expires_at : null,
      raw: data,
    };
  }

  async getOrder(providerOrderId) {
    const data = await this.request('GET', `/v1/orders/${encodeURIComponent(providerOrderId)}`);
    return this.mapOrder(data);
  }

  async cancelPayment(providerOrderId) {
    await this.request('POST', `/v1/orders/${encodeURIComponent(providerOrderId)}/cancel`);
  }

  verifyWebhook(rawBody, headers) {
    const timestamp = header(headers, 'djp-webhook-timestamp');
    const signature = header(headers, 'djp-webhook-signature');
    const eventHeaderId = header(headers, 'djp-webhook-id');
    if (!timestamp || !signature || !eventHeaderId || !/^[a-fA-F0-9]{64}$/.test(signature)) {
      throw new PaymentProviderError('Missing or malformed DujiaoPay webhook headers.', 'invalid_webhook', 400);
    }
    const timestampSeconds = Number(timestamp);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(timestampSeconds) || Math.abs(now - timestampSeconds) > 300) {
      throw new PaymentProviderError('DujiaoPay webhook timestamp is invalid.', 'invalid_webhook', 400);
    }
    const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);
    const expected = crypto
      .createHmac('sha256', this.config.webhookSecret)
      .update(signedPayload)
      .digest('hex');
    const received = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (received.length !== expectedBuffer.length || !crypto.timingSafeEqual(received, expectedBuffer)) {
      throw new PaymentProviderError('DujiaoPay webhook signature verification failed.', 'invalid_webhook', 401);
    }
    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new PaymentProviderError('DujiaoPay webhook is not valid JSON.', 'invalid_webhook', 400);
    }
    const eventTypes = new Set(['order.created', 'order.method_selected', 'order.confirming', 'order.paid', 'order.expired', 'order.canceled', 'webhook.test', 'unmatched_claim.claimed', 'refund.recorded']);
    if (!event || event.event_id !== eventHeaderId || !eventTypes.has(event.event_type) || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
      throw new PaymentProviderError('DujiaoPay webhook payload is invalid.', 'invalid_webhook', 400);
    }
    return event;
  }

  async request(method, path, body, idempotencyKey) {
    const bodyText = body ? JSON.stringify(body) : '';
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const signature = signRequest({
      secret: this.config.secret,
      method,
      path,
      body: bodyText,
      timestamp,
      nonce,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: {
          'Content-Type': 'application/json',
          'DJP-Key-ID': this.config.keyId,
          'DJP-Timestamp': String(timestamp),
          'DJP-Nonce': nonce,
          'DJP-Signature': signature,
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: bodyText || undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw new PaymentProviderError('DujiaoPay returned invalid JSON.');
      }
      if (!response.ok) {
        throw new PaymentProviderError(
          payload?.error?.message ?? 'DujiaoPay request failed.',
          payload?.error?.code ?? 'dujiaopay_request_failed',
          response.status,
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof PaymentProviderError) throw error;
      throw new PaymentProviderError('DujiaoPay request could not be completed.', 'dujiaopay_network_error', 503);
    } finally {
      clearTimeout(timer);
    }
  }

  mapOrder(data) {
    return {
      providerOrderId: required(data.order_id, 'order_id'),
      merchantOrderId: typeof data.merchant_order_id === 'string' ? data.merchant_order_id : null,
      status: required(data.status, 'status'),
      chain: typeof data.chain === 'string' ? data.chain : null,
      tokenId: typeof data.token_id === 'string' ? data.token_id : null,
      payableAmount: typeof data.payable_amount === 'string' ? data.payable_amount : null,
      fiatCurrency: typeof data.fiat_currency === 'string' ? data.fiat_currency : null,
      fiatAmount: typeof data.fiat_amount === 'string' ? data.fiat_amount : null,
      paidAt: typeof data.paid_at === 'string' ? data.paid_at : null,
      transactionId: typeof data.tx_hash === 'string' ? data.tx_hash : data.tx_id ?? null,
      raw: data,
    };
  }
}
