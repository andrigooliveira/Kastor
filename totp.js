/* ───────────────────────────────────────────────────────────────
   TOTP (RFC 6238: HMAC-SHA1, 6 dígitos, passo de 30s) e códigos de
   recuperação — usados pelo reWork Console (superadmins) e pela
   verificação em duas etapas das contas do reWork.
   ─────────────────────────────────────────────────────────────── */
const crypto = require('crypto');
const QRCode = require('qrcode');

const RECOVERY_CODES = 10;
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}
/* Devolve o passo aceito (pra impedir reuso do mesmo código) ou null. */
function totpVerify(secretB32, code, lastStep) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return null;
  const secret = b32decode(secretB32);
  const step = Math.floor(Date.now() / 30000);
  for (const w of [0, -1, 1]) {
    const s = step + w;
    if (lastStep && s <= lastStep) continue;
    const expected = hotp(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return s;
  }
  return null;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const normRecovery = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
/* Códigos de recuperação: xxxx-xxxx, sem letras ambíguas (0/o, 1/l/i). */
function newRecoveryCodes() {
  const codes = [];
  while (codes.length < RECOVERY_CODES) {
    const bytes = crypto.randomBytes(8);
    const raw = [...bytes].map(b => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    const code = raw.slice(0, 4) + '-' + raw.slice(4);
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/* Cadastro de um app autenticador: segredo novo + link otpauth + QR (SVG). */
async function totpEnrollment(issuer, account) {
  const secret = b32encode(crypto.randomBytes(20));
  const label = encodeURIComponent(`${issuer}:${account}`);
  const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  const qr = await QRCode.toString(otpauth, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } });
  return { secret, secretGrouped: secret.match(/.{1,4}/g).join(' '), otpauth, qr };
}

module.exports = { b32encode, b32decode, hotp, totpVerify, safeEqual, sha256, normRecovery, newRecoveryCodes, totpEnrollment, RECOVERY_CODES };
