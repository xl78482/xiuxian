import crypto from 'node:crypto';

export class AuthError extends Error {
  constructor(message, code = 'telegram_auth_invalid') {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = 401;
  }
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function fromBase64url(input) {
  return Buffer.from(input, 'base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.isBuffer(left) ? left : Buffer.from(left);
  const rightBuffer = Buffer.isBuffer(right) ? right : Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function createSessionToken(userId, sessionSecret, ttlSeconds = 60 * 60 * 8) {
  const payload = base64url(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySessionToken(token, sessionSecret) {
  if (typeof token !== 'string') return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    const decoded = JSON.parse(fromBase64url(payload).toString('utf8'));
    if (!decoded || typeof decoded.sub !== 'string' || !Number.isInteger(decoded.exp)) return null;
    return decoded.exp > Math.floor(Date.now() / 1000) ? { userId: decoded.sub } : null;
  } catch {
    return null;
  }
}

export function createCardCrypto(hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  const fingerprintKey = crypto
    .createHash('sha256')
    .update('xiuxian-card-fingerprint-v1')
    .update(key)
    .digest();

  return {
    encrypt(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
      return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
    },
    decrypt(encoded) {
      const [version, ivEncoded, tagEncoded, ciphertextEncoded] = String(encoded).split('.');
      if (version !== 'v1' || !ivEncoded || !tagEncoded || !ciphertextEncoded) {
        throw new Error('Card ciphertext format is invalid.');
      }
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, fromBase64url(ivEncoded));
      decipher.setAuthTag(fromBase64url(tagEncoded));
      return Buffer.concat([decipher.update(fromBase64url(ciphertextEncoded)), decipher.final()]).toString('utf8');
    },
    fingerprint(value) {
      return crypto.createHmac('sha256', fingerprintKey).update(String(value).trim()).digest('hex');
    },
  };
}

export function verifyTelegramInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!botToken) throw new AuthError('Telegram 登录尚未配置。', 'telegram_not_configured');
  const params = new URLSearchParams(initData);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) throw new AuthError('Telegram 登录数据包含重复字段。');
  const suppliedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  const userJson = params.get('user');
  if (!suppliedHash || !userJson || !Number.isSafeInteger(authDate) || !/^[a-fA-F0-9]{64}$/.test(suppliedHash)) {
    throw new AuthError('Telegram 登录数据不完整。');
  }
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60 || now - authDate > maxAgeSeconds) {
    throw new AuthError('Telegram 登录数据已过期。');
  }
  const fields = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => left.localeCompare(right));
  if (new Set(fields.map(([key]) => key)).size !== fields.length) {
    throw new AuthError('Telegram 登录数据包含重复字段。');
  }
  const checkString = fields.map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  if (!safeEqual(suppliedHash, expectedHash)) throw new AuthError('Telegram 登录签名无效。');
  let user;
  try {
    user = JSON.parse(userJson);
  } catch {
    throw new AuthError('Telegram 用户数据无效。');
  }
  if (!user || !Number.isSafeInteger(user.id) || !user.first_name) {
    throw new AuthError('Telegram 用户数据不完整。');
  }
  return user;
}

export function hmacHex(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

export function randomId(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`;
}

export { safeEqual };
