const loginSection = document.getElementById('login-section');
const dashboardSection = document.getElementById('dashboard-section');
const logoutBtn = document.getElementById('logoutBtn');

function show(name) {
  loginSection.classList.toggle('hidden', name !== 'login');
  dashboardSection.classList.toggle('hidden', name !== 'dashboard');
  logoutBtn.classList.toggle('hidden', name !== 'dashboard');
}

async function checkAuth() {
  try {
    const res = await fetch('/api/admin/me');
    if (res.ok) {
      show('dashboard');
      loadDashboard();
      return true;
    }
  } catch {}
  show('login');
  return false;
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const tokenInput = document.getElementById('token-input');
  const errorEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  errorEl.classList.add('hidden');
  btn.disabled = true;
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tokenInput.value }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    tokenInput.value = '';
    show('dashboard');
    loadDashboard();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  show('login');
  document.getElementById('token-input').focus();
});

document.getElementById('refresh-btn').addEventListener('click', loadDashboard);
document.getElementById('search-input').addEventListener('input', () => renderTable(_lastSubmissions));

let _lastSubmissions = [];

async function loadDashboard() {
  try {
    const [statsRes, subsRes] = await Promise.all([
      fetch('/api/admin/stats'),
      fetch('/api/admin/submissions'),
    ]);
    if (!statsRes.ok || !subsRes.ok) throw new Error('Failed to load');
    const stats = await statsRes.json();
    const subs = (await subsRes.json()).submissions || [];
    _lastSubmissions = subs;
    renderStats(stats);
    renderTable(subs);
  } catch (e) {
    console.warn(e);
  }
}

function renderStats(stats) {
  document.getElementById('stat-total').textContent = stats.total ?? 0;
  document.getElementById('stat-unique').textContent = stats.uniqueUsers ?? 0;
  document.getElementById('stat-quizzes').textContent = Object.keys(stats.byQuiz || {}).length;
  const avg = stats.averagePercentage;
  document.getElementById('stat-avg').textContent = avg != null && Number.isFinite(avg) ? `${avg.toFixed(1)}%` : '—';

  const wrap = document.getElementById('quiz-breakdown');
  wrap.innerHTML = '';
  const entries = Object.entries(stats.byQuiz || {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    wrap.innerHTML = '<p class="text-sm text-on-surface-variant font-light">No quizzes filled yet.</p>';
    return;
  }
  const max = entries[0][1];
  for (const [name, count] of entries) {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-3';
    const label = document.createElement('div');
    label.className = 'flex-1 min-w-0 text-sm truncate';
    label.textContent = name || '(unnamed)';
    const bar = document.createElement('div');
    bar.className = 'flex-1 h-2 bg-surface-container-low rounded-full overflow-hidden';
    const fill = document.createElement('div');
    fill.className = 'h-full bg-primary rounded-full transition-all';
    fill.style.width = `${(count / max) * 100}%`;
    bar.appendChild(fill);
    const num = document.createElement('div');
    num.className = 'text-sm font-medium font-headline w-10 text-right';
    num.textContent = String(count);
    row.appendChild(label);
    row.appendChild(bar);
    row.appendChild(num);
    wrap.appendChild(row);
  }
}

function renderTable(subs) {
  const tbody = document.getElementById('submissions-tbody');
  const search = document.getElementById('search-input').value.trim().toLowerCase();
  const filtered = search
    ? subs.filter(s =>
        (s.name || '').toLowerCase().includes(search) ||
        (s.enrollment || '').toLowerCase().includes(search))
    : subs;
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-on-surface-variant py-12 font-light">${subs.length === 0 ? 'No submissions yet. Run a quiz from the main app.' : 'No matches.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  for (const s of filtered) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><div class="text-on-surface-variant text-xs font-mono">${formatTime(s.ts)}</div></td>
      <td><div class="font-medium">${escapeHtml(s.name || '—')}</div></td>
      <td><div class="font-mono text-xs">${escapeHtml(s.enrollment || '—')}</div></td>
      <td><div class="truncate max-w-[200px]">${escapeHtml(s.quizName || urlTail(s.quizUrl))}</div></td>
      <td class="text-right">
        ${s.score && s.total
          ? `<span class="font-headline font-medium text-primary">${s.score}/${s.total}</span>`
          : '<span class="text-on-surface-variant text-xs">—</span>'}
      </td>
      <td>
        ${s.alreadySubmitted
          ? '<span class="inline-block px-2 py-0.5 rounded-full bg-surface-container text-xs font-label tracking-wide">already submitted</span>'
          : '<span class="inline-block px-2 py-0.5 rounded-full bg-primary-fixed text-on-primary-fixed text-xs font-label tracking-wide">submitted</span>'}
      </td>
    `;
    tbody.appendChild(tr);
  }
}

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `Today ${time}`;
  return `${d.toLocaleDateString()} ${time}`;
}

function urlTail(u) {
  if (!u) return '—';
  const m = u.match(/forms\/d\/e\/([^/]+)/);
  return m ? `…${m[1].slice(-12)}` : u.slice(0, 50);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

checkAuth();
