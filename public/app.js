const stages = {
  setup: document.getElementById('stage-setup'),
  browser: document.getElementById('stage-browser'),
  working: document.getElementById('stage-working'),
  review: document.getElementById('stage-review'),
  done: document.getElementById('stage-done'),
  error: document.getElementById('stage-error'),
};
const VIEWPORT_W = 1280;
const VIEWPORT_H = 900;
const statusLog = document.getElementById('status-log');
const answerList = document.getElementById('answer-list');
const reviewHeading = document.getElementById('review-heading');
const errorMessage = document.getElementById('error-message');
const doneBody = document.getElementById('done-body');
const doneTitle = document.getElementById('done-title');

let sessionId = null;
let questions = null;
let answers = null;
let eventSource = null;
let currentPhase = null;
let connectionStatusEl = null;

function setConnectionStatus(state) {
  // state: 'idle' | 'live' | 'reconnecting' | 'lost'
  connectionStatusEl ||= document.getElementById('conn-status');
  if (!connectionStatusEl) return;
  const dot = connectionStatusEl.querySelector('[data-dot]');
  const label = connectionStatusEl.querySelector('[data-label]');
  if (!dot || !label) return;
  dot.classList.remove('bg-primary', 'bg-error', 'bg-tertiary', 'animate-pulse');
  if (state === 'live') {
    dot.classList.add('bg-primary', 'animate-pulse');
    label.textContent = 'connected';
  } else if (state === 'reconnecting') {
    dot.classList.add('bg-tertiary', 'animate-pulse');
    label.textContent = 'reconnecting…';
  } else if (state === 'lost') {
    dot.classList.add('bg-error');
    label.textContent = 'disconnected';
  } else {
    dot.classList.add('bg-tertiary');
    label.textContent = 'idle';
  }
}

function show(stage) {
  for (const k of Object.keys(stages)) stages[k].classList.add('hidden');
  const target = stages[stage];
  if (!target) return;
  target.classList.remove('hidden');
  // Subtle fade-in
  target.classList.remove('stage-enter');
  void target.offsetWidth; // force reflow so the class re-applies
  target.classList.add('stage-enter');
  // Scroll the new stage into view (helpful on mobile after a transition)
  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function appendStatus(message) {
  const li = document.createElement('li');
  li.className = 'flex gap-2';
  const ts = document.createElement('span');
  ts.className = 'text-outline/70 flex-shrink-0';
  const d = new Date();
  ts.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  const text = document.createElement('span');
  text.className = 'flex-1 break-words';
  text.textContent = message;
  const lower = message.toLowerCase();
  if (lower.includes('error') || lower.includes('failed') || lower.includes('cannot')) {
    text.classList.add('text-error');
  } else if (lower.startsWith('filled') || lower.startsWith('all answers') || lower.includes('score:') || lower.includes('submitted') || lower.includes('got ')) {
    text.classList.add('text-primary');
  }
  li.appendChild(ts);
  li.appendChild(text);
  statusLog.appendChild(li);
  statusLog.scrollTop = statusLog.scrollHeight;
}

function showError(msg) {
  errorMessage.textContent = msg;
  show('error');
  if (eventSource) eventSource.close();
}

function setFieldError(id, msg) {
  const input = document.getElementById(id);
  if (!input) return;
  input.classList.toggle('field-invalid', !!msg);
  let label = input.parentElement;
  let existing = label?.querySelector('.field-error-msg');
  if (msg) {
    if (!existing) {
      existing = document.createElement('div');
      existing.className = 'field-error-msg';
      existing.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px">error</span><span></span>';
      label.appendChild(existing);
    }
    existing.querySelector('span:last-child').textContent = msg;
  } else if (existing) {
    existing.remove();
  }
}

['quizUrl', 'name', 'enrollment'].forEach((id) => {
  const el = document.getElementById(id);
  el?.addEventListener('input', () => setFieldError(id, ''));
});

document.getElementById('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const quizUrl = document.getElementById('quizUrl').value.trim();
  const name = document.getElementById('name').value.trim();
  const enrollment = document.getElementById('enrollment').value.trim();

  // Client-side validation
  let firstInvalid = null;
  if (!quizUrl) {
    setFieldError('quizUrl', 'Quiz URL is required.'); firstInvalid ||= 'quizUrl';
  } else if (!/docs\.google\.com\/forms\//.test(quizUrl)) {
    setFieldError('quizUrl', 'That doesn\'t look like a Google Forms URL.'); firstInvalid ||= 'quizUrl';
  } else { setFieldError('quizUrl', ''); }
  if (!name) { setFieldError('name', 'Name is required.'); firstInvalid ||= 'name'; } else { setFieldError('name', ''); }
  if (!enrollment) { setFieldError('enrollment', 'Enrollment is required.'); firstInvalid ||= 'enrollment'; } else { setFieldError('enrollment', ''); }
  if (firstInvalid) { document.getElementById(firstInvalid)?.focus(); return; }

  const startBtn = document.getElementById('startBtn');
  const startBtnLabel = document.getElementById('startBtnLabel');
  startBtn.disabled = true;
  startBtnLabel.textContent = 'Starting…';

  const payload = { quizUrl, name, enrollment };

  try {
    const res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const { sessionId: id } = await res.json();
    sessionId = id;
    statusLog.innerHTML = '';
    show('working');
    openEventStream();
  } catch (err) {
    showError(err.message);
  } finally {
    startBtn.disabled = false;
    startBtnLabel.textContent = 'Start session';
  }
});

