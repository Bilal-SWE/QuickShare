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
let selectedFiles = [];
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
          $('receive-ready').classList.add('hidden');
          $('receive-done').classList.remove('hidden');

          const content = $('received-content');
          let htmlItem = '';
          if (data.type === 'link') {
            const isUrl = data.url.startsWith('http://') || data.url.startsWith('https://');
            const displayContent = isUrl
              ? `<a href="${data.url}" target="_blank" rel="noopener" style="word-break: break-all;">${data.url}</a>`
              : `<div style="white-space: pre-wrap; word-break: break-word; text-align: right; width: 100%;">${data.url}</div>`;

            htmlItem = `
              <div class="received-link-wrap" style="align-items: flex-start; padding: 10px; background: rgba(255,255,255,0.05); border-radius: 8px;">
                <svg style="flex-shrink:0;width:20px;height:20px;color:var(--c-teal);margin-top:2px; margin-left: 8px;" viewBox="0 0 24 24" fill="none">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                ${displayContent}
              </div>`;
          } else if (data.type === 'file') {
            htmlItem = `
              <div class="received-file-wrap" style="padding: 10px; background: rgba(255,255,255,0.05); border-radius: 8px;">
                <p class="received-file-name" style="margin-bottom: 8px;">📁 ${data.file_name}</p>
                <a class="btn-download" href="${data.download_url}" target="_blank" download="${data.file_name}">
                  <svg viewBox="0 0 24 24" fill="none" style="width:18px;height:18px; margin-left: 5px;">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <polyline points="7 10 12 15 17 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <line x1="12" y1="3" x2="12" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                  </svg>
                  تحميل الملف
                </a>
              </div>`;
          }
          content.insertAdjacentHTML('beforeend', htmlItem);
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
    if (selectedFiles.length === 0) { showToast('يرجى اختيار ملف'); return; }

    $('upload-progress').classList.remove('hidden');
    $('send-now-btn').disabled = true;

    let fakeProgress = 0;
    const fakeTimer = setInterval(() => {
      if (fakeProgress < 90) {
        fakeProgress += Math.random() * 8;
        if (fakeProgress > 90) fakeProgress = 90;
        $('progress-bar').style.width = `${fakeProgress.toFixed(0)}%`;
        $('progress-text').textContent = `${fakeProgress.toFixed(0)}%`;
      }
    }, 300);

    try {
      for (const file of selectedFiles) {
        await uploadSingleFile(file);
      }
      clearInterval(fakeTimer);
      $('progress-bar').style.width = '100%';
      $('progress-text').textContent = '100%';
      setTimeout(showSendDone, 400);
    } catch (err) {
      clearInterval(fakeTimer);
      console.error('Upload error:', err);
      showToast(`خطأ في الرفع: ${err.message}`);
      $('upload-progress').classList.add('hidden');
      $('progress-bar').style.width = '0%';
      $('send-now-btn').disabled = false;
    }

  } else {
    const rawUrl = $('link-input').value.trim();
    if (!rawUrl) { showToast('يرجى إدخال نص أو رابط'); return; }

    const sanitizedUrl = rawUrl
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

    await sendLink(sanitizedUrl);
  }
}

