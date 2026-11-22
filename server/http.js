/**
 * Static file serving.
 * - No dependencies, only the public/ directory.
 * - Strict path validation so no request can escape that directory.
 * - Vendored libraries get a long cache; our own code revalidates.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT_DIR } from './config.js';

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Same-origin scripts and WebSocket only, no third-party origins, no inline script
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self' ws: wss:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
  );
}

/**
 * Map a URL to a real file under public/.
 * @returns {string|null} absolute path, or null when the request tries to escape
 */
export function resolveStaticPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (decoded === '/' || decoded === '') decoded = '/index.html';
  // Reject null bytes and backslashes
  if (decoded.includes('\0') || decoded.includes('\\')) return null;

  const normalized = path.posix.normalize(decoded);
  if (!normalized.startsWith('/')) return null;

  const absolute = path.join(PUBLIC_DIR, normalized);
  const relative = path.relative(PUBLIC_DIR, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return absolute;
}

export async function serveStatic(req, res) {
  setSecurityHeaders(res);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  const target = resolveStaticPath(req.url || '/');
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(target);
    if (stat.isDirectory()) throw new Error('is_dir');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const isHtml = ext === '.html';
  // Vendored libraries never change, so they get a long immutable cache.
  // Our own code must revalidate, or a browser will run yesterday's build.
  const isVendored = target.startsWith(path.join(PUBLIC_DIR, 'vendor') + path.sep);
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('ETag', etag);
  res.setHeader(
    'Cache-Control',
    isVendored ? 'public, max-age=604800, immutable' : 'no-cache',
  );

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Length': stat.size });
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Length': stat.size });
  const stream = fs.createReadStream(target);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/**
 * Send a JSON response, used by the /api routes.
 */
export function sendJson(res, status, body, extraHeaders = {}) {
  setSecurityHeaders(res);
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

/**
 * Read a JSON request body with a size cap.
 */
export function readJsonBody(req, limitBytes = 8 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limitBytes) {
        aborted = true;
        resolve({ error: 'payload_too_large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      if (chunks.length === 0) {
        resolve({ error: 'empty_body' });
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          resolve({ error: 'invalid_body' });
          return;
        }
        resolve({ data: parsed });
      } catch {
        resolve({ error: 'invalid_json' });
      }
    });

    req.on('error', () => {
      if (!aborted) resolve({ error: 'read_error' });
    });
  });
}