function openEventStream() {
  eventSource = new EventSource(`/api/events?sessionId=${encodeURIComponent(sessionId)}`);
  eventSource.addEventListener('open', () => setConnectionStatus('live'));
  eventSource.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    appendStatus(data.message);
  });
  eventSource.addEventListener('phase', (e) => {
    const data = JSON.parse(e.data);
    currentPhase = data.phase;
    handlePhase(data.phase);
  });
  eventSource.addEventListener('review', (e) => {
    const data = JSON.parse(e.data);
    questions = data.questions;
    answers = data.suggestedAnswers;
    renderReview(data.heading, data.questions, data.suggestedAnswers);
  });
  eventSource.addEventListener('done', (e) => {
    const data = JSON.parse(e.data);
    if (data.alreadySubmitted) {
      doneTitle.textContent = 'Already submitted';
    } else if (data.body && data.body.toLowerCase().includes('submitted')) {
      doneTitle.textContent = 'Submitted ✓';
    } else {
      doneTitle.textContent = 'Finished';
    }
    doneBody.textContent = data.body || data.url || 'No confirmation text.';

    const scoreCard = document.getElementById('score-card');
    const scoreLiveWrapper = document.getElementById('score-live-wrapper');
    if (data.score && data.total) {
      document.getElementById('score-value').textContent = data.score;
      document.getElementById('score-total').textContent = data.total;
      const pct = (parseFloat(data.score) / parseFloat(data.total)) * 100;
      const pctEl = document.getElementById('score-pct');
      if (Number.isFinite(pct)) pctEl.textContent = `${pct.toFixed(1)}%`;
      // Animate the progress ring (circumference = 2π·52 ≈ 326.726)
      const ring = document.getElementById('score-ring');
      if (ring && Number.isFinite(pct)) {
        const C = 2 * Math.PI * 52;
        // Trigger a reflow before changing dashoffset so the transition fires
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            ring.setAttribute('stroke-dashoffset', String(C * (1 - Math.max(0, Math.min(100, pct)) / 100)));
          });
        });
      }
      scoreCard.classList.remove('hidden');
      scoreLiveWrapper.classList.remove('hidden');
    } else {
      scoreCard.classList.add('hidden');
      // If we navigated to a score page (even without parsing), still let user see it
      if (data.scoreUrl) scoreLiveWrapper.classList.remove('hidden');
    }
    show('done');
    // Note: do NOT close the eventSource — we may still get screenshot polling
  });
  eventSource.addEventListener('error', (e) => {
    if (e.data) {
      try {
        const data = JSON.parse(e.data);
        showError(data.message || 'Unknown error');
        return;
      } catch {}
    }
    // No data — readyState tells us whether we'll auto-reconnect or we're done.
    if (eventSource && eventSource.readyState === EventSource.CONNECTING) {
      setConnectionStatus('reconnecting');
    } else if (eventSource && eventSource.readyState === EventSource.CLOSED) {
      setConnectionStatus('lost');
    }
  });
}

