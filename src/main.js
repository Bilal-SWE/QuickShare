import { createClient } from '@supabase/supabase-js';
import QRCode from 'qrcode';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

// ──────────────────────────────────────────────
// Config & Client
// ──────────────────────────────────────────────
const isConfigured = SUPABASE_URL !== 'YOUR_SUPABASE_URL' && SUPABASE_ANON_KEY !== 'YOUR_SUPABASE_ANON_KEY';
let supabase = null;
if (isConfigured) {
  try { supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY); }
  catch (e) { console.error('Supabase init failed:', e); }
}

// ──────────────────────────────────────────────
// State
// ──────────────────────────────────────────────
let currentSessionCode = null;
let realtimeChannel = null;
let timerInterval = null;
let selectedFiles = [];
let connectedCode = null;
const SESSION_TTL = 10 * 60;

// ──────────────────────────────────────────────
// DOM Utilities
// ──────────────────────────────────────────────
const $ = id => document.getElementById(id);
const screens = { home: $('screen-home'), receive: $('screen-receive'), send: $('screen-send') };

function navigateTo(screenId) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[screenId].classList.add('active');
}

function showToast(msg, duration = 3000) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

// ──────────────────────────────────────────────
// Timer Logic
// ──────────────────────────────────────────────
function initSessionTimer(seconds) {
  let remaining = seconds;
  clearInterval(timerInterval);

  const updateUI = () => {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    $('timer-text').textContent = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    $('timer-display-text').textContent = `${m} دقائق`;
  };

  updateUI();
  timerInterval = setInterval(() => {
    remaining--;
    updateUI();
    if (remaining <= 0) { clearInterval(timerInterval); startRenewGracePeriod(); }
  }, 1000);
}

function startRenewGracePeriod() {
  $('renew-timer-panel').classList.remove('hidden');
  let countdown = 30;
  const graceInterval = setInterval(() => {
    countdown--;
    if (countdown <= 0) { clearInterval(graceInterval); disconnectSession(); }
  }, 1000);

  $('renew-time-btn').onclick = () => {
    clearInterval(graceInterval);
    $('renew-timer-panel').classList.add('hidden');
    initSessionTimer(SESSION_TTL);
    showToast('تم تجديد الوقت');
  };
}

async function disconnectSession() {
  // Immediate UI feedback
  navigateTo('home');
  clearInterval(timerInterval);

  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }

  if (currentSessionCode && supabase) {
    const codeToClean = currentSessionCode;
    currentSessionCode = null;
    try {
      await supabase.from('sessions').delete().eq('code', codeToClean);
    } catch (e) {
      console.warn('Cleanup failed:', e);
    }
  }
}

// ──────────────────────────────────────────────
// RECEIVE FLOW
// ──────────────────────────────────────────────
async function startReceiveSession() {
  $('receive-loading').classList.remove('hidden');
  $('receive-ready').classList.add('hidden');
  $('receive-done').classList.add('hidden');
  $('receive-header').classList.remove('hidden');

  if (!isConfigured || !supabase) { showToast('Supabase غير معد'); return; }

  try {
    const code = Math.floor(10000 + Math.random() * 90000).toString();
    currentSessionCode = code;
    code.split('').forEach((ch, i) => { if ($(`d${i}`)) $(`d${i}`).textContent = ch; });

    const { error: insErr } = await supabase.from('sessions').insert({
      code, status: 'waiting', expires_at: new Date(Date.now() + SESSION_TTL * 1000).toISOString()
    });
    if (insErr) throw insErr;

    const qrData = `${window.location.origin}${window.location.pathname}?code=${code}`;
    await QRCode.toCanvas($('qr-canvas'), qrData, { width: 180, margin: 1, color: { dark: '#000000', light: '#ffffff' } });

    $('receive-loading').classList.add('hidden');
    $('receive-ready').classList.remove('hidden');
    initSessionTimer(SESSION_TTL);

    realtimeChannel = supabase.channel(`session-${code}`).on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'sessions', filter: `code=eq.${code}`,
    }, (payload) => {
      const data = payload.new;
      if (data.status === 'connected') {
        $('connected-sender-info').classList.remove('hidden');
        showToast('متصل الآن');
      }
      if (data.status === 'transferred') {
        $('receive-header').classList.add('hidden');
        $('receive-ready').classList.add('hidden');
        $('receive-done').classList.remove('hidden');
        renderReceivedContent(data);
      }
    }).subscribe();

  } catch (err) {
    console.error(err);
    showToast('خطأ في الاتصال');
    navigateTo('home');
  }
}

