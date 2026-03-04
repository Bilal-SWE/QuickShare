import { createClient } from '@supabase/supabase-js';
import QRCode from 'qrcode';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

// ──────────────────────────────────────────────
// Config Validation
// ──────────────────────────────────────────────
const isConfigured = SUPABASE_URL !== 'YOUR_SUPABASE_URL' && SUPABASE_ANON_KEY !== 'YOUR_SUPABASE_ANON_KEY';

// ──────────────────────────────────────────────
// Supabase Init
// ──────────────────────────────────────────────
let supabase = null;

if (isConfigured) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (e) {
    console.error('Supabase init failed:', e);
  }
}

// ──────────────────────────────────────────────
// State
// ──────────────────────────────────────────────
let currentSessionCode = null;
let realtimeChannel = null;
let qrScanner = null;
let timerInterval = null;
let selectedFile = null;
let connectedCode = null;
const SESSION_TTL = 10 * 60; // 10 minutes in seconds

// ──────────────────────────────────────────────
// DOM
// ──────────────────────────────────────────────
const screens = {
  home: document.getElementById('screen-home'),
  receive: document.getElementById('screen-receive'),
  send: document.getElementById('screen-send'),
};
const $ = id => document.getElementById(id);

// ──────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function showToast(msg, duration = 3500) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

function showReceiveError(msg) {
  $('receive-loading').innerHTML = `
    <div class="error-state">
      <div class="error-icon">
        <svg viewBox="0 0 24 24" fill="none" style="width:32px;height:32px">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
          <line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>
      <p class="error-title">${msg}</p>
    </div>`;
}

function showConfigPrompt() {
  $('receive-loading').innerHTML = `
    <div class="config-prompt">
      <div class="config-icon">🔧</div>
      <h3>إعداد Supabase مطلوب</h3>
      <p>أضف بياناتك في الملف:</p>
      <code>src/supabase-config.js</code>
      <ol class="setup-steps">
        <li>اذهب إلى <a href="https://supabase.com" target="_blank">supabase.com</a> وأنشئ مشروعاً</li>
        <li>من <strong>Project Settings → API</strong> انسخ الـ URL والـ anon key</li>
        <li>الصقهما في <code>src/supabase-config.js</code></li>
      </ol>
    </div>`;
}

function navigateTo(screenId) {
  Object.values(screens).forEach(s => s.classList.remove('active', 'slide-out'));
  screens[screenId].classList.add('active');
}

// ──────────────────────────────────────────────
// Timer
// ──────────────────────────────────────────────
function startTimer(seconds, onExpire) {
  let remaining = seconds;
  clearInterval(timerInterval);

  timerInterval = setInterval(() => {
    remaining--;
    const circle = $('timer-circle');
    const textEl = $('timer-text');
    const pct = (remaining / seconds) * 100;
    if (circle) circle.setAttribute('stroke-dasharray', `${pct} 100`);
    const m = Math.floor(remaining / 60).toString().padStart(2, '0');
    const s = (remaining % 60).toString().padStart(2, '0');
    if (textEl) textEl.textContent = `${m}:${s}`;
    if (remaining <= 0) { clearInterval(timerInterval); onExpire(); }
  }, 1000);
}

function stopTimer() { clearInterval(timerInterval); }

