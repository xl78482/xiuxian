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
