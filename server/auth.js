/**
 * 密码哈希与 session token。
 *
 * - 密码:scrypt(N=16384) + 每用户独立 salt,存成 "scrypt$N$r$p$salt$hash"。
 * - session:自包含 HMAC 签名 token,格式 base64url(payload).base64url(sig)。
 *   payload 内含 uid / jti / 过期时间,不依赖数据库即可快速校验。
 */
import crypto from 'node:crypto';
import { AUTH } from './config.js';

/** 哈希明文密码,返回可直接入库的字符串。 */
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

/** 校验明文密码。使用 timingSafeEqual 避免时序侧信道。 */
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

/** 生成 session token。 */
export function issueSessionToken(uid, { ttlMs = AUTH.sessionTtlMs, secret = AUTH.secret } = {}) {
  if (!secret) throw new Error('SESSION_SECRET 未配置');
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
 * 校验 session token。
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

/** 简单的 HTTP-only cookie 解析,避免引入 cookie-parser。 */
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