function renderReceivedContent(data) {
  const content = $('received-content');
  let html = '';
  if (data.type === 'link') {
    const urlRegex = /((https?:\/\/)|(www\.))?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi;
    const matches = data.url.match(urlRegex);
    let openUrl = matches ? matches[0] : null;
    if (openUrl && !openUrl.startsWith('http')) openUrl = 'https://' + openUrl;

    html = `<div class="received-link-wrap">
      <div style="word-break:break-all;">${data.url}</div>
      <div class="action-buttons">
        <button class="btn-primary" onclick="navigator.clipboard.writeText('${data.url}').then(() => alert('تم النسخ'))">نسخ النص</button>
        ${openUrl ? `<a href="${openUrl}" target="_blank" class="btn-outline">فتح</a>` : ''}
      </div>
    </div>`;
  } else {
    html = `<div class="received-file-wrap">
      <div>📁 ${data.file_name} (${formatBytes(data.file_size)})</div>
      <div class="action-buttons">
        <a href="${data.download_url}" target="_blank" class="btn-outline">استعراض</a>
        <a href="${data.download_url}" download="${data.file_name}" class="btn-primary">تحميل</a>
      </div>
    </div>`;
  }
  content.innerHTML = html;
}

// ──────────────────────────────────────────────
// SEND FLOW
// ──────────────────────────────────────────────
async function connectToSession(code) {
  if (!/^\d{5}$/.test(code)) return showToast('الرمز مكون من 5 أرقام');
  $('connect-btn').disabled = true;
  $('connect-btn').textContent = 'جارِ الاتصال...';

  const { data, error } = await supabase.from('sessions').select('*').eq('code', code).single();
  if (error || !data) {
    showToast('الرمز غير صحيح');
    [0, 1, 2, 3, 4].forEach(i => { $(`ci${i}`).value = ''; });
    $(`ci0`).focus();
    resetConnectBtn();
    return false;
  }

  await supabase.from('sessions').update({ status: 'connected' }).eq('code', code);
  connectedCode = code;
  resetConnectBtn();
  return true;
}

function resetConnectBtn() { $('connect-btn').disabled = false; $('connect-btn').textContent = 'اتصال بالجهاز'; }