function renderReview(heading, qs, suggested) {
  reviewHeading.textContent = heading || 'Confirm submission';
  answerList.innerHTML = '';

  qs.forEach((q, i) => {
    const row = document.createElement('div');
    row.className = 'bg-surface-container-low rounded-xl p-4 flex gap-3 transition';

    const qNum = document.createElement('div');
    qNum.className = 'flex-shrink-0 w-9 h-9 rounded-full bg-primary-fixed text-on-primary-fixed flex items-center justify-center text-sm font-medium font-label';
    qNum.textContent = `${i + 1}`;
    row.appendChild(qNum);

    const body = document.createElement('div');
    body.className = 'flex-1 min-w-0 space-y-3';

    const qtext = document.createElement('div');
    qtext.className = 'text-sm text-on-surface leading-relaxed font-body';
    qtext.textContent = q.text;
    body.appendChild(qtext);

    const optionsDiv = document.createElement('div');
    optionsDiv.className = 'space-y-1';
    const pick = suggested && suggested[i];

    q.options.forEach((opt) => {
      const row = document.createElement('div');
      const isPicked = pick && opt === pick;
      row.className = isPicked
        ? 'flex items-start gap-2.5 px-3 py-2 rounded-lg border border-primary-fixed-dim bg-primary-fixed text-on-primary-fixed font-medium'
        : 'flex items-start gap-2.5 px-3 py-2 rounded-lg border border-transparent text-on-surface-variant';

      // Visual radio dot (read-only — not an <input>)
      const dot = document.createElement('span');
      if (isPicked) {
        dot.className = 'material-symbols-outlined text-base text-on-primary-fixed flex-shrink-0';
        dot.textContent = 'radio_button_checked';
        dot.style.fontVariationSettings = "'FILL' 1";
      } else {
        dot.className = 'material-symbols-outlined text-base text-outline/60 flex-shrink-0';
        dot.textContent = 'radio_button_unchecked';
      }

      const span = document.createElement('span');
      span.className = 'text-sm break-words flex-1 leading-snug';
      span.textContent = opt;

      row.appendChild(dot);
      row.appendChild(span);
      optionsDiv.appendChild(row);
    });

    body.appendChild(optionsDiv);
    row.appendChild(body);
    answerList.appendChild(row);
  });

  updateReviewSummary();
  show('review');
}

function updateReviewSummary() {
  const submitBtn = document.getElementById('submitBtn');
  const submitBtnLabel = document.getElementById('submitBtnLabel');
  const summary = document.getElementById('review-summary');
  const total = answers ? answers.length : 0;
  const unanswered = answers ? answers.filter((a) => !a).length : 0;

  if (summary) {
    if (unanswered === 0) {
      summary.className = 'text-xs font-label tracking-wide bg-primary-fixed text-on-primary-fixed rounded-xl px-4 py-2.5 mb-4 flex items-center gap-2';
      summary.innerHTML = `<span class="material-symbols-outlined text-base">check_circle</span><span>All ${total} answers ready. Submit when you're ready.</span>`;
    } else {
      summary.className = 'text-xs font-label tracking-wide bg-error-container text-on-error-container rounded-xl px-4 py-2.5 mb-4 flex items-center gap-2';
      summary.innerHTML = `<span class="material-symbols-outlined text-base">warning</span><span>${unanswered} of ${total} unanswered.</span>`;
    }
    summary.classList.remove('hidden');
  }

  if (!submitBtn || !submitBtnLabel) return;
  if (unanswered > 0) {
    submitBtn.disabled = true;
    submitBtnLabel.textContent = `${unanswered} unanswered — cannot submit`;
  } else {
    submitBtn.disabled = false;
    submitBtnLabel.textContent = 'Submit quiz';
  }
}

document.getElementById('submitBtn').addEventListener('click', async () => {
  if (!answers || answers.some((a) => !a)) {
    alert('Some questions have no answer. Cannot submit.');
    return;
  }
  if (!confirm(`Submit ${answers.length} answers to the quiz?`)) return;

  const submitBtn = document.getElementById('submitBtn');
  const submitBtnLabel = document.getElementById('submitBtnLabel');
  submitBtn.disabled = true;
  submitBtnLabel.textContent = 'Submitting…';
  try {
    const res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, answers }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    // The 'done' SSE event triggers the success screen
  } catch (err) {
    showError(err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtnLabel.textContent = 'Submit quiz';
  }
});

document.getElementById('cancelBtn').addEventListener('click', cancelSession);

// ---------------------------------------------------------------------------
// Embedded browser (Google sign-in) — screenshot polling + input forwarding
// ---------------------------------------------------------------------------

let streamActive = false;
let streamTimer = null;
const browserImg = document.getElementById('browser-img');
const browserLoading = document.getElementById('browser-loading');
const browserInput = document.getElementById('browser-input');

