/**
 * Password hashing and session tokens.
 *
 * - Passwords: scrypt (N=16384) with a per-user salt, stored as
 *   "scrypt$N$r$p$salt$hash".
 * - Sessions: a self-contained HMAC signed token,
 *   base64url(payload).base64url(sig). The payload carries uid, jti and an
 *   expiry, so it validates without a database round trip.
 */
import crypto from 'node:crypto';
import { AUTH } from './config.js';

/** Hash a plain password into a string ready for the database. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(AUTH.saltBytes);
  const derived = crypto.scryptSync(password, salt, AUTH.keyLen, {
    N: AUTH.scryptN,
    r: AUTH.scryptR,
    p: AUTH.scryptP,
    maxmem: 128 * 1024 * 1024,
  });
  return [
    'scrypt',
    AUTH.scryptN,
    AUTH.scryptR,
    AUTH.scryptP,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/** Verify a password. timingSafeEqual avoids a timing side channel. */
export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let expected;
  try {
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }

  let derived;
  try {
    derived = crypto.scryptSync(
      password,
      Buffer.from(saltB64, 'base64'),
      expected.length,
      { N, r, p, maxmem: 128 * 1024 * 1024 },
    );
  } catch {
    return false;
  }

  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

/** Issue a session token. */
export function issueSessionToken(uid, { ttlMs = AUTH.sessionTtlMs, secret = AUTH.secret } = {}) {
  if (!secret) throw new Error('SESSION_SECRET is not configured');
  const now = Date.now();
  const payload = {
    uid,
    jti: crypto.randomBytes(12).toString('hex'),
    iat: now,
    exp: now + ttlMs,
  };
  const body = base64url(JSON.stringify(payload));
  return `${body}.${base64url(sign(body, secret))}`;
}

/**
 * Validate a session token.
 * @returns {{ok: true, payload: object} | {ok: false, reason: string}}
 */
export function verifySessionToken(token, { secret = AUTH.secret, now = Date.now() } = {}) {
  if (!secret) return { ok: false, reason: 'secret_missing' };
  if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [body, sigB64] = parts;

  let provided;
  try {
    provided = Buffer.from(sigB64, 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const expected = sign(body, secret);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload?.uid !== 'string' || typeof payload?.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (now >= payload.exp) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

/** Minimal cookie parser, so no cookie-parser dependency. */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export const SESSION_COOKIE = 'speedy_session';
