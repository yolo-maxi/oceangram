export function getLoginHtml(): string {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Oceangram — Login</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #0e1621; color: #f5f5f5;
  height: 100vh; display: flex; align-items: center; justify-content: center;
}
.card {
  background: #17212b; border-radius: 16px; padding: 40px; width: 400px; text-align: center;
}
.logo { font-size: 48px; margin-bottom: 16px; }
h1 { font-size: 22px; margin-bottom: 8px; }
.sub { color: #6d7f8f; font-size: 14px; margin-bottom: 24px; }
input {
  width: 100%; padding: 14px 16px; background: #242f3d; border: 2px solid transparent;
  border-radius: 12px; color: #f5f5f5; font-size: 18px; text-align: center;
  letter-spacing: 2px; outline: none;
}
input:focus { border-color: #6ab2f2; }
input::placeholder { color: #5a6e7e; letter-spacing: 0; font-size: 14px; }
button {
  width: 100%; padding: 14px; margin-top: 16px; background: #6ab2f2; color: #0e1621;
  border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer;
}
button:hover { background: #7dc0f7; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.error { color: #ff6b6b; font-size: 13px; margin-top: 8px; }
.success { color: #51cf66; font-size: 15px; margin-top: 16px; }
.hidden { display: none; }
</style>
</head><body>
<div class="card">
  <div class="logo">🦞</div>
  <h1 id="title">Log in to Telegram</h1>
  <p class="sub" id="subtitle">Enter your phone number with country code</p>

  <div id="step-phone">
    <input id="phone" type="tel" placeholder="+1 234 567 8900" autofocus />
    <button onclick="sendPhone()">Send Code</button>
  </div>

  <div id="step-code" class="hidden">
    <input id="code" type="text" placeholder="Enter code" />
    <button onclick="sendCode()">Verify</button>
  </div>

  <div id="step-2fa" class="hidden">
    <input id="password" type="password" placeholder="2FA password" />
    <button onclick="send2FA()">Submit</button>
  </div>

  <div id="step-done" class="hidden">
    <p class="success">✅ Logged in! You can close this page.</p>
  </div>

  <p id="error" class="error hidden"></p>
</div>

<script>
let phoneNumber = '';
let phoneCodeHash = '';

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg; el.classList.remove('hidden');
}
function hideError() { document.getElementById('error').classList.add('hidden'); }
function showStep(name) {
  for (const s of ['phone','code','2fa','done']) {
    document.getElementById('step-'+s).classList.toggle('hidden', s !== name);
  }
}

async function sendPhone() {
  hideError();
  phoneNumber = document.getElementById('phone').value.trim();
  if (!phoneNumber) return showError('Enter phone number');
  try {
    const res = await fetch('/login/phone', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ phone: phoneNumber })
    });
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Failed');
    phoneCodeHash = data.phoneCodeHash;
    document.getElementById('title').textContent = 'Enter verification code';
    document.getElementById('subtitle').textContent = 'Check your Telegram app';
    showStep('code');
  } catch (e) { showError(e.message); }
}

async function sendCode() {
  hideError();
  const code = document.getElementById('code').value.trim();
  if (!code) return showError('Enter code');
  try {
    const res = await fetch('/login/code', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ phone: phoneNumber, code, phoneCodeHash })
    });
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Failed');
    if (data.need2FA) {
      document.getElementById('title').textContent = '2FA Password';
      document.getElementById('subtitle').textContent = 'Enter your two-factor authentication password';
      showStep('2fa');
      return;
    }
    showStep('done');
  } catch (e) { showError(e.message); }
}

async function send2FA() {
  hideError();
  const password = document.getElementById('password').value;
  if (!password) return showError('Enter password');
  try {
    const res = await fetch('/login/2fa', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Failed');
    showStep('done');
  } catch (e) { showError(e.message); }
}

document.querySelectorAll('input').forEach(el => {
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter') el.parentElement.querySelector('button')?.click();
  });
});
</script>
</body></html>`;
}
