/**
 * Speedy 服务入口。
 *
 *   - HTTP:静态页 + /api/login|register|session|ws-ticket|health
 *   - WebSocket:长连接游戏通道,握手时校验 session token
 *   - GameRoom:20 tick/s 权威模拟 + 10Hz 广播
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { AUTH, GAME, NETWORK, isProduction } from './config.js';
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

const log = createLogger('server');

const store = getStore();
const room = new GameRoom({ store });

/* ------------------------------------------------------------------------- *
 * HTTP 路由
 * ------------------------------------------------------------------------- */
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

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

function handleHealth(req, res) {  sendJson(res, 200, {
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

  if (url === '/api/health') return handleHealth(req, res);
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
 */
wss.on('connection', async (ws, req) => {
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
