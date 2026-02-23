// login.ts — Login window renderer logic
/// <reference path="renderer.d.ts" />

const DAEMON_URL = 'http://127.0.0.1:7777';

let phoneCodeHash: string | null = null;
let phoneNumber: string | null = null;
let loginPollTimer: ReturnType<typeof setInterval> | null = null;

// ── Elements ──
const phoneInput = document.getElementById('phone-input') as HTMLInputElement;
const codeInput = document.getElementById('code-input') as HTMLInputElement;
const passwordInput = document.getElementById('password-input') as HTMLInputElement;
const sendCodeBtn = document.getElementById('send-code-btn') as HTMLButtonElement;
const verifyCodeBtn = document.getElementById('verify-code-btn') as HTMLButtonElement;
const verify2faBtn = document.getElementById('verify-2fa-btn') as HTMLButtonElement;
const phoneError = document.getElementById('phone-error')!;
const codeError = document.getElementById('code-error')!;
const twoFaError = document.getElementById('2fa-error')!;
const phoneStatus = document.getElementById('phone-status')!;
const qrError = document.getElementById('qr-error')!;
const qrDisplay = document.getElementById('qr-display');
const qrLoading = document.getElementById('qr-loading')!;
const closeBtn = document.getElementById('close-btn')!;

// ── Tabs ──
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');

    const which = (tab as HTMLElement).dataset.tab;
    document.getElementById('phone-section')!.style.display = which === 'phone' ? '' : 'none';
    document.getElementById('qr-section')!.style.display = which === 'qr' ? '' : 'none';

    if (which === 'qr') {
      loadQR();
    }
  });
});

// ── Steps ──
function showStep(stepId: string): void {
  document.querySelectorAll('.step').forEach((s) => s.classList.remove('active'));
  document.getElementById(stepId)!.classList.add('active');
}

function showError(el: HTMLElement, msg: string): void {
  el.textContent = msg;
  el.classList.add('visible');
}
function hideError(el: HTMLElement): void {
  el.classList.remove('visible');
}

// ── HTTP ──
interface ApiResponse {
  ok?: boolean;
  phoneCodeHash?: string;
  need2FA?: boolean;
  hint?: string;
  error?: string;
  connected?: boolean;
  id?: string;
  [key: string]: unknown;
}

async function api(method: string, urlPath: string, body?: Record<string, unknown>): Promise<ApiResponse> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(DAEMON_URL + urlPath, opts);
  const data = await res.json() as ApiResponse;
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Phone Login ──
sendCodeBtn.addEventListener('click', async () => {
  hideError(phoneError);
  const phone = phoneInput.value.trim();
  if (!phone) { showError(phoneError, 'Enter your phone number'); return; }

  sendCodeBtn.disabled = true;
  sendCodeBtn.textContent = 'Sending...';

  try {
    const result = await api('POST', '/login/phone', { phone });
    phoneNumber = phone;
    phoneCodeHash = result.phoneCodeHash || null;
    showStep('step-code');
    codeInput.focus();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showError(phoneError, message);
  } finally {
    sendCodeBtn.disabled = false;
    sendCodeBtn.textContent = 'Send Code';
  }
});