function handlePhase(phase) {
  const browserTitle = document.getElementById('browser-title');
  const browserSubtitle = document.getElementById('browser-subtitle');
  const browserIcon = document.getElementById('browser-icon-symbol');
  const inputBar = document.getElementById('browser-input-bar');

  if (phase === 'signin') {
    show('browser');
    startBrowserStream();
    if (browserTitle) browserTitle.textContent = 'Sign in to Google';
    if (browserSubtitle) browserSubtitle.textContent = 'Tap fields to focus, type below. Once you reach the form, the helper takes over automatically.';
    if (browserIcon) { browserIcon.textContent = 'login'; browserIcon.classList.remove('animate-spin'); }
    if (inputBar) inputBar.style.display = '';
    setTimeout(() => browserInput && browserInput.focus(), 100);
  } else if (phase === 'automating') {
    show('browser');
    startBrowserStream();
    if (browserTitle) browserTitle.textContent = 'Filling the form…';
    if (browserSubtitle) browserSubtitle.textContent = 'Hands off — the helper is filling fields and reading questions.';
    if (browserIcon) { browserIcon.textContent = 'progress_activity'; browserIcon.classList.add('animate-spin'); }
    if (inputBar) inputBar.style.display = 'none';
  } else if (phase === 'review' || phase === 'submitting' || phase === 'done') {
    stopBrowserStream();
  }
}

// Phones can't comfortably decode a 1280×900 PNG every 100ms — drop to ~4fps
// on small screens. Desktop stays at ~10fps.
const isMobileViewport = () => window.matchMedia('(max-width: 768px)').matches;
const frameInterval = () => (isMobileViewport() ? 250 : 100);

function startBrowserStream() {
  if (streamActive) return;
  streamActive = true;
  if (browserLoading) browserLoading.style.display = 'flex';
  const fetchFrame = () => {
    if (!streamActive || !sessionId) return;
    const url = `/api/screenshot?sessionId=${encodeURIComponent(sessionId)}&ts=${Date.now()}`;
    const next = document.createElement('img');
    next.onload = () => {
      browserImg.src = next.src;
      if (browserLoading) browserLoading.style.display = 'none';
      streamTimer = setTimeout(fetchFrame, frameInterval());
    };
    next.onerror = () => {
      streamTimer = setTimeout(fetchFrame, 500);
    };
    next.src = url;
  };
  fetchFrame();
}

function stopBrowserStream() {
  streamActive = false;
  if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
}

function imgToViewportCoords(clientX, clientY) {
  const rect = browserImg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const aspect = VIEWPORT_W / VIEWPORT_H;
  const containerAspect = rect.width / rect.height;
  let renderedW, renderedH;
  if (containerAspect > aspect) {
    renderedH = rect.height;
    renderedW = rect.height * aspect;
  } else {
    renderedW = rect.width;
    renderedH = rect.width / aspect;
  }
  const offsetX = (rect.width - renderedW) / 2;
  const offsetY = (rect.height - renderedH) / 2;
  const localX = clientX - rect.left - offsetX;
  const localY = clientY - rect.top - offsetY;
  if (localX < 0 || localX > renderedW || localY < 0 || localY > renderedH) return null;
  return {
    x: (localX / renderedW) * VIEWPORT_W,
    y: (localY / renderedH) * VIEWPORT_H,
  };
}

let inputErrorTimer = null;
async function sendInput(payload) {
  if (!sessionId) return;
  try {
    const res = await fetch('/api/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, ...payload }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throttledInputError(err.error || `Server returned ${res.status}`);
    }
  } catch (e) {
    throttledInputError('Connection lost — input not delivered.');
  }
}

function throttledInputError(message) {
  if (inputErrorTimer) return; // suppress spam from rapid keystrokes
  showToast(message);
  inputErrorTimer = setTimeout(() => { inputErrorTimer = null; }, 2500);
}

let flashTimer = null;
function flashInputBar() {
  if (!browserInput) return;
  browserInput.classList.add('ring-2', 'ring-primary');
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    browserInput.classList.remove('ring-2', 'ring-primary');
  }, 180);
}

