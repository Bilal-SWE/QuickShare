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
  $('receive-connected').classList.add('hidden');
  $('receive-done').classList.add('hidden');
  $('receive-header').classList.remove('hidden');
  $('receive-instruction').classList.remove('hidden');

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
        showToast('تم الاتصال بنجاح');
        $('receive-instruction').classList.add('hidden');
        $('receive-ready').classList.add('hidden');
        $('receive-connected').classList.remove('hidden');
      }
      if (data.status === 'transferred') {
        $('receive-header').classList.add('hidden');
        $('receive-ready').classList.add('hidden');
        $('receive-connected').classList.add('hidden');
        $('receive-done').classList.remove('hidden');

        // Store session data globally for tab switching if needed
        window.currentReceivedData = data;
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
  content.innerHTML = '';

  let files = [];
  let text = null;

  if (data.type === 'link') {
    text = data.url;
  } else if (data.type === 'file' || data.type === 'files') {
    files = data.type === 'file'
      ? [{ name: data.file_name, size: data.file_size, url: data.download_url }]
      : JSON.parse(data.url);
  } else if (data.type === 'mixed') {
    const mixedData = JSON.parse(data.url);
    files = mixedData.files || [];
    text = mixedData.text || null;
  }

  if (files.length > 0 && text) {
    // MIXED CONTENT UI - with tabs
    const tabs = document.createElement('div');
    tabs.className = 'content-tabs';
    tabs.style.marginBottom = '1.5rem';

    const fileTab = document.createElement('button');
    fileTab.className = 'ctab-btn active';
    fileTab.textContent = 'الملفات';

    const textTab = document.createElement('button');
    textTab.className = 'ctab-btn';
    textTab.textContent = 'النص / الرابط';

    const fileView = document.createElement('div');
    fileView.id = 'recv-file-view';

    const textView = document.createElement('div');
    textView.id = 'recv-text-view';
    textView.className = 'hidden';

    tabs.appendChild(fileTab);
    tabs.appendChild(textTab);
    content.appendChild(tabs);
    content.appendChild(fileView);
    content.appendChild(textView);

    // Render Files
    renderFilesToElement(files, fileView);
    // Render Text
    renderTextToElement(text, textView);

    fileTab.onclick = () => {
      fileTab.classList.add('active');
      textTab.classList.remove('active');
      fileView.classList.remove('hidden');
      textView.classList.add('hidden');
    };

    textTab.onclick = () => {
      textTab.classList.add('active');
      fileTab.classList.remove('active');
      textView.classList.remove('hidden');
      fileView.classList.add('hidden');
    };
  } else if (files.length > 0) {
    renderFilesToElement(files, content);
  } else if (text) {
    renderTextToElement(text, content);
  }
}

function renderTextToElement(text, container) {
  const urlRegex = /((https?:\/\/)|(www\.))?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi;
  const matches = text.match(urlRegex);
  let openUrl = matches ? matches[0] : null;
  if (openUrl && !openUrl.startsWith('http')) openUrl = 'https://' + openUrl;

  const textDiv = document.createElement('div');
  textDiv.className = 'received-link-wrap';

  const urlContent = document.createElement('div');
  urlContent.style.wordBreak = 'break-all';
  urlContent.textContent = text;

  const actions = document.createElement('div');
  actions.className = 'action-buttons';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn-primary';
  copyBtn.style.cssText = 'font-size: 0.85rem; font-weight: 700; padding: 0.75rem 1rem;';
  copyBtn.textContent = 'نسخ النص';
  copyBtn.onclick = () => navigator.clipboard.writeText(text).then(() => showToast('تم النسخ'));

  actions.appendChild(copyBtn);
  if (openUrl) {
    const openBtn = document.createElement('a');
    openBtn.href = openUrl;
    openBtn.target = '_blank';
    openBtn.className = 'btn-outline';
    openBtn.style.cssText = 'font-size: 0.85rem; font-weight: 700; padding: 0.75rem 1rem;';
    openBtn.textContent = 'فتح الرابط';
    actions.appendChild(openBtn);
  }

  textDiv.appendChild(urlContent);
  textDiv.appendChild(actions);
  container.appendChild(textDiv);
}

