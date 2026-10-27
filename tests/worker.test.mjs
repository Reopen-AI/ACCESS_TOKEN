import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createHandler, makeAuthBody } from '../src/worker.mjs';

const origin = 'https://tokens.example.com';
const secret = 'offline-test-key-not-a-real-device-key';
const turnstileSecret = '0xOfflineTurnstileSecretForTestsOnly';
const dummyAccessToken = 'offline-dummy-access-token';
const ok = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

function setup(options = {}) {
  const calls = [], limits = [];
  const env = {
    API_BASE_URL: 'https://backend.example.com', PUBLIC_DEVICE_ID: 'test',
    PUBLIC_DEVICE_IDS: '["test","public-demo-2"]',
    APP_VERSION: 'V0.2.8', DEVICE_VERSION: '1.3',
    DEVICE_SIGNING_KEY: secret, TURNSTILE_SECRET_KEY: turnstileSecret,
    TURNSTILE_SITE_KEY: '0xOfflinePublicSiteKeyForTestsOnly', PUBLIC_ORIGIN: origin,
    IP_RATE_LIMITER: { async limit(value) { limits.push(['ip', value]); return { success: options.ipAllowed !== false }; } },
    SITE_RATE_LIMITER: { async limit(value) { limits.push(['site', value]); return { success: options.siteAllowed !== false }; } },
    ASSETS: { async fetch() { return new Response('<html>public page</html>', { headers: { 'Content-Type': 'text/html' } }); } },
    ...options.env,
  };
  const handle = createHandler(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (url.includes('/siteverify')) {
      if (options.verificationError) throw new Error('sensitive network diagnostics');
      return options.verificationResponse?.() || ok(options.verification || { success: true, hostname: 'tokens.example.com', action: 'token_apply' });
    }
    if (options.authError) throw new Error(`internal secret: ${secret}`);
    return options.authResponse?.() || ok(options.auth || { code: 0, data: { access_token: dummyAccessToken } });
  });
  const request = (changes = {}) => {
    const { body = { turnstileToken: 'one-time-captcha-token', device_id: 'test' }, headers = {}, method = 'POST', path = '/api/token' } = changes;
    return new Request(`${origin}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': '192.0.2.7', 'Sec-Fetch-Site': 'same-origin', ...headers },
      ...(!['GET', 'HEAD'].includes(method) ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
  };
  return { env, calls, limits, request, run: changes => handle(request(changes), env), handle };
}

test('Web Crypto HMAC matches the existing API protocol exactly', async () => {
  const config = { deviceId: 'test', appVersion: 'V0.2.8', deviceVersion: '1.3', signingKey: secret };
  const result = await makeAuthBody(config, 1793068800, '01a2b3c4d5');
  assert.deepEqual(result, {
    device_id: 'test', app_version: 'V0.2.8', device_version: '1.3', timestamp: 1793068800, nonce: '01a2b3c4d5',
    sign: createHmac('sha256', secret).update('test|V0.2.8|1.3|1793068800|01a2b3c4d5').digest('hex'),
  });
});

test('valid applicant gets only the token, selected public device and explicit lifetime', async () => {
  const s = setup({ auth: { code: 0, data: { access_token: dummyAccessToken, expires_in: 1800, internal_secret: secret } } });
  const response = await s.run({ body: { turnstileToken: 'captcha-token', device_id: ' public-demo-2 ' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { access_token: dummyAccessToken, device_id: 'public-demo-2', expires_in: 1800 });
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[0].body.secret, turnstileSecret);
  assert.equal(s.calls[0].body.remoteip, '192.0.2.7');
  const auth = s.calls[1];
  assert.equal(auth.url, 'https://backend.example.com/api/v1/auth');
  assert.equal(auth.body.device_id, 'public-demo-2');
  assert.match(auth.body.nonce, /^[0-9a-f]{10}$/);
  assert.ok(Math.abs(auth.body.timestamp - Date.now() / 1000) < 3);
  assert.equal(auth.body.sign, createHmac('sha256', secret).update([auth.body.device_id, auth.body.app_version, auth.body.device_version, auth.body.timestamp, auth.body.nonce].join('|')).digest('hex'));
  for (const call of s.calls) { assert.equal(call.init.redirect, 'manual'); assert.ok(call.init.signal instanceof AbortSignal); }
  assert.deepEqual(s.limits.map(([type]) => type), ['ip', 'site']);
});

test('does not invent a token expiry when the backend provides none', async () => {
  assert.equal((await (await setup().run()).json()).expires_in, null);
});

test('public configuration exposes only availability, public site key, action and default ID', async () => {
  const s = setup();
  const response = await s.run({ method: 'GET', path: '/api/config' });
  const text = await response.text();
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['action', 'default_device_id', 'ready', 'site_key']);
  assert.equal(JSON.parse(text).default_device_id, 'test');
  assert.equal(JSON.parse(text).ready, true);
  assert.ok(!text.includes(secret) && !text.includes(turnstileSecret) && !text.includes('backend.example.com'));
  assert.equal(s.calls.length, 0);
});

for (const [name, value] of [
  ['missing device signing key', { DEVICE_SIGNING_KEY: '' }],
  ['missing Turnstile secret', { TURNSTILE_SECRET_KEY: '' }],
  ['missing rate binding', { IP_RATE_LIMITER: undefined }],
  ['missing site rate binding', { SITE_RATE_LIMITER: undefined }],
  ['unsafe backend protocol', { API_BASE_URL: 'http://backend.example.com' }],
  ['backend URL credentials', { API_BASE_URL: 'https://user:pass@backend.example.com' }],
  ['wrong public origin', { PUBLIC_ORIGIN: 'https://another.example.com' }],
  ['invalid device list', { PUBLIC_DEVICE_IDS: '[]' }],
  ['default device absent from list', { PUBLIC_DEVICE_IDS: '["internal"]' }],
  ['placeholder signing key', { DEVICE_SIGNING_KEY: 'REPLACE_WITH_YOUR_SIGNING_KEY' }],
  ['Turnstile test site key', { TURNSTILE_SITE_KEY: '1x00000000000000000000AA' }],
  ['Turnstile test secret', { TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }],
]) test(`fails closed with ${name}`, async () => {
  const s = setup({ env: value });
  assert.equal((await s.run()).status, 503);
  assert.equal((await (await s.run({ method: 'GET', path: '/api/config' })).json()).ready, false);
  assert.equal(s.calls.length, 0);
});

for (const headers of [{ Origin: 'https://attacker.example' }, { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
  test(`rejects cross-origin issuance: ${JSON.stringify(headers)}`, async () => {
    const s = setup();
    assert.equal((await s.run({ headers })).status, 403);
    assert.equal(s.calls.length, 0);
  });
}

test('browser cannot obtain a token for an unlisted internal device', async () => {
  const s = setup();
  const response = await s.run({ body: { turnstileToken: 'valid-token', device_id: 'admin-device' } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'DEVICE_NOT_PUBLIC');
  assert.equal(s.calls.length, 0);
});

for (const body of [
  { turnstileToken: 't', device_id: 'test', signingKey: 'attacker-key' },
  { turnstileToken: 't', device_id: 'test', api_base: 'https://attacker.example' },
  { turnstileToken: 't' }, { device_id: 'test' },
  { turnstileToken: '', device_id: 'test' },
  { turnstileToken: 't', device_id: 'test|admin' },
  { turnstileToken: 't', device_id: 'test\nadmin' },
  { turnstileToken: 't', device_id: 'x'.repeat(129) },
  '{', '[]', JSON.stringify({ turnstileToken: 'x'.repeat(4100), device_id: 'test' }),
]) test(`rejects malformed or extra request fields (${JSON.stringify(body).slice(0, 75)})`, async () => {
  const s = setup();
  assert.equal((await s.run({ body })).status, 400);
  assert.equal(s.calls.length, 0);
});

for (const field of ['ipAllowed', 'siteAllowed']) test(`rate limit blocks issuing when ${field} is false`, async () => {
  const s = setup({ [field]: false });
  const response = await s.run();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(s.calls.length, 0);
});

test('rate service error does not bypass protection', async () => {
  const s = setup({ env: { IP_RATE_LIMITER: { async limit() { throw new Error('error'); } } } });
  assert.equal((await s.run()).status, 503);
  assert.equal(s.calls.length, 0);
});

test('does not trust X-Forwarded-For when Cloudflare edge IP is missing', async () => {
  const s = setup();
  assert.equal((await s.run({ headers: { 'CF-Connecting-IP': '', 'X-Forwarded-For': '192.0.2.8' } })).status, 503);
  assert.equal(s.calls.length, 0);
});

for (const verification of [
  { success: false, 'error-codes': ['timeout-or-duplicate'] },
  { success: true, hostname: 'attacker.example', action: 'token_apply' },
  { success: true, hostname: 'tokens.example.com', action: 'wrong_action' },
]) test(`failed/replayed/wrong-site captcha cannot reach signing API: ${JSON.stringify(verification)}`, async () => {
  const s = setup({ verification });
  assert.equal((await s.run()).status, 400);
  assert.equal(s.calls.length, 1);
});

test('Turnstile network failure does not reach auth API', async () => {
  const s = setup({ verificationError: true });
  assert.equal((await s.run()).status, 503);
  assert.equal(s.calls.length, 1);
});

for (const stage of ['verification', 'auth']) test(`${stage} redirects fail closed without accepting a token`, async () => {
  const s = setup({
    [`${stage}Response`]: () => new Response(JSON.stringify(stage === 'verification'
      ? { success: true, hostname: 'tokens.example.com', action: 'token_apply' }
      : { code: 0, data: { access_token: dummyAccessToken } }), {
      status: 302, headers: { Location: 'https://attacker.example/collect' },
    }),
  });
  const response = await s.run();
  assert.equal(response.status, stage === 'verification' ? 503 : 502);
  assert.equal(s.calls.length, stage === 'verification' ? 1 : 2);
  assert.ok(s.calls.every(call => call.init.redirect === 'manual'));
  assert.ok(!(await response.text()).includes(dummyAccessToken));
});

for (const options of [
  { authError: true },
  { auth: { code: 4001, message: secret } },
  { auth: { code: 4004, message: secret } },
  { auth: { data: { access_token: '' } } },
  { auth: { data: { access_token: 'injected\nvalue' } } },
  { authResponse: () => new Response('not json', { status: 500 }) },
  { authResponse: () => new Response('{') },
  { authResponse: () => new Response('x'.repeat(262145)) },
  { verificationResponse: () => new Response('x'.repeat(16385)) },
]) test(`upstream failures are sanitized (${Object.keys(options).join()})`, async () => {
  const s = setup(options);
  const response = await s.run();
  assert.ok(response.status >= 500);
  const result = await response.text();
  assert.ok(!result.includes(secret) && !result.includes(turnstileSecret) && !result.includes('internal secret'));
});

test('all responses including errors and static assets get no-cache and security headers', async () => {
  const s = setup();
  for (const changes of [{}, { method: 'GET', path: '/' }, { method: 'GET', path: '/.dev.vars' }, { method: 'GET', path: '/api/token' }]) {
    const response = await s.run(changes);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    assert.ok(response.headers.get('Content-Security-Policy').includes("frame-ancestors 'none'"));
  }
});

test('only static allowlisted paths are served and GET cannot issue', async () => {
  const s = setup();
  for (const path of ['/src/worker.mjs', '/wrangler.jsonc', '/device_request_signing_key', '/.env', '/README.md']) {
    assert.equal((await s.run({ method: 'GET', path })).status, 404);
  }
  assert.equal((await s.run({ method: 'GET', path: '/api/token' })).status, 405);
  assert.equal(s.calls.length, 0);
});