function bindBrowserInteractions() {
  if (!browserImg) return;

  const handlePoint = (clientX, clientY) => {
    const pt = imgToViewportCoords(clientX, clientY);
    if (!pt) return;
    sendInput({ type: 'click', x: pt.x, y: pt.y });
    setTimeout(() => browserInput && browserInput.focus({ preventScroll: true }), 30);
  };

  browserImg.addEventListener('click', (e) => {
    e.preventDefault();
    handlePoint(e.clientX, e.clientY);
  });
  browserImg.addEventListener('touchend', (e) => {
    if (!e.changedTouches?.length) return;
    e.preventDefault();
    const t = e.changedTouches[0];
    handlePoint(t.clientX, t.clientY);
  }, { passive: false });

  browserImg.addEventListener('contextmenu', (e) => e.preventDefault());

  // Document-level keydown — catches typing regardless of which element has focus,
  // as long as the embedded-browser stage is visible and the input bar is enabled.
  document.addEventListener('keydown', (e) => {
    if (!stages.browser || stages.browser.classList.contains('hidden')) return;
    if (sidebar && !sidebar.classList.contains('-translate-x-full')) return;
    const inputBar = document.getElementById('browser-input-bar');
    if (inputBar && inputBar.style.display === 'none') return; // disabled during automation

    const target = e.target;
    if (target && target.tagName) {
      const tag = target.tagName.toLowerCase();
      if (tag === 'button' || tag === 'a' || tag === 'select') return;
      if ((tag === 'input' || tag === 'textarea') && target.id !== 'browser-input') return;
    }

    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Unidentified') return;

    const specialKeys = new Set([
      'Enter', 'Tab', 'Backspace', 'Delete',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Escape', 'Home', 'End', 'PageUp', 'PageDown',
    ]);
    if (specialKeys.has(e.key)) {
      e.preventDefault();
      sendInput({ type: 'key', key: e.key });
      flashInputBar();
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      sendInput({ type: 'type', text: e.key });
      flashInputBar();
    }
  });

  // Mobile fallback for virtual keyboards
  browserInput.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'insertText' || e.inputType === 'insertCompositionText') {
      if (e.data) {
        e.preventDefault();
        sendInput({ type: 'type', text: e.data });
        flashInputBar();
      }
    } else if (e.inputType === 'insertFromPaste' || e.inputType === 'insertReplacementText') {
      if (e.data) {
        e.preventDefault();
        sendInput({ type: 'type', text: e.data });
        flashInputBar();
      }
    } else if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward') {
      e.preventDefault();
      sendInput({ type: 'key', key: 'Backspace' });
      flashInputBar();
    } else if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
      e.preventDefault();
      sendInput({ type: 'key', key: 'Enter' });
      flashInputBar();
    }
  });

  // Paste forwarder
  document.addEventListener('paste', (e) => {
    if (!stages.browser || stages.browser.classList.contains('hidden')) return;
    if (sidebar && !sidebar.classList.contains('-translate-x-full')) return;
    const inputBar = document.getElementById('browser-input-bar');
    if (inputBar && inputBar.style.display === 'none') return;

    const target = e.target;
    if (target && target.tagName) {
      const tag = target.tagName.toLowerCase();
      if (tag === 'button' || tag === 'a' || tag === 'select') return;
      if ((tag === 'input' || tag === 'textarea') && target.id !== 'browser-input') return;
    }

    const text = (e.clipboardData || window.clipboardData)?.getData('text');
    if (!text) return;
    e.preventDefault();
    sendInput({ type: 'type', text });
    flashInputBar();
  });

  // Drain any text that lands in the input bar
  browserInput.addEventListener('input', () => {
    if (browserInput.value !== '') browserInput.value = '';
  });

  document.getElementById('key-tab').addEventListener('click', (e) => {
    e.preventDefault();
    sendInput({ type: 'key', key: 'Tab' });
    browserInput.focus({ preventScroll: true });
  });
  document.getElementById('key-enter').addEventListener('click', (e) => {
    e.preventDefault();
    sendInput({ type: 'key', key: 'Enter' });
    browserInput.focus({ preventScroll: true });
  });
  document.getElementById('cancelBrowserBtn').addEventListener('click', cancelSession);
}

async function cancelSession() {
  // Confirm if the user is mid-session in a non-trivial state
  if (sessionId && (currentPhase === 'signin' || currentPhase === 'automating' || currentPhase === 'review')) {
    if (!confirm('Cancel this quiz session? Any unsubmitted answers will be discarded.')) return;
  }
  stopBrowserStream();
  if (!sessionId) {
    window.location.href = '/';
    return;
  }
  try {
    await fetch('/api/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  } catch {}
  if (eventSource) eventSource.close();
  setConnectionStatus('idle');
  window.location.href = '/';
}

// Pause the screenshot stream when the tab is hidden — saves bandwidth on phones
// and prevents Chromium from doing work the user can't see anyway.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopBrowserStream();
    stopScoreStream();
  } else if (currentPhase === 'signin' || currentPhase === 'automating') {
    startBrowserStream();
  }
});

