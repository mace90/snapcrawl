import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(secret) {
  let bits = '';
  for (const ch of secret.toUpperCase().replace(/[\s=]/g, '')) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('TOTP secret is not valid base32');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

// RFC 6238 TOTP (HMAC-SHA1), as used by Google Authenticator, 1Password, Authy and most apps.
export function totp(secret, { time = Date.now(), step = 30, digits = 6 } = {}) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / step)));
  const h = createHmac('sha1', base32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = (((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 10 ** digits;
  return String(n).padStart(digits, '0');
}
