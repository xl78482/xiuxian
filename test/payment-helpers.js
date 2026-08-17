import crypto from 'node:crypto';
import assert from 'node:assert/strict';

export function makeTestPaymentProvider() {
  const orders = new Map();
  return {
    name: 'test',
    async createPayment(input) {
      const providerOrderId = `test_${crypto.randomUUID()}`;
      const payment = {
        provider: 'test',
        providerOrderId,
        merchantOrderId: input.merchantOrderId,
        status: 'pending',
        chain: 'tron',
        tokenId: 'tron-usdt',
        payableAmount: (input.amountFen / 100).toFixed(2),
        fiatCurrency: 'CNY',
        fiatAmount: (input.amountFen / 100).toFixed(2),
        payAddress: 'TEST_PAYMENT_ADDRESS',
        checkoutUrl: null,
        paymentInstructions: {
          mode: 'qr',
          method: 'crypto',
          label: 'USDT',
          amountUnit: 'USDT',
          network: 'TRON（测试）',
          qrContent: `test-payment:${input.merchantOrderId}`,
          address: 'TEST_PAYMENT_ADDRESS',
        },
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        raw: { test_only: true, provider_order_id: providerOrderId },
      };
      orders.set(providerOrderId, payment);
      return payment;
    },
    async getOrder(providerOrderId) {
      return orders.get(providerOrderId) ?? {
        provider: 'test',
        providerOrderId,
        merchantOrderId: null,
        status: 'pending',
        raw: { test_only: true },
      };
    },
  };
}

export function markTestPaymentPaid(db, commerce, orderNo, userId) {
  const payment = db.prepare(`
    SELECT pt.*, o.user_id
    FROM payment_transactions pt
    JOIN orders o ON o.id = pt.order_id
    WHERE o.order_no = ?
  `).get(orderNo);
  assert.ok(payment, 'test payment must exist');
  assert.equal(payment.user_id, userId, 'test payment must belong to user');
  return commerce.applyProviderOrder({
    providerOrderId: payment.provider_order_id,
    merchantOrderId: payment.merchant_order_id,
    status: 'paid',
    chain: payment.chain,
    tokenId: payment.token_id,
    payableAmount: payment.payable_amount,
    fiatCurrency: payment.fiat_currency,
    fiatAmount: payment.fiat_amount,
    paidAt: new Date().toISOString(),
    transactionId: `test_tx_${crypto.randomUUID()}`,
    raw: { test_only: true },
  });
}
