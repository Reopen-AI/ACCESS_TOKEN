// Offline preview only. This file is not the Worker entry point and is never deployed.
// It does not read .env, .dev.vars or the real device signing key.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createHandler } from '../src/worker.mjs';

const port = Number(process.env.TOKEN_PREVIEW_PORT || 18809);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port');
const origin = `http://localhost:${port}`;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const files = new Set(['index.html', 'app.js', 'styles.css', 'icon.svg']);
const env = {
  API_BASE_URL: 'https://offline-backend.invalid', PUBLIC_DEVICE_ID: 'test', PUBLIC_DEVICE_IDS: '["test","demo"]',
  APP_VERSION: 'V0.2.8', DEVICE_VERSION: '1.3', DEVICE_SIGNING_KEY: 'offline-preview-key-never-for-production',
  TURNSTILE_SITE_KEY: '0xOfflinePreviewSiteKey', TURNSTILE_SECRET_KEY: '0xOfflinePreviewSecret',
  PUBLIC_ORIGIN: origin,
  IP_RATE_LIMITER: { async limit() { return { success: true }; } },
  SITE_RATE_LIMITER: { async limit() { return { success: true }; } },
  ASSETS: {
    async fetch(request) {
      const name = new URL(request.url).pathname.slice(1) || 'index.html';
      if (!files.has(name)) return new Response('Not found', { status: 404 });
      const content = await readFile(new URL(`../public/${name}`, import.meta.url));
      const extension = name.slice(name.lastIndexOf('.'));
      return new Response(request.method === 'HEAD' ? null : content, { headers: { 'Content-Type': types[extension] } });
    },
  },
};
const handle = createHandler(async url => {
  if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
    return Response.json({ success: true, hostname: 'localhost', action: 'token_apply' });
  }
  if (url === 'https://offline-backend.invalid/api/v1/auth') {
    return Response.json({ code: 0, data: { access_token: 'DEMO_ONLY_NOT_A_REAL_TOKEN_' + crypto.randomUUID(), expires_in: 1800 } });
  }
  throw new Error('Preview network access is disabled');
});

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== `localhost:${port}`) { res.writeHead(403).end('Use localhost'); return; }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
    headers.set('CF-Connecting-IP', '127.0.0.1');
    const request = new Request(new URL(req.url, origin), {
      method: req.method, headers,
      ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
    });
    let response = await handle(request, env);
    if (request.method === 'GET' && new URL(request.url).pathname === '/api/config') {
      response = new Response(JSON.stringify({ ...await response.json(), preview: true }), { status: response.status, headers: response.headers });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch { res.writeHead(500).end('Offline preview error'); }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Offline preview: ${origin} (mock tokens only; no real API calls)`);
});
