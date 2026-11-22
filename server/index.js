/**
 * Speedy 服务入口。
 *
 *   - HTTP:静态页 + /api/login|register|session|ws-ticket|health
 *   - WebSocket:长连接游戏通道,握手时校验 session token
 *   - GameRoom:20 tick/s 权威模拟 + 10Hz 广播
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { AUTH, GAME, NETWORK, isProduction, turnstileConfig } from './config.js';
import {
  SESSION_COOKIE,
  hashPassword,
  issueSessionToken,
  parseCookies,
  verifyPassword,
  verifySessionToken,
} from './auth.js';
import { GameRoom } from './gameRoom.js';
import { readJsonBody, sendJson, serveStatic } from './http.js';
import { closeLogger, createLogger } from './logger.js';
import { getStore } from './store.js';
import { clientIp, isConfigured as turnstileConfigured, verifyToken } from './turnstile.js';

const log = createLogger('server');

const store = getStore();
const room = new GameRoom({ store });

/**
 * 源站与边缘之间的共享密钥。
 *
 * speed-origin 这个域名是公网可直连的,所以只在前端放 Turnstile 等于没放:
 * 攻击者直接 POST 源站就能跳过。Worker 在转发时带上这个头,Node 只接受
 * 带了正确头的请求,从而保证所有流量都必须经过 Worker。
 *
 * 未配置时(Node 直接从公网访问、或本地开发)不做这项检查。
 */
const ORIGIN_SHARED_SECRET = process.env.ORIGIN_SHARED_SECRET || '';

if (!turnstileConfigured()) {
  log.error(
    '进程环境变量里没有 Turnstile key。生产环境由 Worker 随请求头下发,可以忽略本条;' +
      '本地开发请在 .env 中补齐 CF_TURNSTILE_SITE_KEY 与 CF_TURNSTILE_SECRECT_KEY。',
  );
}
if (isProduction && !ORIGIN_SHARED_SECRET) {
  log.warn(
    '未配置 ORIGIN_SHARED_SECRET。源站域名若可被公网直连,' +
      '攻击者可绕过 Worker 的 Turnstile 直接打源站。',
  );
}

/* ------------------------------------------------------------------------- *
 * HTTP 路由
 * ------------------------------------------------------------------------- */
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

/** 允许的 action 值,与前端 widget 的 action 参数一一对应。 */
const TURNSTILE_ACTION = {
  login: 'login',
  register: 'register',
};

/**
 * 请求是否确实来自我们自己的 Worker。
 * 未配置共享密钥时一律放行(本地开发、直连部署)。
 */
function cameThroughWorker(req) {
  if (!ORIGIN_SHARED_SECRET) return true;
  const provided = req.headers['x-origin-secret'];
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(ORIGIN_SHARED_SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 校验 Turnstile,并统一给出错误响应。
 * @returns {Promise<boolean>} true 表示通过,可以直接继续
 */
async function passTurnstile(req, res, action) {
  const result = await verifyToken(req.turnstileToken, {
    remoteIp: clientIp(req),
    expectedAction: action,
    req,
  });
  if (result.ok) return true;

  log.warn('人机校验未通过', { action, reason: result.reason, codes: result.codes });
  const status = result.reason === 'not_configured' ? 503 : 403;
  sendJson(res, status, { error: 'captcha_failed', reason: result.reason });
  return false;
}

function validateCredentials(body) {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!USERNAME_RE.test(username)) return { error: 'invalid_username' };
  if (password.length < AUTH.passwordMinLength || password.length > AUTH.passwordMaxLength) {
    return { error: 'invalid_password' };
  }
  return { username, password };
}

function cookieHeader(token, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isProduction) parts.push('Secure');
  return parts.join('; ');
}

