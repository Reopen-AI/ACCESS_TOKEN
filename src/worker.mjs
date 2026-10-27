const encoder = new TextEncoder();
const STATIC_PATHS = new Set(['/', '/index.html', '/app.js', '/styles.css', '/icon.svg']);
const ACTION = 'token_apply';
const CSP = [
  "default-src 'none'", "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self'", "img-src 'self' data:",
  "connect-src 'self' https://challenges.cloudflare.com",
  'frame-src https://challenges.cloudflare.com',
  "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'",
].join('; ');

class PortalError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const notReady = () => new PortalError(503, 'NOT_CONFIGURED', '申请服务暂未开放，请稍后再试。');
const badUpstream = () => new PortalError(502, 'SERVICE_UNAVAILABLE', '翻译服务暂时无法签发 Token，请稍后重试。');

function clean(value, max = 4096) {
  return typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
}

function readConfig(env, url) {
  const signingKey = clean(env.DEVICE_SIGNING_KEY);
  const turnstileSecret = clean(env.TURNSTILE_SECRET_KEY);
  const siteKey = clean(env.TURNSTILE_SITE_KEY, 256);
  const deviceId = clean(env.PUBLIC_DEVICE_ID, 128);
  const appVersion = clean(env.APP_VERSION, 64);
  const deviceVersion = clean(env.DEVICE_VERSION, 64);
  let allowedDeviceIds;
  let authUrl;
  try {
    allowedDeviceIds = JSON.parse(env.PUBLIC_DEVICE_IDS || JSON.stringify([deviceId]));
    if (!Array.isArray(allowedDeviceIds) || !allowedDeviceIds.length || allowedDeviceIds.length > 100 ||
        allowedDeviceIds.some(id => typeof id !== 'string' || !id || id !== id.trim() || id.length > 128 || /[|\u0000-\u001f]/.test(id)) ||
        !allowedDeviceIds.includes(deviceId)) throw new Error();
    const base = new URL(clean(env.API_BASE_URL, 2048));
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error();
    authUrl = new URL('/api/v1/auth', base).href;
    const expectedOrigin = clean(env.PUBLIC_ORIGIN, 2048);
    if (expectedOrigin && (new URL(expectedOrigin).origin !== expectedOrigin || expectedOrigin !== url.origin)) throw new Error();
  } catch { throw notReady(); }
  if (!signingKey || signingKey.startsWith('REPLACE_') || !turnstileSecret || turnstileSecret.startsWith('REPLACE_') || !siteKey || siteKey.startsWith('REPLACE_') ||
      /^[123]x/.test(siteKey) || /^[123]x/.test(turnstileSecret) ||
      !deviceId || /[|\r\n\u0000-\u001f]/.test(deviceId) ||
      !appVersion || /[|\r\n\u0000-\u001f]/.test(appVersion) ||
      !deviceVersion || /[|\r\n\u0000-\u001f]/.test(deviceVersion) ||
      typeof env.IP_RATE_LIMITER?.limit !== 'function' || typeof env.SITE_RATE_LIMITER?.limit !== 'function') throw notReady();
  return { signingKey, turnstileSecret, siteKey, deviceId, allowedDeviceIds, appVersion, deviceVersion, authUrl };
}

