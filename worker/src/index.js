/**
 * Speedy edge gateway Worker.
 *
 * Two jobs only. It holds no game logic.
 *   1. Serve the front end as Workers Assets from the global edge.
 *   2. Tunnel /ws (and /api/*) through to the Node origin.
 *
 * How the WebSocket proxy works: fetch() to the origin with an Upgrade header
 * returns the origin's socket on response.webSocket. That socket is paired with
 * a WebSocketPair for the browser and frames are copied both ways. The Worker
 * never parses a game packet, it only moves bytes and coordinates close codes.
 */

const WS_PATH = '/ws';
/** Paths that belong to the Node origin (the game channel and the JSON API) */
const ORIGIN_PREFIXES = ['/ws', '/api/'];

/** Close codes the Workers runtime refuses to forward */
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
 * Resolve the origin URL. ORIGIN_URL wins so a local origin works in dev
 * (http://127.0.0.1:8080); ORIGIN_HOST is the plain host form.
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

/** Plain HTTP passthrough for the JSON API. */
async function proxyHttp(request, env) {
  const target = originTarget(env, request.url);
  if (!target) return new Response('ORIGIN_URL is not configured', { status: 500 });

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
  if (!originUrl) return new Response('ORIGIN_URL is not configured', { status: 500 });
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
    // Pass the origin's status through so the page can report something useful
    return new Response(`Origin refused upgrade (${originResp.status})`, {
      status: originResp.status === 101 ? 502 : originResp.status,
    });
  }

  originWs.accept();

  const pair = new WebSocketPair();
  const [clientWs, serverWs] = Object.values(pair);
  serverWs.accept();

  // Browser to origin
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

  // Origin to browser
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

/** Close without throwing, replacing codes the runtime will not send. */
function safeClose(ws, code, reason) {
  try {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
    const sendable =
      Number.isInteger(code) && code >= 1000 && code < 5000 && !UNSENDABLE_CLOSE_CODES.has(code);
    // Reasons are capped at 123 bytes, longer ones are rejected
    const text = typeof reason === 'string' ? reason.slice(0, 100) : '';
    if (sendable) ws.close(code, text);
    else if (code === 1000) ws.close(1000, text);
    else ws.close(1011, text || 'upstream_closed');
  } catch {
    try {
      ws.close(1011, 'close_failed');
    } catch {
      /* already closed */
    }
  }
}
