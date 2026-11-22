/**
 * Cloudflare Turnstile 服务端校验。
 *
 * 前端拿到的 token 只能证明"这个浏览器通过了挑战",必须由服务端带着
 * Secret Key 再去 Cloudflare 校验一次,否则任何人都能伪造一个 token。
 *
 * 校验端点:POST https://challenges.cloudflare.com/turnstile/v0/siteverify
 * 参数是 application/x-www-form-urlencoded,不是 JSON。
 *
 * key 的来源见 config.js 的 turnstileConfig():本地读进程环境变量,
 * 生产环境由 Worker 随请求头带过来。
 */
import { turnstileConfig } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('turnstile');

/**
 * 配置是否齐全。缺任何一个 key 都算没配置。
 * @param {import('node:http').IncomingMessage} [req]
 */
export function isConfigured(req) {
  const cfg = turnstileConfig(req);
  return Boolean(cfg.siteKey && cfg.secretKey);
}

/**
 * 校验一个 Turnstile token。
 *
 * @param {string} token 前端 cf-turnstile-response 的值
 * @param {object} [options]
 * @param {string} [options.remoteIp] 客户端 IP,Turnstile 的官方建议项
 * @param {string} [options.expectedAction] 期望的 action 值,防止 token 跨用途复用
 * @param {import('node:http').IncomingMessage} [options.req] 用来读取 Worker 带来的 key
 * @returns {Promise<{ok: true} | {ok: false, reason: string, codes?: string[]}>}
 */
export async function verifyToken(token, { remoteIp, expectedAction, req } = {}) {
  const cfg = turnstileConfig(req);
  if (!cfg.siteKey || !cfg.secretKey) {
    return { ok: false, reason: 'not_configured' };
  }
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
    return { ok: false, reason: 'missing_token' };
  }

  const form = new URLSearchParams();
  form.set('secret', cfg.secretKey);
  form.set('response', token);
  if (remoteIp) form.set('remoteip', remoteIp);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  let payload;
  try {
    const res = await fetch(cfg.verifyUrl, {
      method: 'POST',
      body: form,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn('siteverify 返回非 200', { status: res.status });
      return { ok: false, reason: 'upstream_error' };
    }
    payload = await res.json();
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    log.warn('siteverify 请求失败', { message: err?.message, timedOut });
    return { ok: false, reason: timedOut ? 'upstream_timeout' : 'upstream_error' };
  } finally {
    clearTimeout(timer);
  }

  if (payload?.success === true) {
    // 如果调用方指定了 action,核对一下,避免拿登录的 token 去注册
    if (expectedAction && payload.action && payload.action !== expectedAction) {
      log.warn('action 不匹配', { expected: expectedAction, got: payload.action });
      return { ok: false, reason: 'action_mismatch', codes: payload['error-codes'] ?? [] };
    }
    return { ok: true };
  }

  const codes = Array.isArray(payload?.['error-codes']) ? payload['error-codes'] : [];
  log.warn('校验未通过', { codes });
  return { ok: false, reason: 'rejected', codes };
}

/**
 * 取出客户端真实 IP。
 * 经过 Cloudflare Worker 时由 CF-Connecting-IP 带过来。
 */
export function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.length > 0) return cf.split(',')[0].trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress ?? undefined;
}