function renderFilesToElement(files, container) {
  files.forEach(file => {
    const row = document.createElement('div');
    row.className = 'received-file-wrap';
    row.style.marginBottom = '0.75rem';

    const fileNameDiv = document.createElement('div');
    fileNameDiv.style.cssText = 'font-weight: 600; font-size: 0.9rem; margin-bottom: 0.5rem; color: var(--c-text);';
    fileNameDiv.textContent = `📁 ${file.name} (${formatBytes(file.size)})`;

    const actions = document.createElement('div');
    actions.className = 'action-buttons';

    const previewBtn = document.createElement('a');
    previewBtn.href = file.url;
    previewBtn.target = '_blank';
    previewBtn.className = 'btn-outline';
    previewBtn.style.cssText = 'font-size: 0.85rem; font-weight: 700; padding: 0.75rem 1rem;';
    previewBtn.textContent = 'استعراض';

    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'btn-primary';
    downloadBtn.style.cssText = 'font-size: 0.85rem; font-weight: 700; padding: 0.75rem 1rem;';
    downloadBtn.textContent = 'تحميل';
    downloadBtn.onclick = () => triggerDownload(file.url, file.name, downloadBtn);

    actions.appendChild(previewBtn);
    actions.appendChild(downloadBtn);

    row.appendChild(fileNameDiv);
    row.appendChild(actions);
    container.appendChild(row);
  });
}