async function uploadSingleFile(file) {
  const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = `${connectedCode}/${Date.now()}_${safeFileName}`;

  const { error: uploadError } = await supabase.storage
    .from('transfers')
    .upload(filePath, file, {
      cacheControl: '3600',
      upsert: true,
      contentType: file.type || 'application/octet-stream',
    });

  if (uploadError) throw uploadError;

  const { data: urlData } = supabase.storage
    .from('transfers')
    .getPublicUrl(filePath);

  const downloadUrl = urlData.publicUrl;

  const { error: updateError } = await supabase.from('sessions').update({
    status: 'transferred',
    type: 'file',
    file_name: file.name,
    file_size: file.size,
    download_url: downloadUrl,
  }).eq('code', connectedCode);

  if (updateError) throw updateError;
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
  selectedFiles = [];
  $('send-connect').classList.remove('hidden');
  $('send-content').classList.add('hidden');
  $('send-done').classList.add('hidden');
  $('upload-progress').classList.add('hidden');
  $('progress-bar').style.width = '0%';
  $('file-list-container').innerHTML = '';
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
// Internationalization (i18n)
// ──────────────────────────────────────────────

const translations = {
  ar: {
    nav_features: "المميزات",
    nav_how: "كيف يعمل؟",
    nav_start: "ابدأ الآن",
    hero_badge: "تحديث: نقل ملفات متعددة متوفر الآن! ✨",
    hero_title: 'نقل الملفات والروابط <br><span class="gradient-text">بلمحة بصر (Q-Share)</span>',
    hero_desc: "أسرع وسيلة لنقل ملفاتك بين هاتفك وحواسبك دون الحاجة لحساب أو تسجيل دخول. آمن، مشفر، ومجاني تماماً.",
    hero_btn_send: "إرسال ملف",
    hero_btn_receive: "استقبال",
    features_title: 'لماذا تختار <span class="gradient-text">Q-Share</span>؟',
    feat_1_title: "خصوصية تامة",
    feat_1_desc: "يتم حذف جميع الملفات والروابط تلقائياً بعد مرور 10 دقائق من الاستخدام.",
    feat_2_title: "سرعة فائقة",
    feat_2_desc: "تقنيات متطورة تضمن لك وصول الملفات في أجزاء من الثانية فور الضغط على إرسال.",
    feat_3_title: "لا حاجة للتسجيل",
    feat_3_desc: "ابدأ النقل فوراً دون بريد إلكتروني أو كلمات مرور. فقط الرمز ولقد بدأت!",
    app_send: "إرسال",
    app_send_desc: "رفع ملفات أو كتابة روابط",
    app_receive: "استقبال",
    app_receive_desc: "الحصول على رمز الاستقبال",
    rec_title: "جاهز للاستقبال",
    rec_desc: "شارك الرمز أو الباركود مع المُرسِل",
    rec_loading: "جاري إعداد الجلسة...",
    rec_copy: "نسخ الرمز",
    rec_status_wait: "بانتظار المُرسِل...",
    rec_status_connected: "✅ تم الاتصال! في انتظار المحتوى…",
    rec_done_title: "وصلت الملفات!",
    rec_again: "استقبال ملف جديد",
    send_conn_title: "الاتصال بالجهاز",
    send_conn_desc: "أدخل الرمز المكون من 6 أرقام",
    send_conn_btn: "اتصال",
    send_error_code: "رمز غير صحيح",
    send_status_connected: "متصل بالمستقبِل",
    tab_files: "ملفات",
    tab_links: "روابط / نص",
    drop_text: "اسحب الملفات هنا أو اضغط للاختيار",
    limit_text: "الحد الأقصى 40 ميغا لكل ملف",
    reset_btn: "إعادة التعيين",
    textarea_placeholder: "اكتب نصاً أو الصق رابطاً هنا...",
    send_btn: "إرسال الآن",
    send_done_title: "تم الإرسال!",
    send_done_desc: "استلم المستقبِل المحتوى بنجاح",
    send_again: "إرسال المزيد",
    end_session: "إنهاء الجلسة",
    how_title: 'كيفية <span class="gradient-text">الاستخدام</span>',
    step_1_title: "افتح الموقع على الجهازين",
    step_1_desc: "تأكد من فتح Q-Share على كل من الجهاز المرسل والمستقبل.",
    step_2_title: "انسخ الرمز",
    step_2_desc: "اضغط 'استقبال' على أحد الأجهزة وخذ الرمز المكون من 6 أرقام.",
    step_3_title: "ابدأ النقل",
    step_3_desc: "أدخل الرمز في الجهاز الآخر، اختر ملفاتك، واضغط إرسال!",
    footer_desc: "نقل فوري وبسيط للملفات والروابط.",
    footer_privacy: "الخصوصية",
    footer_contact: "تواصل معنا",
    footer_copy: "© 2024 Q-Share. جميع الحقوق محفوظة.",
    toast_copied: "تم نسخ الرمز ✓",
    toast_copy_fail: "تعذر النسخ",
    toast_expire: "انتهت صلاحية الجلسة",
    toast_no_files: "يرجى اختيار ملف",
    toast_no_text: "يرجى إدخال نص أو رابط",
    toast_invalid: "الرمز غير صالح أو منتهي الصلاحية"
  },
  en: {
    nav_features: "Features",
    nav_how: "How it works?",
    nav_start: "Start Now",
    hero_badge: "Update: Multi-file transfer available! ✨",
    hero_title: 'Transfer Files & Links <br><span class="gradient-text">in a Flash (Q-Share)</span>',
    hero_desc: "The fastest way to move files between your phone and computers with no account needed. Secure, encrypted, and completely free.",
    hero_btn_send: "Send File",
    hero_btn_receive: "Receive",
    features_title: 'Why choose <span class="gradient-text">Q-Share</span>?',
    feat_1_title: "Full Privacy",
    feat_1_desc: "All files and links are auto-deleted 10 minutes after use.",
    feat_2_title: "High Speed",
    feat_2_desc: "Advanced tech ensures files arrive in milliseconds after clicking send.",
    feat_3_title: "No Account",
    feat_3_desc: "Start transferring immediately without emails or passwords. Just use the code!",
    app_send: "Send",
    app_send_desc: "Upload files or write links",
    app_receive: "Receive",
    app_receive_desc: "Get reception code",
    rec_title: "Ready to Receive",
    rec_desc: "Share the code or QR with the sender",
    rec_loading: "Setting up session...",
    rec_copy: "Copy Code",
    rec_status_wait: "Waiting for sender...",
    rec_status_connected: "✅ Connected! Waiting for content...",
    rec_done_title: "Files Received!",
    rec_again: "Receive New File",
    send_conn_title: "Connect Device",
    send_conn_desc: "Enter the 6-digit code",
    send_conn_btn: "Connect",
    send_error_code: "Invalid Code",
    send_status_connected: "Connected to Receiver",
    tab_files: "Files",
    tab_links: "Links / Text",
    drop_text: "Drop files here or click to choose",
    limit_text: "Max 40MB per file",
    reset_btn: "Reset",
    textarea_placeholder: "Write text or paste link here...",
    send_btn: "Send Now",
    send_done_title: "Sent Successfully!",
    send_done_desc: "Receiver got the content successfully",
    send_again: "Send More",
    end_session: "End Session",
    how_title: 'How it <span class="gradient-text">Works</span>',
    step_1_title: "Open on both devices",
    step_1_desc: "Ensure Q-Share is open on sender and receiver devices.",
    step_2_title: "Copy the code",
    step_2_desc: "Click 'Receive' on one device and take the 6-digit code.",
    step_3_title: "Start transfer",
    step_3_desc: "Enter code on other device, pick files, and hit send!",
    footer_desc: "Simple, instant file and link transfer.",
    footer_privacy: "Privacy",
    footer_contact: "Contact",
    footer_copy: "© 2024 Q-Share. All rights reserved.",
    toast_copied: "Code copied ✓",
    toast_copy_fail: "Copy failed",
    toast_expire: "Session expired",
    toast_no_files: "Please choose a file",
    toast_no_text: "Please enter text or link",
    toast_invalid: "Invalid or expired code"
  }
};

let currentLang = localStorage.getItem('qshare_lang') || 'ar';

function updateLanguage(lang) {
  currentLang = lang;
  localStorage.setItem('qshare_lang', lang);

  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.documentElement.setAttribute('dir', dir);
  document.documentElement.setAttribute('lang', lang);

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (translations[lang][key]) {
      el.innerHTML = translations[lang][key];
    }
  });

  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const key = el.getAttribute('data-i18n-ph');
    if (translations[lang][key]) {
      el.placeholder = translations[lang][key];
    }
  });

  // Update toggle button label
  $('lang-label').textContent = lang === 'ar' ? 'EN' : 'العربية';

  // Update some hardcoded logical bits
  if (lang === 'en') {
    document.body.classList.add('en-mode');
  } else {
    document.body.classList.remove('en-mode');
  }
}