async function sendContent() {
  const isFile = $('ctab-file').classList.contains('active');
  if (isFile) {
    if (selectedFiles.length === 0) return showToast('اختر ملفاً أولاً');
    $('upload-progress').classList.remove('hidden');
    $('send-now-btn').disabled = true;
    try {
      for (const file of selectedFiles) {
        const path = `${connectedCode}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
        await supabase.storage.from('transfers').upload(path, file);
        const { data: urlData } = supabase.storage.from('transfers').getPublicUrl(path);
        await supabase.from('sessions').update({
          status: 'transferred', type: 'file', file_name: file.name, file_size: file.size, download_url: urlData.publicUrl
        }).eq('code', connectedCode);
      }
      showSendDone();
    } catch (e) { showToast('فشل الرفع'); $('send-now-btn').disabled = false; }
  } else {
    const text = $('link-input').value.trim();
    if (!text) return showToast('أدخل نصاً أولاً');
    await supabase.from('sessions').update({ status: 'transferred', type: 'link', url: text }).eq('code', connectedCode);
    showSendDone();
  }
}

function showSendDone() {
  $('send-header').classList.add('hidden');
  $('send-content').classList.add('hidden');
  $('send-done').classList.remove('hidden');
}

// ──────────────────────────────────────────────
// Event Listeners
// ──────────────────────────────────────────────
$('btn-send').onclick = () => { navigateTo('send'); resetSendScreen(); };
$('btn-receive').onclick = () => { navigateTo('receive'); startReceiveSession(); };
$('back-from-send').onclick = () => navigateTo('home');
$('back-from-receive').onclick = () => disconnectSession();
$('disconnect-btn').onclick = () => disconnectSession();

$('connect-btn').onclick = async () => {
  const code = [0, 1, 2, 3, 4].map(i => $(`ci${i}`).value).join('');
  if (await connectToSession(code)) {
    $('send-connect').classList.add('hidden');
    $('send-content').classList.remove('hidden');
  }
};

[0, 1, 2, 3, 4].forEach(i => {
  const input = $(`ci${i}`);
  input.oninput = (e) => {
    const v = e.target.value.replace(/\D/g, '');
    e.target.value = v.slice(-1);
    if (v && i < 4) $(`ci${i + 1}`).focus();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Backspace' && !e.target.value && i > 0) $(`ci${i - 1}`).focus();
  };
  input.onfocus = () => {
    // Find the first empty input
    const inputs = [0, 1, 2, 3, 4].map(idx => $(`ci${idx}`));
    const firstEmpty = inputs.find(inp => !inp.value);
    if (firstEmpty && firstEmpty !== input) {
      firstEmpty.focus();
    }
  };
});

$('ctab-file').onclick = () => { $('ctab-file').classList.add('active'); $('ctab-link').classList.remove('active'); $('file-panel').classList.remove('hidden'); $('link-panel').classList.add('hidden'); };
$('ctab-link').onclick = () => { $('ctab-link').classList.add('active'); $('ctab-file').classList.remove('active'); $('link-panel').classList.remove('hidden'); $('file-panel').classList.add('hidden'); };

$('browse-btn').onclick = (e) => { e.stopPropagation(); $('file-input').click(); };
$('drop-zone').onclick = () => $('file-input').click();
$('file-input').onchange = (e) => {
  selectedFiles = Array.from(e.target.files);
  if (selectedFiles.length) {
    $('file-preview').classList.remove('hidden');
    $('drop-zone').classList.add('hidden');
    $('file-list-container').textContent = selectedFiles.map(f => f.name).join(', ');
  }
};

$('remove-file').onclick = () => { selectedFiles = []; $('file-preview').classList.add('hidden'); $('drop-zone').classList.remove('hidden'); };
$('send-now-btn').onclick = sendContent;
$('send-again-btn').onclick = () => { $('send-done').classList.add('hidden'); $('send-content').classList.remove('hidden'); };
$('end-session-btn').onclick = () => { resetSendScreen(); navigateTo('home'); };
$('receive-again-btn').onclick = () => disconnectSession();

function resetSendScreen() {
  connectedCode = null; selectedFiles = [];
  $('send-header').classList.remove('hidden');
  $('send-connect').classList.remove('hidden');
  $('send-content').classList.add('hidden');
  $('send-done').classList.add('hidden');
  [0, 1, 2, 3, 4].forEach(i => $(`ci${i}`).value = '');
}

// Auto-connect from URL
const autoCode = new URLSearchParams(window.location.search).get('code');
if (autoCode && /^\d{5}$/.test(autoCode)) {
  setTimeout(async () => {
    navigateTo('send');
    autoCode.split('').forEach((ch, i) => { if ($(`ci${i}`)) $(`ci${i}`).value = ch; });
    if (await connectToSession(autoCode)) { $('send-connect').classList.add('hidden'); $('send-content').classList.remove('hidden'); }
    window.history.replaceState({}, '', window.location.pathname);
  }, 500);
}
// ──────────────────────────────────────────────
// Statistics
// ──────────────────────────────────────────────
async function loadStats() {
  try {
    // Total Visitors (using a reliable counter API)
    // We'll use a namespace based on the hostname for accuracy
    const ns = window.location.hostname.replace(/\./g, '_') || 'local_qshare';
    const res = await fetch(`https://api.counterapi.dev/v1/${ns}/visits/up`);
    const data = await res.json();
    if (data.count) $('visitor-count-bottom').textContent = data.count.toLocaleString();
  } catch (e) {
    console.warn('Visitor count failed:', e);
    $('visitor-count-bottom').textContent = '---';
  }
}

// Initial Load
loadStats();
// Periodic Refresh for active sessions
setInterval(loadStats, 60000); // 1m
