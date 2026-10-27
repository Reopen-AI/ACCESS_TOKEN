const $ = id => document.getElementById(id);
let config;
let verificationToken = '';
let widgetId;
let busy = false;
let loadingVerification = false;

function refreshButton() { $('request-button').disabled = busy || !config?.ready || !verificationToken || !$('request-device-id').value.trim(); }
function status(message) { $('verify-status').textContent = message; }
function clearVerification(message) {
  verificationToken = '';
  if (message) status(message);
  refreshButton();
}
function feedback(message, error = false) {
  $('feedback').textContent = message;
  $('feedback').classList.toggle('error', error);
}
function clearResult() {
  $('access-token').value = '';
  $('access-token').type = 'password';
  $('device-id').value = '';
  $('toggle-token').textContent = '显示 Token';
  $('toggle-token').setAttribute('aria-pressed', 'false');
  $('copy-status').textContent = '';
  $('result').hidden = true;
}
function verificationError() {
  clearVerification('验证未能完成，请重新加载。');
  $('retry-verify').hidden = false;
}
async function loadVerification() {
  if (loadingVerification) return;
  loadingVerification = true;
  $('retry-verify').hidden = true;
  clearVerification('正在加载安全验证…');
  try {
    if (!window.turnstile) {
      document.querySelector('script[data-turnstile-loader]')?.remove();
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.dataset.turnstileLoader = '';
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        const timer = setTimeout(() => { script.remove(); reject(new Error('timeout')); }, 20000);
        script.onload = () => { clearTimeout(timer); resolve(); };
        script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('load failed')); };
        document.head.append(script);
      });
    }
    if (widgetId !== undefined) window.turnstile.remove(widgetId);
    $('turnstile-container').replaceChildren();
    widgetId = window.turnstile.render('#turnstile-container', {
      sitekey: config.site_key, action: config.action, theme: 'light',
      size: $('turnstile-container').parentElement.clientWidth - 8 < 300 ? 'compact' : 'flexible', language: 'zh',
      callback(token) {
        verificationToken = token;
        status('验证已完成，可以申请 Token。');
        $('retry-verify').hidden = true;
        refreshButton();
      },
      'expired-callback'() { clearVerification('验证已过期，请重新完成验证。'); },
      'error-callback'() { verificationError(); return true; },
      'timeout-callback'() { verificationError(); },
    });
    status('请完成上方安全验证。');
  } catch { verificationError(); }
  finally { loadingVerification = false; }
}
function resetVerification() {
  clearVerification('请重新完成验证后再申请。');
  if (!config?.preview && widgetId !== undefined && window.turnstile) {
    try { window.turnstile.reset(widgetId); } catch { verificationError(); }
  }
}

$('request-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !verificationToken || !config?.ready) return;
  busy = true;
  $('request-device-id').readOnly = true;
  refreshButton();
  $('request-label').textContent = '正在申请…';
  $('step-verify').className = 'done';
  $('step-issue').className = 'current';
  $('step-use').className = '';
  feedback('正在向翻译服务申请，请稍候。');
  // Clear an earlier token before issuing another so failures cannot show a stale result as new.
  clearResult();
  try {
    const response = await fetch('/api/token', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnstileToken: verificationToken, device_id: $('request-device-id').value.trim() }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || '申请失败，请稍后重试。');
    if (typeof data.access_token !== 'string' || typeof data.device_id !== 'string') throw new Error('返回的凭证不完整，请稍后重试。');
    $('device-id').value = data.device_id;
    $('access-token').value = data.access_token;
    $('expires-text').textContent = Number.isFinite(data.expires_in) && data.expires_in > 0
      ? `服务端返回的有效时长：${Math.ceil(data.expires_in / 60)} 分钟。`
      : '有效期由翻译服务决定；失效后可重新申请。';
    $('result').hidden = false;
    feedback('申请成功，请复制下方凭证。');
    $('step-issue').className = 'done';
    $('step-use').className = 'current';
    $('copy-device').focus({ preventScroll: true });
    $('result').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' });
  } catch (error) {
    feedback(error.name === 'TimeoutError' || error instanceof TypeError ? '网络连接中断或请求超时，请稍后再试。' : error.message, true);
    $('step-verify').className = 'current';
    $('step-issue').className = '';
  } finally {
    busy = false;
    $('request-device-id').readOnly = false;
    $('request-label').textContent = '申请 Token';
    resetVerification();
  }
});

async function copyField(id, label) {
  if (!$(id).value) return;
  try {
    await navigator.clipboard.writeText($(id).value);
    $('copy-status').textContent = `${label}已复制。请粘贴到听译设置。`;
  } catch { $('copy-status').textContent = '无法自动复制，请显示凭证后手动选择并复制。'; }
}
$('copy-device').addEventListener('click', () => copyField('device-id', '设备 ID'));
$('request-device-id').addEventListener('input', refreshButton);
$('copy-token').addEventListener('click', () => copyField('access-token', 'Token'));
$('toggle-token').addEventListener('click', () => {
  const show = $('access-token').type === 'password';
  $('access-token').type = show ? 'text' : 'password';
  $('toggle-token').textContent = show ? '隐藏 Token' : '显示 Token';
  $('toggle-token').setAttribute('aria-pressed', String(show));
});
$('clear-token').addEventListener('click', () => {
  clearResult();
  feedback('本页凭证已清除；系统剪贴板和已填入应用的凭证需另行清除。');
  $('step-verify').className = 'current';
  $('step-issue').className = '';
  $('step-use').className = '';
});
$('retry-verify').addEventListener('click', () => config?.ready ? loadVerification() : location.reload());
$('demo-verify').addEventListener('click', () => {
  verificationToken = 'local-preview-verification';
  status('模拟验证完成。点击下方按钮体验申请流程。');
  refreshButton();
});
window.addEventListener('pagehide', clearResult);

try {
  const response = await fetch('/api/config', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error();
  config = await response.json();
  if (typeof config.default_device_id === 'string') $('request-device-id').value = config.default_device_id;
  if (!config.ready) status('申请服务暂未开放，请稍后再来。');
  else if (config.preview) {
    $('preview-banner').hidden = false;
    $('demo-verify').hidden = false;
    status('离线预览：不会连接真实翻译服务。');
  } else await loadVerification();
} catch {
  status('暂时无法连接申请服务，请检查网络后重试。');
  $('retry-verify').hidden = false;
}