async function handleRegister(req, res) {
  const body = await readJsonBody(req);
  if (body.error) return sendJson(res, 400, { error: body.error });

  req.turnstileToken = typeof body.data.turnstileToken === 'string' ? body.data.turnstileToken : '';
  if (!(await passTurnstile(req, res, TURNSTILE_ACTION.register))) return undefined;

  const creds = validateCredentials(body.data);
  if (creds.error) return sendJson(res, 400, { error: creds.error });

  try {
    const user = await store.createUser({
      username: creds.username,
      passwordHash: hashPassword(creds.password),
      displayName: creds.username,
    });
    await store.recordLogin(user.uid);
    const token = issueSessionToken(user.uid);
    const auditId = await store.startSessionAudit(user.uid, 'pending');
    return sendJson(
      res,
      201,
      { ok: true, uid: user.uid, username: user.username, displayName: user.display_name },
      { 'Set-Cookie': cookieHeader(token, Math.floor(AUTH.sessionTtlMs / 1000)) },
    );
  } catch (err) {
    if (err.message === 'username_taken') {
      return sendJson(res, 409, { error: 'username_taken' });
    }
    log.error('注册失败', { message: err.message });
    return sendJson(res, 500, { error: 'server_error' });
  }
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  if (body.error) return sendJson(res, 400, { error: body.error });

  req.turnstileToken = typeof body.data.turnstileToken === 'string' ? body.data.turnstileToken : '';
  if (!(await passTurnstile(req, res, TURNSTILE_ACTION.login))) return undefined;

  const creds = validateCredentials(body.data);
  if (creds.error) return sendJson(res, 400, { error: creds.error });

  try {
    const user = await store.findUserByUsername(creds.username);
    // 用户不存在时也做一次哈希,避免通过响应时间枚举用户名
    const ok = user
      ? verifyPassword(creds.password, user.password_hash)
      : (verifyPassword(creds.password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'), false);

    if (!user || !ok) return sendJson(res, 401, { error: 'invalid_credentials' });

    await store.recordLogin(user.uid);
    const token = issueSessionToken(user.uid);
    return sendJson(
      res,
      200,
      { ok: true, uid: user.uid, username: user.username, displayName: user.display_name },
      { 'Set-Cookie': cookieHeader(token, Math.floor(AUTH.sessionTtlMs / 1000)) },
    );
  } catch (err) {
    log.error('登录失败', { message: err.message });
    return sendJson(res, 500, { error: 'server_error' });
  }
}

async function handleSession(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  const result = verifySessionToken(token);
  if (!result.ok) return sendJson(res, 401, { ok: false, error: result.reason });

  try {
    const user = await store.findUserById(result.payload.uid);
    if (!user) return sendJson(res, 401, { ok: false, error: 'user_not_found' });
    return sendJson(res, 200, {
      ok: true,
      uid: user.uid,
      username: user.username,
      displayName: user.display_name,
      skinId: user.equipped_skin,
    });
  } catch (err) {
    log.error('会话查询失败', { message: err.message });
    return sendJson(res, 500, { ok: false, error: 'server_error' });
  }
}

/**
 * 签发一个用于 WebSocket 握手的短期 token。
 *
 * 浏览器读不到 HttpOnly cookie;而走 Cloudflare Worker 代理时,
 * query 参数比跨域 cookie 好处理得多。票据有效期与 session 相同,
 * 且只发给已登录的调用方。
 */
function handleWsTicket(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies[SESSION_COOKIE];
  const result = verifySessionToken(sessionToken);
  if (!result.ok) return sendJson(res, 401, { ok: false, error: result.reason });

  const ticket = issueSessionToken(result.payload.uid);
  return sendJson(res, 200, { ok: true, token: ticket, expiresInMs: AUTH.sessionTtlMs });
}

function handleLogout(req, res) {
  sendJson(res, 200, { ok: true }, {
    'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`,
  });
}

/**
 * 公开配置:只给浏览器需要的东西。
 * site key 本来就是公开值(会出现在 HTML 里),secret 绝不外传。
 */
function handleConfig(req, res) {
  const cfg = turnstileConfig(req);
  const enabled = Boolean(cfg.siteKey && cfg.secretKey);
  sendJson(res, 200, {
    ok: true,
    turnstile: {
      enabled,
      siteKey: enabled ? cfg.siteKey : null,
      scriptUrl: cfg.widgetScript,
    },
  });
}

function handleHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    ticks: room.world.tick,
    online: room.world.onlineCount,
    maxOnline: GAME.maxOnline,
    uptimeSec: Math.round(process.uptime()),
    store: store.enabled ? 'postgres' : 'memory',
  });
}

/* ------------------------------------------------------------------------- *
 * 服务器装配
 * ------------------------------------------------------------------------- */
const server = http.createServer((req, res) => {
  const url = req.url || '/';

  // /api/config 与 /api/health 是公开的,其余一律要求来自 Worker
  if (url === '/api/config') return handleConfig(req, res);
  if (url === '/api/health') return handleHealth(req, res);

  if (url.startsWith('/api/') && !cameThroughWorker(req)) {
    // 直连源站、且没带共享密钥:直接拒绝,防止绕过 Worker 上的任何保护
    return sendJson(res, 403, { error: 'direct_origin_forbidden' });
  }

  if (url === '/api/register' && req.method === 'POST') {
    handleRegister(req, res).catch((err) => {
      log.error('注册处理异常', { message: err.message });
      sendJson(res, 500, { error: 'server_error' });
    });
    return;
  }
  if (url === '/api/login' && req.method === 'POST') {
    handleLogin(req, res).catch((err) => {
      log.error('登录处理异常', { message: err.message });
      sendJson(res, 500, { error: 'server_error' });
    });
    return;
  }
  if (url === '/api/session') return handleSession(req, res);
  if (url === '/api/ws-ticket') return handleWsTicket(req, res);
  if (url === '/api/logout' && req.method === 'POST') return handleLogout(req, res);

  if (url.startsWith('/api/')) return sendJson(res, 404, { error: 'not_found' });

  serveStatic(req, res).catch(() => {
    if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
    else res.destroy();
  });
});