// ──────────────────────────────────────────────
// RECEIVE FLOW
// ──────────────────────────────────────────────
async function startReceiveSession() {
  // Reset UI
  $('receive-loading').innerHTML = `
    <div class="spinner"></div>
    <span>جاري إعداد جلسة الاستقبال…</span>`;
  $('receive-loading').classList.remove('hidden');
  $('receive-ready').classList.add('hidden');
  $('receive-done').classList.add('hidden');

  if (!isConfigured || !supabase) { showConfigPrompt(); return; }

  try {
    // Clean up previous session
    if (currentSessionCode) {
      await supabase.from('sessions').delete().eq('code', currentSessionCode);
    }
    if (realtimeChannel) {
      supabase.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }

    const code = generateCode();
    currentSessionCode = code;

    // Display digits
    code.split('').forEach((ch, i) => {
      const el = $(`d${i}`);
      if (el) el.textContent = ch;
    });

    // Create session in Supabase
    const expiresAt = new Date(Date.now() + SESSION_TTL * 1000).toISOString();
    const { error: insertError } = await supabase.from('sessions').insert({
      code,
      status: 'waiting',
      expires_at: expiresAt,
    });

    if (insertError) throw insertError;

    // Generate QR Code
    const qrData = `${window.location.origin}${window.location.pathname}?code=${code}`;
    await QRCode.toCanvas($('qr-canvas'), qrData, {
      width: 200,
      margin: 1,
      color: { dark: '#0d0f1a', light: '#ffffff' },
      errorCorrectionLevel: 'H',
    });

    $('receive-loading').classList.add('hidden');
    $('receive-ready').classList.remove('hidden');

    // Start timer
    startTimer(SESSION_TTL, () => {
      showToast('انتهت صلاحية الجلسة');
      supabase.from('sessions').delete().eq('code', code);
      startReceiveSession();
    });

    // Listen for session changes via Realtime
    realtimeChannel = supabase
      .channel(`session-${code}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'sessions',
        filter: `code=eq.${code}`,
      }, (payload) => {
        const data = payload.new;

        // ── Sender connected ──
        if (data.status === 'connected') {
          const statusText = $('receive-status-text');
          if (statusText) {
            statusText.textContent = '✅ تم الاتصال! في انتظار الملف أو الرابط…';
            statusText.style.color = 'var(--c-green)';
          }
          const dot = document.querySelector('.pulse-dot');
          if (dot) dot.classList.add('green');
          showToast('✅ اتصل بك المُرسِل!');
        }

        // ── File/Link transferred ──
        if (data.status === 'transferred') {
          stopTimer();
          supabase.removeChannel(realtimeChannel);
          realtimeChannel = null;

          $('receive-ready').classList.add('hidden');
          $('receive-done').classList.remove('hidden');

          const content = $('received-content');
          if (data.type === 'link') {
            content.innerHTML = `
              <div class="received-link-wrap">
                <svg style="flex-shrink:0;width:20px;height:20px;color:var(--c-teal)" viewBox="0 0 24 24" fill="none">
                  <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <a href="${data.url}" target="_blank" rel="noopener">${data.url}</a>
              </div>`;
          } else if (data.type === 'file') {
            content.innerHTML = `
              <div class="received-file-wrap">
                <p class="received-file-name">📁 ${data.file_name}</p>
                <a class="btn-download" href="${data.download_url}" target="_blank" download="${data.file_name}">
                  <svg viewBox="0 0 24 24" fill="none" style="width:18px;height:18px">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <polyline points="7 10 12 15 17 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <line x1="12" y1="3" x2="12" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                  </svg>
                  تحميل الملف
                </a>
              </div>`;
          }

          // Clean up after 2 min
          setTimeout(() => supabase.from('sessions').delete().eq('code', code), 120000);
        }
      })
      .subscribe();

  } catch (err) {
    console.error('Receive error:', err);
    showReceiveError('تعذر الاتصال. تحقق من إعدادات Supabase.');
  }
}

// ──────────────────────────────────────────────
// SEND FLOW – Connect
// ──────────────────────────────────────────────
async function connectToSession(code) {
  code = code.trim();
  if (!/^\d{6}$/.test(code)) {
    showCodeError('يرجى إدخال رمز مكون من 6 أرقام');
    return false;
  }

  if (!isConfigured || !supabase) {
    showCodeError('Supabase غير مُعدَّل بعد');
    return false;
  }

  hideCodeError();
  $('connect-btn').disabled = true;
  $('connect-btn').textContent = 'جاري الاتصال…';

  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('code', code)
      .single();

    if (error || !data) {
      showCodeError('رمز غير صحيح أو غير موجود');
      resetConnectBtn();
      return false;
    }

    if (data.status !== 'waiting') {
      showCodeError('هذا الرمز مستخدم بالفعل');
      resetConnectBtn();
      return false;
    }

    if (new Date() > new Date(data.expires_at)) {
      showCodeError('انتهت صلاحية الرمز، اطلب رمزاً جديداً');
      resetConnectBtn();
      return false;
    }

    // Mark session as connected so receiver knows
    await supabase.from('sessions').update({ status: 'connected' }).eq('code', code);

    connectedCode = code;
    resetConnectBtn();
    return true;

  } catch (err) {
    console.error('Connect error:', err);
    showCodeError('تعذر الاتصال. تحقق من اتصالك بالإنترنت.');
    resetConnectBtn();
    return false;
  }
}

function resetConnectBtn() {
  $('connect-btn').disabled = false;
  $('connect-btn').textContent = 'اتصال';
}

function showCodeError(msg) {
  const el = $('code-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideCodeError() {
  $('code-error').classList.add('hidden');
}

// ──────────────────────────────────────────────
// SEND FLOW – Upload & Transfer
// ──────────────────────────────────────────────
async function sendContent() {
  const isFile = $('ctab-file').classList.contains('active');

  if (!connectedCode) { showToast('لم يتم الاتصال بعد'); return; }
  if (!isConfigured || !supabase) { showToast('Supabase غير مُعدَّل'); return; }

  if (isFile) {
    if (!selectedFile) { showToast('يرجى اختيار ملف'); return; }
    await uploadFile(selectedFile);
  } else {
    const url = $('link-input').value.trim();
    if (!url) { showToast('يرجى إدخال رابط'); return; }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      showToast('يرجى إدخال رابط صحيح يبدأ بـ https://');
      return;
    }
    await sendLink(url);
  }
}

async function uploadFile(file) {
  const MAX = 40 * 1024 * 1024;
  if (file.size > MAX) { showToast('حجم الملف يتجاوز 40 ميغابايت'); return; }

  $('upload-progress').classList.remove('hidden');
  $('send-now-btn').disabled = true;

  // Animate progress bar while uploading
  let fakeProgress = 0;
  const fakeTimer = setInterval(() => {
    // Slowly fill to 90% while waiting for real upload
    if (fakeProgress < 90) {
      fakeProgress += Math.random() * 8;
      if (fakeProgress > 90) fakeProgress = 90;
      $('progress-bar').style.width = `${fakeProgress.toFixed(0)}%`;
      $('progress-text').textContent = `${fakeProgress.toFixed(0)}%`;
    }
  }, 300);

  try {
    const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = `${connectedCode}/${Date.now()}_${safeFileName}`;

    // Upload via Supabase SDK (handles new key format correctly)
    const { error: uploadError } = await supabase.storage
      .from('transfers')
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: true,
        contentType: file.type || 'application/octet-stream',
      });

    clearInterval(fakeTimer);

    if (uploadError) throw uploadError;

    // Complete progress bar
    $('progress-bar').style.width = '100%';
    $('progress-text').textContent = '100%';

    // Get permanent public URL
    const { data: urlData } = supabase.storage
      .from('transfers')
      .getPublicUrl(filePath);

    const downloadUrl = urlData.publicUrl;

    // Update session → triggers receiver Realtime
    const { error: updateError } = await supabase.from('sessions').update({
      status: 'transferred',
      type: 'file',
      file_name: file.name,
      file_size: file.size,
      download_url: downloadUrl,
    }).eq('code', connectedCode);

    if (updateError) throw updateError;

    setTimeout(showSendDone, 400);

  } catch (err) {
    clearInterval(fakeTimer);
    console.error('Upload error:', err);
    showToast(`خطأ في الرفع: ${err.message}`);
    $('upload-progress').classList.add('hidden');
    $('progress-bar').style.width = '0%';
    $('send-now-btn').disabled = false;
  }
}

async function sendLink(url) {
  $('send-now-btn').disabled = true;
  try {
    const { error } = await supabase.from('sessions').update({
      status: 'transferred',
      type: 'link',
      url,
    }).eq('code', connectedCode);

    if (error) throw error;
    showSendDone();
  } catch (err) {
    console.error('Send link error:', err);
    showToast('تعذر إرسال الرابط. تحقق من اتصالك.');
    $('send-now-btn').disabled = false;
  }
}

function showSendDone() {
  $('send-content').classList.add('hidden');
  $('send-done').classList.remove('hidden');
}

// ──────────────────────────────────────────────
// Code Inputs
// ──────────────────────────────────────────────
function getEnteredCode() {
  return [0, 1, 2, 3, 4, 5].map(i => $(`ci${i}`).value).join('');
}

function clearCodeInputs() {
  [0, 1, 2, 3, 4, 5].forEach(i => { $(`ci${i}`).value = ''; });
  $('ci0').focus();
}

// ──────────────────────────────────────────────
// Reset
// ──────────────────────────────────────────────
function resetSendScreen() {
  connectedCode = null;
  selectedFile = null;
  $('send-connect').classList.remove('hidden');
  $('send-content').classList.add('hidden');
  $('send-done').classList.add('hidden');
  $('upload-progress').classList.add('hidden');
  $('progress-bar').style.width = '0%';
  $('file-preview').classList.add('hidden');
  $('drop-zone').classList.remove('hidden');
  $('link-input').value = '';
  clearCodeInputs();
  hideCodeError();
  $('ctab-file').classList.add('active');
  $('ctab-link').classList.remove('active');
  $('file-panel').classList.add('active');
  $('link-panel').classList.remove('active');
}

// ──────────────────────────────────────────────
// Event Listeners
// ──────────────────────────────────────────────
$('btn-receive').addEventListener('click', () => {
  navigateTo('receive');
  startReceiveSession();
});

$('btn-send').addEventListener('click', () => {
  navigateTo('send');
  setTimeout(() => $('ci0').focus(), 400);
});

$('back-from-receive').addEventListener('click', async () => {
  stopTimer();
  if (realtimeChannel) { supabase.removeChannel(realtimeChannel); realtimeChannel = null; }
  if (currentSessionCode && supabase) {
    await supabase.from('sessions').delete().eq('code', currentSessionCode).catch(() => { });
    currentSessionCode = null;
  }
  navigateTo('home');
});

$('back-from-send').addEventListener('click', () => {
  resetSendScreen();
  navigateTo('home');
});

$('copy-code-btn').addEventListener('click', () => {
  if (currentSessionCode) {
    navigator.clipboard.writeText(currentSessionCode)
      .then(() => showToast('تم نسخ الرمز ✓'))
      .catch(() => showToast('تعذر النسخ'));
  }
});

$('receive-again-btn').addEventListener('click', () => startReceiveSession());
$('send-again-btn').addEventListener('click', () => {
  resetSendScreen();
  setTimeout(() => $('ci0').focus(), 100);
});

// Code char inputs
const charInputs = [0, 1, 2, 3, 4, 5].map(i => $(`ci${i}`));
charInputs.forEach((input, idx) => {
  input.addEventListener('input', () => {
    const v = input.value.replace(/\D/g, '');
    input.value = v.slice(-1);
    if (v && idx < 5) charInputs[idx + 1].focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !input.value && idx > 0) charInputs[idx - 1].focus();
  });
  input.addEventListener('paste', (e) => {
    e.preventDefault();
    const pasted = (e.clipboardData || window.clipboardData)
      .getData('text').replace(/\D/g, '').slice(0, 6);
    pasted.split('').forEach((ch, i) => { if (charInputs[i]) charInputs[i].value = ch; });
    const nextEmpty = charInputs.find(c => !c.value);
    if (nextEmpty) nextEmpty.focus();
  });
});

$('connect-btn').addEventListener('click', async () => {
  const code = getEnteredCode();
  const ok = await connectToSession(code);
  if (ok) {
    $('send-connect').classList.add('hidden');
    $('send-content').classList.remove('hidden');
  }
});

$('ctab-file').addEventListener('click', () => {
  $('ctab-file').classList.add('active'); $('ctab-link').classList.remove('active');
  $('file-panel').classList.add('active'); $('link-panel').classList.remove('active');
});
$('ctab-link').addEventListener('click', () => {
  $('ctab-link').classList.add('active'); $('ctab-file').classList.remove('active');
  $('link-panel').classList.add('active'); $('file-panel').classList.remove('active');
});

// File drop zone
$('browse-btn').addEventListener('click', () => $('file-input').click());
const dropZone = $('drop-zone');
dropZone.addEventListener('click', () => $('file-input').click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFileSelect(file);
});
$('file-input').addEventListener('change', (e) => {
  if (e.target.files[0]) handleFileSelect(e.target.files[0]);
});

function handleFileSelect(file) {
  if (file.size > 40 * 1024 * 1024) { showToast('الملف يتجاوز الحد الأقصى (40 ميغابايت)'); return; }
  selectedFile = file;
  $('file-name').textContent = file.name;
  $('file-size').textContent = formatBytes(file.size);
  $('file-preview').classList.remove('hidden');
  dropZone.classList.add('hidden');
}

$('remove-file').addEventListener('click', () => {
  selectedFile = null; $('file-input').value = '';
  $('file-preview').classList.add('hidden'); dropZone.classList.remove('hidden');
});

$('send-now-btn').addEventListener('click', sendContent);

const urlParams = new URLSearchParams(window.location.search);
const autoCode = urlParams.get('code');
if (autoCode && /^\d{6}$/.test(autoCode)) {
  setTimeout(async () => {
    navigateTo('send');
    autoCode.split('').forEach((ch, i) => { if (charInputs[i]) charInputs[i].value = ch; });
    const ok = await connectToSession(autoCode);
    if (ok) {
      $('send-connect').classList.add('hidden');
      $('send-content').classList.remove('hidden');
    } else {
      showToast('الرمز غير صالح أو منتهي الصلاحية');
    }
    window.history.replaceState({}, '', window.location.pathname);
  }, 500);
}
