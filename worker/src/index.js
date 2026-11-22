/**
 * Speedy 边缘网关 Worker。
 *
 * 只做两件事,不含任何游戏逻辑:
 *   1. 托管前端静态资源(Workers Assets,全球 CDN)
 *   2. 把 /ws 与 /api/* 透传到源站 Node 权威服
 *
 * WebSocket 代理原理:带 Upgrade 头 fetch 到源站,源站的 socket 落在
 * response.webSocket 上;再与浏览器侧用 WebSocketPair 配对,双向转发帧。
 * Worker 不解析任何游戏消息,只搬运字节并协调关闭码。
 */

const WS_PATH = '/ws';
/** 交给源站 Node 的路径前缀(游戏通道与 JSON API) */
const ORIGIN_PREFIXES = ['/ws', '/api/'];

/** Workers 运行时不接受的关闭码,转发时必须替换 */
const UNSENDABLE_CLOSE_CODES = new Set([1004, 1005, 1006, 1015]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (ORIGIN_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p))) {
      if (url.pathname === WS_PATH || url.pathname.startsWith(`${WS_PATH}/`)) {
        return proxyWebSocket(request, env);
      }
      return proxyHttp(request, env);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);

    return new Response('Not Found', { status: 404 });
  },
};

/**
 * 源站需要的头。
 *
 * - X-Origin-Secret:证明这次请求来自本 Worker。源站域名可被公网直连,
 *   没有这个头的话,攻击者能绕过 Turnstile 直接打源站。
 * - X-Turnstile-Site-Key / -Secret:Turnstile 的 key 存在 Worker 的环境变量里,
 *   源站进程读不到,所以由这里随请求带过去。两个头都只在本机回环的
 *   源站链路上出现,不经过任何其他网络。
 */
function originHeaders(env, request, extra = {}) {
  const headers = new Headers(request.headers);
  headers.set('X-Forwarded-Host', new URL(request.url).host);
  headers.set('CF-Connecting-IP', request.headers.get('CF-Connecting-IP') ?? '');

  const secret = env.ORIGIN_SHARED_SECRET;
  if (secret) headers.set('X-Origin-Secret', secret);

  // 变量名沿用 Cloudflare 上已有的（注意 SECRECT 的拼写）
  const siteKey = env.CF_TURNSTILE_SITE_KEY;
  const turnstileSecret = env.CF_TURNSTILE_SECRECT_KEY || env.CF_TURNSTILE_SECRET_KEY;
  if (siteKey) headers.set('X-Turnstile-Site-Key', siteKey);
  if (turnstileSecret) headers.set('X-Turnstile-Secret-Key', turnstileSecret);

  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return headers;
}

/**
 * 计算源站 URL。优先用完整的 ORIGIN_URL,便于本地联调
 * (http://127.0.0.1:8080);ORIGIN_HOST 是纯主机名形式。
 */
function originTarget(env, requestUrl) {
  const raw = env.ORIGIN_URL || (env.ORIGIN_HOST ? `https://${env.ORIGIN_HOST}` : '');
  if (!raw) return null;
  const url = new URL(raw);
  const incoming = new URL(requestUrl);
  url.pathname = incoming.pathname;
  url.search = incoming.search;
  return url;
}

/** 普通 HTTP 请求(API)透传 */
async function proxyHttp(request, env) {
  const target = originTarget(env, request.url);
  if (!target) return new Response('ORIGIN_URL is not configured', { status: 500 });

  try {
    return await fetch(target.toString(), {
      method: request.method,
      headers: originHeaders(env, request),
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    });
  } catch (err) {
    return new Response(`Bad Gateway: ${err?.message ?? 'origin unreachable'}`, { status: 502 });
  }
}

async function proxyWebSocket(request, env) {
  const upgrade = request.headers.get('Upgrade');
  if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  const originUrl = originTarget(env, request.url);
  if (!originUrl) return new Response('ORIGIN_URL is not configured', { status: 500 });
  const clientUrl = new URL(request.url);

  let originResp;
  try {
    originResp = await fetch(originUrl.toString(), {
      method: 'GET',
      headers: originHeaders(env, request, {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'User-Agent': request.headers.get('User-Agent') ?? 'speedy-worker',
      }),
    });
  } catch (err) {
    return new Response(`Bad Gateway: ${err?.message ?? 'origin unreachable'}`, { status: 502 });
  }

  const originWs = originResp.webSocket;
  if (!originWs) {
    // 源站拒绝升级:把源站的状态码原样带回,便于前端提示
    return new Response(`Origin refused upgrade (${originResp.status})`, {
      status: originResp.status === 101 ? 502 : originResp.status,
    });
  }

  originWs.accept();

  const pair = new WebSocketPair();
  const [clientWs, serverWs] = Object.values(pair);
  serverWs.accept();

  // 浏览器 → 源站
  serverWs.addEventListener('message', (event) => {
    try {
      originWs.send(event.data);
    } catch {
      safeClose(serverWs, 1011, 'origin_send_failed');
      safeClose(originWs, 1011, 'origin_send_failed');
    }
  });

  serverWs.addEventListener('close', (event) => {
    safeClose(originWs, event.code, event.reason);
  });

  // 源站 → 浏览器
  originWs.addEventListener('message', (event) => {
    try {
      serverWs.send(event.data);
    } catch {
      safeClose(originWs, 1011, 'client_send_failed');
      safeClose(serverWs, 1011, 'client_send_failed');
    }
  });

  originWs.addEventListener('close', (event) => {
    safeClose(serverWs, event.code, event.reason);
  });

  return new Response(null, { status: 101, webSocket: clientWs });
}

/** 不抛异常地关闭连接,并把不可发送的关闭码替换成 1011。 */
function safeClose(ws, code, reason) {
  try {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
    const sendable =
      Number.isInteger(code) && code >= 1000 && code < 5000 && !UNSENDABLE_CLOSE_CODES.has(code);
    // reason 上限 123 字节,超长会被运行时拒绝
    const text = typeof reason === 'string' ? reason.slice(0, 100) : '';
    if (sendable) ws.close(code, text);
    else if (code === 1000) ws.close(1000, text);
    else ws.close(1011, text || 'upstream_closed');
  } catch {
    try {
      ws.close(1011, 'close_failed');
    } catch {
      /* 已关闭 */
    }
  }
}