const wss = new WebSocketServer({
  server,
  path: NETWORK.wsPath,
  maxPayload: 4096,
  perMessageDeflate: false,
  clientTracking: false,
});

/**
 * 握手阶段校验 token。优先 URL 参数(便于 Worker 代理场景),
 * 其次 HttpOnly Cookie。
 *
 * 同时要求请求经过来自 Worker 的共享密钥:否则攻击者可以完全跳过 Worker,
 * 直连源站的 WebSocket,把人机校验甩在身后。
 */
wss.on('connection', async (ws, req) => {
  if (!cameThroughWorker(req)) {
    ws.close(4003, 'direct_origin_forbidden');
    return;
  }

  let token = null;
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    token = url.searchParams.get('token');
  } catch {
    token = null;
  }
  if (!token) {
    const cookies = parseCookies(req.headers.cookie);
    token = cookies[SESSION_COOKIE] ?? null;
  }

  const verdict = verifySessionToken(token);
  if (!verdict.ok) {
    ws.send(JSON.stringify({ type: 'error', code: 'unauthorized', reason: verdict.reason }));
    ws.close(4001, 'unauthorized');
    return;
  }

  let user;
  try {
    user = await store.findUserById(verdict.payload.uid);
  } catch (err) {
    log.error('握手查询用户失败', { message: err.message });
    ws.close(1011, 'internal_error');
    return;
  }
  if (!user) {
    ws.close(4001, 'unauthorized');
    return;
  }

  let auditId = null;
  try {
    auditId = await store.startSessionAudit(user.uid, verdict.payload.jti);
  } catch (err) {
    log.warn('会话审计创建失败', { message: err.message });
  }

  const session = await room.attach(ws, {
    uid: user.uid,
    displayName: user.display_name,
    skinId: user.equipped_skin,
    jti: verdict.payload.jti,
    auditId,
  });
  if (!session) return;

  ws.on('message', (raw) => {
    // 任何上行消息都说明连接活着,统一刷新心跳时间,
    // 避免因客户端只发输入包而不回 pong 被误判为死连接。
    session.lastPongAt = Date.now();
    try {
      room.handleMessage(session, raw);
    } catch (err) {
      log.error('消息处理异常', { uid: session.uid, message: err.message });
    }
  });

  ws.on('pong', () => {
    session.lastPongAt = Date.now();
  });

  ws.on('close', (code, reasonBuf) => {
    room.detach(session, `close:${code}:${reasonBuf?.toString().slice(0, 40) ?? ''}`);
  });

  ws.on('error', (err) => {
    log.warn('连接异常', { uid: session.uid, message: err.message });
  });
});

/* ------------------------------------------------------------------------- *
 * 启动 / 关闭
 * ------------------------------------------------------------------------- */
async function main() {
  if (!AUTH.secret) {
    log.error('SESSION_SECRET 未配置,拒绝启动。请参考 .env.example 生成一个。');
    process.exit(1);
  }

  await store.init();
  room.start();

  server.listen(NETWORK.port, NETWORK.host, () => {
    log.info(`Speedy 已启动 http://${NETWORK.host}:${NETWORK.port}`);
    log.info(`WebSocket 路径 ${NETWORK.wsPath}`);
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`收到 ${signal},正在关闭...`);

  const forceExit = setTimeout(() => {
    log.warn('关闭超时,强制退出');
    process.exit(1);
  }, 12_000);
  forceExit.unref();

  try {
    await room.stop();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  } catch (err) {
    log.error('关闭异常', { message: err.message });
  } finally {
    clearTimeout(forceExit);
    closeLogger();
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  log.error('未处理的 Promise 拒绝', { message: err?.message ?? String(err) });
});
process.on('uncaughtException', (err) => {
  log.error('未捕获异常', { message: err?.message, stack: err?.stack });
  shutdown('uncaughtException');
});

main().catch((err) => {
  log.error('启动失败', { message: err.message, stack: err.stack });
  process.exit(1);
});

export { server, wss, room };