// Warn before closing the tab in the middle of a session.
window.addEventListener('beforeunload', (e) => {
  if (sessionId && (currentPhase === 'signin' || currentPhase === 'automating' || currentPhase === 'review' || currentPhase === 'submitting')) {
    e.preventDefault();
    e.returnValue = '';
  }
});

bindBrowserInteractions();

// ---------------------------------------------------------------------------
// Sidebar (quiz catalog)
// ---------------------------------------------------------------------------

const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');

function openSidebar() {
  sidebar.classList.remove('-translate-x-full');
  sidebarBackdrop.classList.remove('hidden');
  document.body.classList.add('sidebar-open');
  // Two-step opacity so the backdrop fades in
  requestAnimationFrame(() => sidebarBackdrop.classList.remove('opacity-0'));
}
function closeSidebar() {
  sidebar.classList.add('-translate-x-full');
  sidebarBackdrop.classList.add('opacity-0');
  document.body.classList.remove('sidebar-open');
  setTimeout(() => sidebarBackdrop.classList.add('hidden'), 300);
}

document.getElementById('openSidebarBtn')?.addEventListener('click', openSidebar);
document.getElementById('closeSidebarBtn')?.addEventListener('click', closeSidebar);
sidebarBackdrop?.addEventListener('click', closeSidebar);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sidebar.classList.contains('-translate-x-full')) closeSidebar();
});

// (Hint banner replaced with the always-visible scrolling marquee strip at the top of the page.)

const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(message) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.remove('opacity-0');
  toastEl.classList.add('opacity-100');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add('opacity-0');
    toastEl.classList.remove('opacity-100');
  }, 2200);
}

document.querySelectorAll('.quiz-link').forEach((btn) => {
  btn.addEventListener('click', () => {
    const url = btn.dataset.quizUrl;
    const input = document.getElementById('quizUrl');
    if (!input || !url) return;
    input.value = url;
    input.dispatchEvent(new Event('input'));
    input.focus({ preventScroll: true });
    closeSidebar();
    showToast('Quiz URL filled. Add your name and enrollment, then start.');
  });
});

document.querySelectorAll('.quiz-copy').forEach((btn) => {
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const url = btn.dataset.copyUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      const icon = btn.querySelector('.material-symbols-outlined');
      const original = icon.textContent;
      icon.textContent = 'check';
      btn.classList.add('text-primary');
      setTimeout(() => {
        icon.textContent = original;
        btn.classList.remove('text-primary');
      }, 1500);
      showToast('Copied to clipboard');
    } catch (err) {
      showToast('Could not copy: ' + err.message);
    }
  });
});

// ---------------------------------------------------------------------------
// Optional live view of the score page on the done stage
// ---------------------------------------------------------------------------

let scoreStreamActive = false;
let scoreStreamTimer = null;

function startScoreStream() {
  if (scoreStreamActive) return;
  scoreStreamActive = true;
  const img = document.getElementById('score-live-img');
  const tick = () => {
    if (!scoreStreamActive || !sessionId) return;
    const next = new Image();
    next.onload = () => {
      img.src = next.src;
      scoreStreamTimer = setTimeout(tick, 200);
    };
    next.onerror = () => { scoreStreamTimer = setTimeout(tick, 800); };
    next.src = `/api/screenshot?sessionId=${encodeURIComponent(sessionId)}&ts=${Date.now()}`;
  };
  tick();
}

function stopScoreStream() {
  scoreStreamActive = false;
  if (scoreStreamTimer) { clearTimeout(scoreStreamTimer); scoreStreamTimer = null; }
}

const toggleScoreBtn = document.getElementById('toggleScoreLiveBtn');
if (toggleScoreBtn) {
  toggleScoreBtn.addEventListener('click', () => {
    const frame = document.getElementById('score-live-frame');
    const label = document.getElementById('toggleScoreLiveLabel');
    if (frame.classList.contains('hidden')) {
      frame.classList.remove('hidden');
      label.textContent = 'Hide live score page';
      startScoreStream();
    } else {
      frame.classList.add('hidden');
      label.textContent = 'Show live score page';
      stopScoreStream();
    }
  });
}