verifyCodeBtn.addEventListener('click', async () => {
  hideError(codeError);
  const code = codeInput.value.trim();
  if (!code) { showError(codeError, 'Enter the verification code'); return; }

  verifyCodeBtn.disabled = true;
  verifyCodeBtn.textContent = 'Verifying...';

  try {
    const result = await api('POST', '/login/code', {
      phone: phoneNumber,
      code,
      phoneCodeHash,
    });

    if (result.need2FA) {
      showStep('step-2fa');
      if (result.hint) {
        const hintEl = document.getElementById('2fa-hint');
        if (hintEl) {
          hintEl.textContent = `Hint: ${result.hint}`;
          hintEl.style.display = 'block';
        }
      }
      passwordInput.focus();
    } else if (result.ok) {
      onLoginSuccess();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showError(codeError, message);
  } finally {
    verifyCodeBtn.disabled = false;
    verifyCodeBtn.textContent = 'Verify';
  }
});

verify2faBtn.addEventListener('click', async () => {
  hideError(twoFaError);
  const password = passwordInput.value;
  if (!password) { showError(twoFaError, 'Enter your 2FA password'); return; }

  verify2faBtn.disabled = true;
  verify2faBtn.textContent = 'Verifying...';

  try {
    await api('POST', '/login/2fa', { password });
    onLoginSuccess();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showError(twoFaError, message);
  } finally {
    verify2faBtn.disabled = false;
    verify2faBtn.textContent = 'Submit';
  }
});

// Enter key handlers
phoneInput.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') sendCodeBtn.click(); });
codeInput.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') verifyCodeBtn.click(); });
passwordInput.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') verify2faBtn.click(); });

// ── QR Login ──
// The daemon doesn't currently expose a /login/qr endpoint.
// Show the daemon's web-based login page as a fallback.
async function loadQR(): Promise<void> {
  if (qrDisplay) qrDisplay.style.display = 'none';
  qrLoading.style.display = '';
  hideError(qrError);

  try {
    // Check if daemon is connected (already logged in)
    const res = await fetch(DAEMON_URL + '/health');
    const health = await res.json() as ApiResponse;

    if (health.connected) {
      onLoginSuccess();
      return;
    }

    qrLoading.style.display = 'none';

    // No /login/qr endpoint — show helpful fallback
    if (qrDisplay) {
      qrDisplay.style.display = '';
      qrDisplay.innerHTML = `
        <div style="text-align: center; padding: 8px;">
          <p style="color: #888; font-size: 13px; margin-bottom: 12px;">
            QR login is not yet available.
          </p>
          <p style="color: #666; font-size: 12px;">
            Use the <strong style="color: #c084fc;">Phone</strong> tab to sign in,<br>
            or visit the daemon web UI:
          </p>
          <div class="qr-fallback">
            <a href="#" onclick="return false;" style="color: #c084fc; text-decoration: none;">
              http://127.0.0.1:7777/login
            </a>
          </div>
        </div>
      `;
    }
  } catch (err) {
    qrLoading.style.display = 'none';
    const message = err instanceof Error ? err.message : String(err);
    showError(qrError, 'Cannot reach daemon: ' + message);
  }
}

// ── Poll for login success ──
// After a successful login (via phone flow, 2FA, or external browser),
// the daemon's /me endpoint will start responding.
function startLoginPoll(): void {
  if (loginPollTimer) return;
  loginPollTimer = setInterval(async () => {
    try {
      const res = await fetch(DAEMON_URL + '/me');
      if (res.ok) {
        const me = await res.json() as ApiResponse;
        if (me && me.id) {
          onLoginSuccess();
        }
      }
    } catch {
      // daemon not ready yet
    }
  }, 2000);
}

// Start polling immediately — handles case where user logs in via daemon web UI
startLoginPoll();

// ── Success ──
function onLoginSuccess(): void {
  // Stop polling
  if (loginPollTimer) {
    clearInterval(loginPollTimer);
    loginPollTimer = null;
  }

  // Notify main process via the preload bridge
  if (window.oceangram && window.oceangram.loginSuccess) {
    window.oceangram.loginSuccess();
  } else {
    // Fallback: show success and close
    const content = document.querySelector('.content');
    if (content) {
      content.innerHTML =
        '<div class="success-view"><div class="logo">✅</div><p>Login successful!</p><p class="subtitle">Starting Oceangram...</p></div>';
    }
    setTimeout(() => window.close(), 1500);
  }
}

// ── Close ──
closeBtn.addEventListener('click', () => {
  if (window.oceangram && window.oceangram.closeLogin) {
    window.oceangram.closeLogin();
  } else {
    window.close();
  }
});