// ──────────────────────────────────────────────
// Event Listeners
// ──────────────────────────────────────────────

// Helper to scroll to app
function scrollToApp() {
  document.getElementById('app-container').scrollIntoView({ behavior: 'smooth' });
}

// Lang Toggle
$('lang-toggle-btn').addEventListener('click', () => {
  const next = currentLang === 'ar' ? 'en' : 'ar';
  updateLanguage(next);
});

// Nav and Hero Actions
$('nav-btn-start')?.addEventListener('click', scrollToApp);
$('hero-send')?.addEventListener('click', (e) => {
  e.preventDefault();
  navigateTo('send');
  scrollToApp();
  setTimeout(() => $('ci0').focus(), 400);
});
$('hero-receive')?.addEventListener('click', (e) => {
  e.preventDefault();
  navigateTo('receive');
  scrollToApp();
  startReceiveSession();
});

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
      .then(() => showToast(translations[currentLang].toast_copied))
      .catch(() => showToast(translations[currentLang].toast_copy_fail));
  }
});

$('receive-again-btn').addEventListener('click', () => {
  $('received-content').innerHTML = '';
  startReceiveSession();
});

$('send-again-btn').addEventListener('click', () => {
  selectedFiles = [];
  $('file-input').value = '';
  $('file-list-container').innerHTML = '';
  $('file-preview').classList.add('hidden');
  $('drop-zone').classList.remove('hidden');
  $('link-input').value = '';
  $('upload-progress').classList.add('hidden');
  $('progress-bar').style.width = '0%';
  $('send-now-btn').disabled = false;

  $('send-done').classList.add('hidden');
  $('send-content').classList.remove('hidden');
});

