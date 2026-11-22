/**
 * Speedy 边缘网关 Worker。
 *
 * 职责(严格边界,不含任何游戏逻辑):
 *   1. 托管前端静态资源(Workers Assets,全球 CDN)
 *   2. 把 /ws 的 WebSocket 双向透传到源站 Node 权威服
 *
 * 实现:用 fetch 带 Upgrade 头连上源站,拿到 origin 侧的 WebSocket,
 * 再与浏览器侧用 WebSocketPair 配对,双向转发帧。
 * Worker 不解析任何游戏消息,只做字节搬运 + 关闭码协调。
 */

const WS_PATH = '/ws';
/** 这些前缀都交给源站 Node 处理(登录、健康检查) */
const ORIGIN_PREFIXES = ['/ws', '/api/'];

/** Workers 运行时不接受的关闭码,转发时必须替换。 */
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

/** 计算源站 URL。优先用完整的 ORIGIN_URL,便于本地联调(http://127.0.0.1:8080)。 */
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
  if (!target) return new Response('ORIGIN_HOST not configured', { status: 500 });

  const headers = new Headers(request.headers);
  headers.set('X-Forwarded-Host', new URL(request.url).host);
  headers.set('CF-Connecting-IP', request.headers.get('CF-Connecting-IP') ?? '');

  try {
    return await fetch(target.toString(), {
      method: request.method,
      headers,
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
  if (!originUrl) return new Response('ORIGIN_HOST not configured', { status: 500 });
  const clientUrl = new URL(request.url);

  let originResp;
  try {
    originResp = await fetch(originUrl.toString(), {
      method: 'GET',
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'X-Forwarded-Host': clientUrl.host,
        'X-Forwarded-Proto': 'https',
        'CF-Connecting-IP': request.headers.get('CF-Connecting-IP') ?? '',
        'User-Agent': request.headers.get('User-Agent') ?? 'speedy-worker',
      },
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
