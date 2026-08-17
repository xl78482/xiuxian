export class PaymentProviderError extends Error {
  constructor(message, code = 'payment_provider_error', status = 502) {
    super(message);
    this.name = 'PaymentProviderError';
    this.code = code;
    this.status = status;
  }
}

export function canonicalDecimal(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '') || '0';
  const normalizedFraction = fraction.replace(/0+$/, '');
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
}

export function isSameDecimal(left, right) {
  const normalizedLeft = canonicalDecimal(left);
  const normalizedRight = canonicalDecimal(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function paymentText(value, maximum) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

export function normalizePaymentInstructions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.mode !== 'qr') {
    throw new PaymentProviderError('Payment provider returned an unsupported embedded payment mode.', 'invalid_payment_instructions');
  }
  const methods = new Set(['crypto', 'wechat', 'alipay', 'other']);
  const method = methods.has(input.method) ? input.method : 'other';
  const label = paymentText(input.label, 64);
  const amountUnit = input.amountUnit == null ? label : paymentText(input.amountUnit, 16);
  const network = input.network == null ? null : paymentText(input.network, 64);
  const qrContent = paymentText(input.qrContent, 2048);
  const address = input.address == null ? null : paymentText(input.address, 512);
  if (!label || !amountUnit || !qrContent || (input.network != null && !network) || (input.address != null && !address)) {
    throw new PaymentProviderError('Payment provider returned invalid embedded payment instructions.', 'invalid_payment_instructions');
  }
  return { mode: 'qr', method, label, amountUnit, network, qrContent, address };
}