function secure(response, url) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Content-Security-Policy', CSP);
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (url.protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
  headers.delete('Access-Control-Allow-Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

async function readJson(body, maxBytes) {
  if (!body) throw new Error('Empty body');
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('Body too large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value;
}

export async function makeAuthBody(config, timestamp = Math.floor(Date.now() / 1000), nonce) {
  if (!nonce) {
    const bytes = crypto.getRandomValues(new Uint8Array(5));
    nonce = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  const body = {
    device_id: config.deviceId, app_version: config.appVersion,
    device_version: config.deviceVersion, timestamp, nonce,
  };
  const key = await crypto.subtle.importKey('raw', encoder.encode(config.signingKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode([body.device_id, body.app_version, body.device_version, timestamp, nonce].join('|')));
  body.sign = Array.from(new Uint8Array(signed), b => b.toString(16).padStart(2, '0')).join('');
  return body;
}

async function verifyTurnstile(request, config, token, upstreamFetch) {
  try {
    const result = await upstreamFetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: config.turnstileSecret, response: token, remoteip: request.headers.get('CF-Connecting-IP') }),
    });
    if (!result.ok) throw new Error();
    const data = await readJson(result.body, 16384);
    if (data.success !== true || data.hostname !== new URL(request.url).hostname || data.action !== ACTION) {
      throw new PortalError(400, 'VERIFICATION_FAILED', '安全验证未通过或已过期，请重新验证。');
    }
  } catch (error) {
    if (error instanceof PortalError) throw error;
    throw new PortalError(503, 'VERIFICATION_UNAVAILABLE', '安全验证服务暂时不可用，请稍后重试。');
  }
}

async function issueToken(request, env, config, upstreamFetch) {
  const url = new URL(request.url);
  if (request.headers.get('Origin') !== url.origin || ['cross-site', 'same-site'].includes(request.headers.get('Sec-Fetch-Site'))) {
    throw new PortalError(403, 'ORIGIN_REJECTED', '请从申请页面提交请求。');
  }
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new PortalError(415, 'INVALID_CONTENT_TYPE', '请求格式不正确，请刷新页面后重试。');
  }
  // CF-Connecting-IP is set by Cloudflare's edge; do not use user-supplied X-Forwarded-For.
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || ip.length > 64) throw notReady();
  try {
    const ipResult = await env.IP_RATE_LIMITER.limit({ key: `apply:${ip}` });
    if (!ipResult.success) throw new PortalError(429, 'RATE_LIMITED', '申请较频繁，请一分钟后再试。');
    const siteResult = await env.SITE_RATE_LIMITER.limit({ key: `apply:${url.hostname}` });
    if (!siteResult.success) throw new PortalError(429, 'RATE_LIMITED', '当前申请人数较多，请一分钟后再试。');
  } catch (error) {
    if (error instanceof PortalError) throw error;
    throw new PortalError(503, 'RATE_LIMIT_UNAVAILABLE', '申请服务暂时繁忙，请稍后重试。');
  }
  let input;
  try {
    input = await readJson(request.body, 4096);
    if (Object.keys(input).some(key => !['turnstileToken', 'device_id'].includes(key)) ||
        typeof input.device_id !== 'string' || !input.device_id.trim() || input.device_id.length > 128 || /[|\u0000-\u001f]/.test(input.device_id) ||
        typeof input.turnstileToken !== 'string' || !input.turnstileToken.trim() || input.turnstileToken.length > 2048) throw new Error();
  } catch { throw new PortalError(400, 'INVALID_REQUEST', '申请内容不正确，请刷新页面后重试。'); }
  const deviceId = input.device_id.trim();
  if (!config.allowedDeviceIds.includes(deviceId)) throw new PortalError(403, 'DEVICE_NOT_PUBLIC', '此设备未开放公开申请，请检查设备 ID 或联系服务提供方。');
  await verifyTurnstile(request, config, input.turnstileToken, upstreamFetch);
  let payload;
  try {
    const response = await upstreamFetch(config.authUrl, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await makeAuthBody({ ...config, deviceId })),
    });
    if (!response.ok) throw new Error();
    payload = await readJson(response.body, 262144);
  } catch { throw badUpstream(); }
  if (payload.code !== undefined && payload.code !== 0) {
    if (payload.code === 4004) throw new PortalError(503, 'DEVICE_NOT_READY', '申请设备暂不可用，请联系服务提供方。');
    throw badUpstream();
  }
  const token = payload.data?.access_token;
  if (typeof token !== 'string' || !token.trim() || token.length > 16384 || /[\r\n\u0000-\u001f]/.test(token)) throw badUpstream();
  const expiresIn = payload.data.expires_in;
  // Preserve an explicit lifetime only when the upstream supplies it; do not guess from an unsigned JWT.
  return json({
    device_id: deviceId, access_token: token,
    expires_in: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null,
  });
}

// Dependency injection is used by offline tests/preview; the deployed default always uses fetch.
export function createHandler(upstreamFetch = (...args) => fetch(...args)) {
  return async function handle(request, env) {
    const url = new URL(request.url);
    let response;
    try {
      if (url.pathname === '/api/config' && request.method === 'GET') {
        let config;
        try { config = readConfig(env, url); } catch { /* Return a public availability status only. */ }
        response = json({ ready: Boolean(config), site_key: config?.siteKey || '', action: ACTION, default_device_id: config?.deviceId || clean(env.PUBLIC_DEVICE_ID, 128) || 'test' });
      } else if (url.pathname === '/api/token' && request.method === 'POST') {
        response = await issueToken(request, env, readConfig(env, url), upstreamFetch);
      } else if (STATIC_PATHS.has(url.pathname) && ['GET', 'HEAD'].includes(request.method)) {
        response = await env.ASSETS.fetch(request);
      } else if (['/api/config', '/api/token'].includes(url.pathname)) {
        response = json({ error: { code: 'METHOD_NOT_ALLOWED', message: '不支持此请求方法。' } }, 405);
        response.headers.set('Allow', url.pathname === '/api/config' ? 'GET' : 'POST');
      } else {
        response = json({ error: { code: 'NOT_FOUND', message: '页面不存在。' } }, 404);
      }
    } catch (error) {
      const publicError = error instanceof PortalError ? error : new PortalError(500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试。');
      response = json({ error: { code: publicError.code, message: publicError.message } }, publicError.status);
      if (publicError.status === 429) response.headers.set('Retry-After', '60');
    }
    return secure(response, url);
  };
}

export default { fetch: createHandler() };