async function triggerDownload(url, name, btn) {
  const originalText = btn.textContent;
  try {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-small"></span>...';

    const response = await fetch(url);
    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(blobUrl);

    btn.disabled = false;
    btn.textContent = originalText;
  } catch (e) {
    console.error('Download failed:', e);
    showToast('فشل التحميل');
    btn.disabled = false;
    btn.textContent = originalText;

    // Fallback: regular link
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.target = '_blank';
    a.click();
  }
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
  const hasFiles = selectedFiles.length > 0;
  const text = $('link-input').value.trim();
  const hasText = text.length > 0;

  if (!hasFiles && !hasText) return showToast('أدخل محتوى للإرسال أولاً');

  // Validate files
  if (hasFiles) {
    const MAX_SIZE = 50 * 1024 * 1024;
    const ALLOWED_EXTS = [
      'jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'heic', 'heif',
      'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'rtf',
      'zip', 'rar', '7z', 'tar', 'gz',
      'mp3', 'mp4', 'wav', 'mov', 'avi', 'm4a', 'flac'
    ];
    for (const file of selectedFiles) {
      if (file.size > MAX_SIZE) return showToast(`الملف ${file.name} كبير جداً (الأقصى 50 ميغا)`);
      const ext = file.name.split('.').pop().toLowerCase();
      if (!ALLOWED_EXTS.includes(ext)) return showToast(`نوع الملف ${ext} غير مسموح به`);
    }
  }

  // Validate text
  if (hasText && text.length > 500) return showToast('النص يتجاوز 500 حرف');

  $('send-now-btn').disabled = true;
  $('send-now-btn').innerHTML = '<span class="spinner-small"></span> جاري الإرسال...';

  try {
    let uploadedFileList = [];
    if (hasFiles) {
      for (const file of selectedFiles) {
        const path = `${connectedCode}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
        const { error: uploadError } = await supabase.storage.from('transfers').upload(path, file, { contentType: file.type, upsert: true });
        if (uploadError) throw uploadError;
        const { data: urlData } = supabase.storage.from('transfers').getPublicUrl(path);
        uploadedFileList.push({ name: file.name, size: file.size, url: urlData.publicUrl });
      }
    }

    const sanitizedText = hasText ? text.replace(/</g, "&lt;").replace(/>/g, "&gt;") : null;

    let payload = {};
    if (hasFiles && hasText) {
      payload = { status: 'transferred', type: 'mixed', url: JSON.stringify({ files: uploadedFileList, text: sanitizedText }) };
    } else if (hasFiles) {
      payload = { status: 'transferred', type: 'files', url: JSON.stringify(uploadedFileList) };
    } else {
      payload = { status: 'transferred', type: 'link', url: sanitizedText };
    }

    await supabase.from('sessions').update(payload).eq('code', connectedCode);
    showSendDone();
  } catch (e) {
    console.error(e);
    showToast('فشل الإرسال: ' + (e.message || 'خطأ مجهول'));
    $('send-now-btn').disabled = false;
    $('send-now-btn').textContent = 'إرسال الآن';
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

$('connect-btn').onclick = async () => {
  const code = [0, 1, 2, 3, 4].map(i => $(`ci${i}`).value).join('');
  if (await connectToSession(code)) {
    $('send-instruction').textContent = 'تم الاتصال بنجاح';
    $('send-connect').classList.add('hidden');
    $('send-content').classList.remove('hidden');
  }
};

[0, 1, 2, 3, 4].forEach(i => {
  const input = $(`ci${i}`);
  input.oninput = (e) => {
    const v = e.target.value.replace(/\D/g, '');
    e.target.value = v.slice(-1);
    if (v && i < 4) {
      $(`ci${i + 1}`).focus();
    } else if (v && i === 4) {
      const fullCode = [0, 1, 2, 3, 4].map(idx => $(`ci${idx}`).value).join('');
      if (fullCode.length === 5) $('connect-btn').click();
    }
  };
  input.onkeydown = (e) => {
    if (e.key === 'Backspace' && !e.target.value && i > 0) {
      $(`ci${i - 1}`).focus();
    }
  };
  input.onfocus = () => {
    // If the box already has a digit, allow focus and place cursor at the end (to allow backspace)
    if (input.value) {
      setTimeout(() => input.setSelectionRange(1, 1), 0);
      return;
    }

    const inputs = [0, 1, 2, 3, 4].map(idx => $(`ci${idx}`));
    const firstEmpty = inputs.find(inp => !inp.value);
    if (firstEmpty && firstEmpty !== input) {
      firstEmpty.focus();
    }
  };
});

$('ctab-file').onclick = () => { $('ctab-file').classList.add('active'); $('ctab-link').classList.remove('active'); $('file-panel').classList.remove('hidden'); $('link-panel').classList.add('hidden'); };
$('ctab-link').onclick = () => { $('ctab-link').classList.add('active'); $('ctab-file').classList.remove('active'); $('link-panel').classList.remove('hidden'); $('file-panel').classList.add('hidden'); };

$('link-input').oninput = (e) => {
  $('char-count').textContent = e.target.value.length;
};

$('browse-btn').onclick = (e) => { e.stopPropagation(); $('file-input').click(); };
$('drop-zone').onclick = () => $('file-input').click();
$('file-input').onchange = (e) => {
  const newFiles = Array.from(e.target.files);
  const MAX_SIZE = 50 * 1024 * 1024;

  const valid = newFiles.filter(f => f.size <= MAX_SIZE);
  if (valid.length < newFiles.length) {
    showToast('تم استبعاد ملفات تتجاوز 50 ميغا');
  }

  // Append new unique files (by name/size)
  selectedFiles = [...selectedFiles, ...valid];
  updateFileList();
  e.target.value = ''; // Reset input to allow selecting the same file again
};

function updateFileList() {
  const container = $('file-list-container');
  container.innerHTML = '';

  if (selectedFiles.length === 0) {
    if (!$('screen-send').classList.contains('hidden')) {
      $('file-preview').classList.add('hidden');
      $('drop-zone').classList.remove('hidden');
    }
    return;
  }

  $('file-preview').classList.remove('hidden');
  $('drop-zone').classList.add('hidden');

  selectedFiles.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'file-item-chip';
    item.innerHTML = `
      <span class="fitem-name">${file.name}</span>
      <button class="fitem-remove" data-index="${index}">✕</button>
    `;
    // Add event listener correctly instead of inline
    item.querySelector('.fitem-remove').onclick = (ev) => {
      ev.stopPropagation();
      selectedFiles.splice(index, 1);
      updateFileList();
    };
    container.appendChild(item);
  });
}

$('add-more-btn').onclick = (e) => { e.stopPropagation(); $('file-input').click(); };
$('send-now-btn').onclick = sendContent;
$('send-again-btn').onclick = () => {
  $('send-done').classList.add('hidden');
  $('send-content').classList.remove('hidden');

  $('send-now-btn').textContent = 'إرسال الآن';
  $('send-now-btn').disabled = false;
};
$('end-session-btn').onclick = () => { resetSendScreen(); navigateTo('home'); };
$('receive-again-btn').onclick = () => disconnectSession();

function resetSendScreen() {
  connectedCode = null; selectedFiles = [];
  $('send-header').classList.remove('hidden');
  $('send-instruction').textContent = 'أدخل رمز المستقبِل للمتابعة';
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
// Footer Sections (Founder & How to use)
// ──────────────────────────────────────────────
function toggleFooterSection(id) {
  const target = $(id);
  const sections = ['founder-section', 'how-section'];
  const isActive = target.classList.contains('active');

  // Close others
  sections.forEach(sId => {
    if (sId !== id) {
      $(sId).classList.remove('active');
      $(sId).classList.add('hidden');
    }
  });

  if (isActive) {
    target.classList.remove('active');
    document.body.classList.remove('allow-scroll');
    setTimeout(() => target.classList.add('hidden'), 600);
  } else {
    target.classList.remove('hidden');
    document.body.classList.add('allow-scroll');
    setTimeout(() => {
      target.classList.add('active');
      setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
    }, 20);
  }
}

$('btn-founder').onclick = () => toggleFooterSection('founder-section');
$('btn-how').onclick = () => toggleFooterSection('how-section');


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