$('end-session-btn').addEventListener('click', () => {
  resetSendScreen();
  setTimeout(() => $('ci0').focus(), 100);
});

// Code char inputs
const charInputs = [0, 1, 2, 3, 4, 5].map(i => $(`ci${i}`));
charInputs.forEach((input, idx) => {
  if (!input) return;
  input.addEventListener('input', () => {
    const v = input.value.replace(/\D/g, '');
    input.value = v.slice(-1);
    if (v) {
      if (idx < 5) charInputs[idx + 1].focus();
    }
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
const dropZone = $('drop-zone');
dropZone.addEventListener('click', () => $('file-input').click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length > 0) handleFileSelect(e.dataTransfer.files);
});
$('file-input').addEventListener('change', (e) => {
  if (e.target.files.length > 0) handleFileSelect(e.target.files);
});

function handleFileSelect(files) {
  const maxBytes = 40 * 1024 * 1024;
  Array.from(files).forEach(file => {
    if (file.size > maxBytes) {
      showToast(currentLang === 'ar' ? `الملف ${file.name} كبير جداً` : `File ${file.name} is too large`);
    } else {
      selectedFiles.push(file);
    }
  });

  if (selectedFiles.length > 0) {
    renderFileList();
    $('file-preview').classList.remove('hidden');
    dropZone.classList.add('hidden');
  }
}

function renderFileList() {
  const container = $('file-list-container');
  container.innerHTML = '';
  selectedFiles.forEach(file => {
    container.innerHTML += `
            <div class="file-info" style="margin-bottom: 5px; background: rgba(255,255,255,0.05); padding: 8px 12px; border-radius: 8px; display: flex; align-items: center; gap: 10px;">
                <div class="file-icon-wrap" style="width: 24px; height: 24px; color: var(--c-primary);">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke-width="2" />
                      <polyline points="14 2 14 8 20 8" stroke-width="2" stroke-linejoin="round" />
                    </svg>
                </div>
                <div style="flex: 1; overflow: hidden; text-align: start;">
                  <p class="file-name-text" style="font-size: 0.95rem; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${file.name}</p>
                  <p class="file-size-text" style="font-size: 0.8rem; margin: 0; color: rgba(255,255,255,0.6);">${formatBytes(file.size)}</p>
                </div>
            </div>
        `;
  });
}

$('remove-file').addEventListener('click', () => {
  selectedFiles = [];
  $('file-input').value = '';
  $('file-list-container').innerHTML = '';
  $('file-preview').classList.add('hidden');
  dropZone.classList.remove('hidden');
});

$('send-now-btn').addEventListener('click', sendContent);

const urlParams = new URLSearchParams(window.location.search);
const autoCode = urlParams.get('code');
if (autoCode && /^\d{6}$/.test(autoCode)) {
  setTimeout(async () => {
    navigateTo('send');
    scrollToApp();
    autoCode.split('').forEach((ch, i) => { if (charInputs[i]) charInputs[i].value = ch; });
    const ok = await connectToSession(autoCode);
    if (ok) {
      $('send-connect').classList.add('hidden');
      $('send-content').classList.remove('hidden');
    } else {
      showToast(translations[currentLang].toast_invalid);
    }
    window.history.replaceState({}, '', window.location.pathname);
  }, 500);
}

// Init Lang
updateLanguage(currentLang);


