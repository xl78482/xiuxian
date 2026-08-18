const DEFAULT_BASE_URL = 'https://www.dujiaopay.com';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeDujiaoPayConfig(input = {}, fallback = {}) {
  const source = { ...fallback };
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value !== undefined) source[key] = value;
  }
  const hasCredentials = Boolean(text(source.keyId) && text(source.secret) && text(source.webhookSecret));
  const enabled = source.enabled === undefined ? hasCredentials : source.enabled === true || source.enabled === 'true';
  return {
    enabled,
    baseUrl: text(source.baseUrl) || DEFAULT_BASE_URL,
    keyId: text(source.keyId),
    secret: text(source.secret),
    webhookSecret: text(source.webhookSecret),
    chain: text(source.chain).toLowerCase() || 'tron',
    tokenId: text(source.tokenId).toLowerCase() || 'tron-usdt',
    ttlMinutes: Number(source.ttlMinutes ?? source.paymentTtlMinutes ?? 15),
  };
}

export function validateDujiaoPayConfig(input = {}, options = {}) {
  const config = normalizeDujiaoPayConfig(input);
  let parsed;
  try {
    parsed = new URL(config.baseUrl);
  } catch {
    throw new Error('DujiaoPay API 地址必须是有效的 URL。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('DujiaoPay API 地址必须使用 HTTP 或 HTTPS。');
  }
  if (options.production && parsed.origin !== DEFAULT_BASE_URL) {
    throw new Error('生产环境 DujiaoPay API 地址必须是 https://www.dujiaopay.com。');
  }
  if (!/^[a-z0-9-]{2,32}$/.test(config.chain)) throw new Error('支付网络格式无效。');
  if (!/^[a-z0-9-]{2,64}$/.test(config.tokenId)) throw new Error('支付币种格式无效。');
  if (!Number.isInteger(config.ttlMinutes) || config.ttlMinutes < 5 || config.ttlMinutes > 60) {
    throw new Error('订单有效期必须是 5 到 60 分钟。');
  }
  if (options.requireComplete && config.enabled) {
    for (const [name, value] of [['Key ID', config.keyId], ['API Secret', config.secret], ['Webhook Secret', config.webhookSecret]]) {
      if (!value) throw new Error(`DujiaoPay ${name} 尚未配置。`);
    }
  }
  return config;
}

export function isDujiaoPayReady(input = {}) {
  try {
    const config = validateDujiaoPayConfig(input, { requireComplete: true });
    return config.enabled;
  } catch {
    return false;
  }
}

export function maskSecret(value) {
  const textValue = text(value);
  if (!textValue) return null;
  if (textValue.length <= 6) return '******';
  return `${textValue.slice(0, 3)}***${textValue.slice(-3)}`;
}

export { DEFAULT_BASE_URL };
