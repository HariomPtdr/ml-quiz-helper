const express = require('express');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json({ limit: '2mb' }));

// Request log for /api/* so we can trace what the client is doing.
app.use('/api', (req, res, next) => {
  console.log(`[req] ${req.method} ${req.originalUrl}`);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Pretty URL for the admin dashboard.
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// In-memory session state. Keyed by sessionId, expired after 30 min idle.
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

function newSessionId() {
  return 'qs_' + Math.random().toString(36).slice(2, 12);
}

function getSession(id) {
  const s = sessions.get(id);
  if (!s) return null;
  s.lastTouch = Date.now();
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastTouch > SESSION_TTL_MS) {
      try { s.browser?.close(); } catch {}
      sessions.delete(id);
    }
  }
}, 60_000).unref();

// SSE helper
function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function pushStatus(session, message) {
  session.statusLog.push({ ts: Date.now(), message });
  if (session.sse) sseSend(session.sse, 'status', { message });
}

// ---------------------------------------------------------------------------
// Saved answer cache (loaded from /answers/*.json, hot-reloaded on file changes)
// ---------------------------------------------------------------------------

// Pre-clean text: strip zero-width chars and convert unicode subscripts/superscripts/dashes
// to their ASCII equivalents. Run before any matching or number extraction so forms that
// render `w₁₁` or `a₁` end up indistinguishable from saved files written as `w11` and `a1`.
const SUBSCRIPT_MAP = { '₀':'0','₁':'1','₂':'2','₃':'3','₄':'4','₅':'5','₆':'6','₇':'7','₈':'8','₉':'9' };
const SUPERSCRIPT_MAP = { '⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9' };
function cleanText(s) {
  if (!s) return '';
  return String(s)
    .replace(/[​-‍﻿]/g, '')              // zero-width: ZWSP/ZWNJ/ZWJ/BOM
    .replace(/[‐‑‒–—―−]/g, '-')                          // unicode dashes → ASCII hyphen
    .replace(/[₀-₉]/g, (c) => SUBSCRIPT_MAP[c] || c)
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => SUPERSCRIPT_MAP[c] || c);
}

function normalizeText(s) {
  if (!s) return '';
  return cleanText(s)
    .toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/[^a-z0-9 \-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ANSWERS_DIR = path.join(__dirname, 'answers');
let savedAnswersMap = new Map();

function loadSavedAnswers() {
  const map = new Map();
  if (!fs.existsSync(ANSWERS_DIR)) return map;
  for (const file of fs.readdirSync(ANSWERS_DIR).filter((f) => f.endsWith('.json'))) {
    try {
      const raw = fs.readFileSync(path.join(ANSWERS_DIR, file), 'utf8');
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : data.answers;
      if (!Array.isArray(arr)) continue;
      let n = 0;
      for (const item of arr) {
        if (item && item.q && item.a) {
          map.set(normalizeText(item.q), { answer: item.a, source: file, originalQ: item.q });
          n++;
        }
      }
      console.log(`[answers] loaded ${file}: ${n} entries`);
    } catch (e) {
      console.warn(`[answers] failed to load ${file}: ${e.message}`);
    }
  }
  return map;
}

savedAnswersMap = loadSavedAnswers();
console.log(`[answers] total saved answers: ${savedAnswersMap.size}`);

if (fs.existsSync(ANSWERS_DIR)) {
  let reloadTimer = null;
  fs.watch(ANSWERS_DIR, (event, file) => {
    if (!file || !file.endsWith('.json')) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      savedAnswersMap = loadSavedAnswers();
      console.log(`[answers] reloaded — total ${savedAnswersMap.size}`);
    }, 200);
  });
}

function extractNumbers(s) {
  if (!s) return [];
  const m = cleanText(s).match(/-?\d+(?:\.\d+)?/g);
  return m ? m.map(Number) : [];
}

// ---------------------------------------------------------------------------
// Submission log + admin API
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, 'data');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.jsonl');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function recordSubmission(rec) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n';
    fs.appendFileSync(SUBMISSIONS_FILE, line);
    console.log(`[admin] recorded submission: name=${rec.name} enrollment=${rec.enrollment} score=${rec.score ?? '-'}/${rec.total ?? '-'} alreadySubmitted=${!!rec.alreadySubmitted}`);
  } catch (e) {
    console.warn(`[admin] failed to record submission: ${e.message}`);
  }
}

function readSubmissions() {
  if (!fs.existsSync(SUBMISSIONS_FILE)) return [];
  const raw = fs.readFileSync(SUBMISSIONS_FILE, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function getCookie(req, name) {
  const c = req.headers.cookie || '';
  const m = c.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || expected === 'change-me-to-a-long-random-string') {
    return res.status(503).json({ error: 'ADMIN_TOKEN not configured in .env' });
  }
  const provided = getCookie(req, 'qh_admin');
  if (provided !== expected) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.post('/api/admin/login', express.json(), (req, res) => {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || expected === 'change-me-to-a-long-random-string') {
    return res.status(503).json({ error: 'ADMIN_TOKEN not configured in .env' });
  }
  const { token } = req.body || {};
  if (!token || token !== expected) return res.status(401).json({ error: 'Invalid token' });
  res.setHeader('Set-Cookie', `qh_admin=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${7 * 24 * 60 * 60}; SameSite=Lax`);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'qh_admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

app.get('/api/admin/submissions', requireAdmin, (req, res) => {
  const list = readSubmissions().sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  res.json({ submissions: list });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const list = readSubmissions();
  const byEnrollment = {};
  const byQuiz = {};
  let totalScore = 0, totalMax = 0, scoredCount = 0;
  for (const r of list) {
    if (r.enrollment) byEnrollment[r.enrollment] = (byEnrollment[r.enrollment] || 0) + 1;
    const k = r.quizName || r.quizUrl || 'unknown';
    byQuiz[k] = (byQuiz[k] || 0) + 1;
    if (r.score && r.total) {
      const s = parseFloat(r.score), t = parseFloat(r.total);
      if (Number.isFinite(s) && Number.isFinite(t) && t > 0) {
        totalScore += s; totalMax += t; scoredCount++;
      }
    }
  }
  res.json({
    total: list.length,
    uniqueUsers: Object.keys(byEnrollment).length,
    byEnrollment,
    byQuiz,
    averagePercentage: scoredCount > 0 ? (totalScore / totalMax) * 100 : null,
    scoredCount,
  });
});

// ---------------------------------------------------------------------------

function findSavedAnswer(question) {
  const qNorm = normalizeText(question.text);
  let entry = savedAnswersMap.get(qNorm);

  // Fuzzy question-text fallback: find a saved entry whose normalized question
  // shares >=70% of its long words AND whose number sequence is identical.
  if (!entry) {
    const qWords = new Set(qNorm.split(' ').filter((w) => w.length > 3));
    const qNums = extractNumbers(question.text);
    let best = null;
    let bestScore = 0;
    for (const [savedNorm, candidate] of savedAnswersMap) {
      const savedNums = extractNumbers(candidate.originalQ || '');
      if (savedNums.length !== qNums.length) continue;
      const numsEqual = qNums.every((n, i) => Math.abs(n - savedNums[i]) < 1e-3);
      if (!numsEqual) continue;
      const savedWords = new Set(savedNorm.split(' ').filter((w) => w.length > 3));
      if (savedWords.size === 0 || qWords.size === 0) continue;
      let common = 0;
      for (const w of qWords) if (savedWords.has(w)) common++;
      const score = common / Math.max(qWords.size, savedWords.size);
      if (score > bestScore && score >= 0.7) {
        bestScore = score;
        best = candidate;
      }
    }
    if (best) entry = best;
  }

  if (!entry) return { match: null, status: 'no-question' };

  // Pass 1: exact text match (after normalization)
  const target = normalizeText(entry.answer);
  let match = question.options.find((o) => normalizeText(o) === target);

  // Pass 2: numeric fallback — for calc-style answers like "[0.648, 0.352]" or "0.635"
  // where the form's option text might have different formatting (brackets, separators,
  // approximation symbols, trailing units) but the same numbers in the same order.
  if (!match) {
    const targetNums = extractNumbers(entry.answer);
    if (targetNums.length > 0) {
      match = question.options.find((o) => {
        const nums = extractNumbers(o);
        if (nums.length !== targetNums.length) return false;
        return nums.every((n, i) => Math.abs(n - targetNums[i]) < 1e-3);
      });
    }
  }

  if (!match) {
    return { match: null, status: 'answer-mismatch', savedAnswer: entry.answer, source: entry.source };
  }
  return { match, status: 'matched' };
}

// ---------------------------------------------------------------------------
// Playwright orchestration
// ---------------------------------------------------------------------------

const VIEWPORT_W = 1280;
const VIEWPORT_H = 900;

function emitPhase(session, phase) {
  session.phase = phase;
  if (session.sse) sseSend(session.sse, 'phase', { phase });
}

async function launchAndDrive(session) {
  const { quizUrl, name, enrollment } = session.input;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let browser, ctx, page;
  try {
    pushStatus(session, 'Launching headless browser…');
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    ctx = await browser.newContext({
      viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    });
    page = await ctx.newPage();
    session.browser = browser;
    session.page = page;

    // Notify the client if Chromium itself dies — otherwise the user just sees the live view freeze.
    browser.on('disconnected', () => {
      if (sessions.has(session.id)) {
        pushStatus(session, 'Browser process disconnected unexpectedly.');
        if (session.sse) sseSend(session.sse, 'error', { message: 'Headless Chromium crashed or was killed. Please start a new session.' });
        sessions.delete(session.id);
      }
    });
    page.on('crash', () => {
      if (session.sse) sseSend(session.sse, 'error', { message: 'The page crashed. Please start a new session.' });
    });

    pushStatus(session, 'Opening quiz URL. Sign in to Google in the embedded view.');
    emitPhase(session, 'signin');

    await page.goto(quizUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/docs\.google\.com\/forms\/.+\/viewform/, { timeout: 10 * 60 * 1000 });
    await page.waitForTimeout(2500);

    emitPhase(session, 'automating');
    pushStatus(session, 'On form. Checking page state.');

    // Detect already-submitted state ("You've already responded") and short-circuit to score view.
    const initialBody = await page.locator('body').innerText().catch(() => '');
    const alreadyResponded = /you'?ve already responded|you can fill out this form only once|already submitted this form/i.test(initialBody);
    console.log(`[diag] alreadyResponded=${alreadyResponded}; bodyPreview="${initialBody.slice(0, 200).replace(/\s+/g, ' ')}"`);
    if (alreadyResponded) {
      pushStatus(session, 'Form already submitted. Fetching score directly.');
      console.log('[diag] entered already-submitted branch');
      let score = null, total = null, scoreUrl = null;
      try {
        const viewScore = page.locator('a, button').filter({ hasText: /view\s*score/i }).first();
        if (await viewScore.count()) {
          const href = await viewScore.getAttribute('href').catch(() => null);
          if (href && /^https?:\/\//.test(href)) {
            await page.goto(href, { waitUntil: 'domcontentloaded' });
          } else {
            await viewScore.click();
          }
          await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
          await page.waitForTimeout(2000);
          scoreUrl = page.url();

          const txt = await page.locator('body').innerText();
          const patterns = [
            /total\s+points?\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/i,
            /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s+points?/i,
            /score\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/i,
            /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/,
          ];
          for (const p of patterns) {
            const m = txt.match(p);
            if (m) { score = m[1]; total = m[2]; break; }
          }
          pushStatus(session, score ? `Score: ${score} / ${total}` : 'Score page loaded but score number could not be parsed.');
        } else {
          pushStatus(session, 'No "View score" link on the already-responded page (score may not be released yet).');
        }
      } catch (e) {
        pushStatus(session, `Score fetch failed: ${e.message}`);
      }

      const finalUrl = page.url();
      const finalBody = (await page.locator('body').innerText().catch(() => '')).slice(0, 1500);
      emitPhase(session, 'done');
      recordSubmission({
        name: session.input.name,
        enrollment: session.input.enrollment,
        quizUrl: session.input.quizUrl,
        quizName: session.heading || '',
        score, total,
        percentage: (score && total) ? (parseFloat(score) / parseFloat(total)) * 100 : null,
        alreadySubmitted: true,
      });
      if (session.sse) {
        sseSend(session.sse, 'done', { url: finalUrl, body: finalBody, score, total, scoreUrl, alreadySubmitted: true });
      }
      // Keep browser alive 5 min so user can use the live-view toggle on the done stage.
      setTimeout(async () => {
        try { await session.browser?.close(); } catch {}
        sessions.delete(session.id);
      }, 5 * 60 * 1000);
      return;
    }

    pushStatus(session, 'Form is fillable. Looking at the structure.');
    const inputs = await page.locator('div[role="listitem"]').locator('input:not([type="hidden"]), textarea').all();
    if (inputs.length >= 2) {
      pushStatus(session, `Filling 2 ID fields (found ${inputs.length} text inputs).`);
      // Heuristic: first input = enrollment, second = name
      await inputs[0].fill(enrollment);
      await inputs[1].fill(name);
    } else if (inputs.length === 1) {
      pushStatus(session, `Only 1 text input on page 1 — filling with enrollment.`);
      await inputs[0].fill(enrollment);
    } else {
      pushStatus(session, 'No text inputs detected on the current page — skipping ID fill.');
    }

    // Already-on-questions case: maybe single-page form. Otherwise click Next.
    let radioCount = await page.locator('div[role="radio"]').count();
    if (radioCount === 0) {
      const nextBtn = page.getByRole('button', { name: /^Next$/ });
      if (await nextBtn.count()) {
        pushStatus(session, 'Clicking Next to load questions.');
        await nextBtn.click();
        try {
          await page.locator('div[role="radio"]').first().waitFor({ timeout: 45_000 });
        } catch (e) {
          const url = page.url();
          const heading = await page.locator('div[role="heading"]').first().innerText().catch(() => '');
          const bodyPreview = (await page.locator('body').innerText().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ');
          throw new Error(`No radio questions appeared after Next (45s). URL=${url}. Heading="${heading}". Body preview: "${bodyPreview}". This form may use checkboxes/dropdowns or a layout this tool doesn't yet support.`);
        }
      } else {
        const url = page.url();
        const bodyPreview = (await page.locator('body').innerText().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ');
        throw new Error(`No radio questions and no Next button on this page. URL=${url}. Body preview: "${bodyPreview}".`);
      }
      await page.waitForTimeout(1500);
      radioCount = await page.locator('div[role="radio"]').count();
    } else {
      pushStatus(session, `Single-page form detected — ${radioCount} radio options already on this page.`);
    }
    pushStatus(session, 'Capturing questions.');

    const heading = await page.locator('div[role="heading"]').first().innerText().catch(() => '');
    session.heading = heading;

    const items = await page.locator('div[role="listitem"]').all();
    const questions = [];
    const questionShots = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const radios = await item.locator('div[role="radio"]').all();
      if (radios.length === 0) continue; // section headers etc.
      const fullText = (await item.innerText()).trim();
      const options = [];
      for (const r of radios) options.push(await r.getAttribute('aria-label'));
      const cleanText = fullText
        .replace(/\n\*\n/, '\n')
        .replace(/\n1 point\n/g, '\n')
        .split('\n').slice(0, -options.length).join('\n').trim();

      // Capture a per-question screenshot so Claude sees the real layout, math, code, etc.
      let shot = null;
      try {
        await item.scrollIntoViewIfNeeded();
        const buf = await item.screenshot({ type: 'jpeg', quality: 85 });
        shot = buf.toString('base64');
      } catch {}

      questions.push({
        index: questions.length,
        text: cleanText || fullText,
        options,
      });
      questionShots.push(shot);
    }
    if (questions.length === 0) throw new Error('No radio-button questions captured on page 2');
    session.questions = questions;
    pushStatus(session, `Captured ${questions.length} questions.`);

    let suggestedAnswers = questions.map(() => null);

    // Pass 1: try to fill from saved answer files.
    let savedHits = 0;
    const mismatches = [];
    for (let i = 0; i < questions.length; i++) {
      const result = findSavedAnswer(questions[i]);
      if (result.match) {
        suggestedAnswers[i] = result.match;
        savedHits++;
      } else if (result.status === 'answer-mismatch') {
        mismatches.push({ i, savedAnswer: result.savedAnswer, source: result.source, options: questions[i].options });
        console.log(`[answers] Q${i + 1} matched in ${result.source} but saved answer "${result.savedAnswer}" is not in this form's options.\n  options: ${JSON.stringify(questions[i].options)}`);
      }
    }
    pushStatus(session, `Filled ${savedHits} / ${questions.length} from saved answers files.`);
    for (const m of mismatches) {
      const optsPreview = m.options.map((o) => `"${o}"`).join(' | ');
      pushStatus(session, `Q${m.i + 1}: saved answer "${m.savedAnswer}" (from ${m.source}) doesn't match any option. Form options: ${optsPreview}`);
    }

    const missingIdx = questions.map((_, i) => i).filter((i) => !suggestedAnswers[i]);
    if (missingIdx.length === 0) {
      pushStatus(session, 'All answers came from the saved files.');
    } else if (savedHits === 0) {
      // No saved entry matched any question on this quiz — assume it's a brand-new quiz and let Claude handle the whole thing.
      if (apiKey && apiKey.trim() && apiKey.trim() !== 'sk-ant-REPLACE_ME') {
        pushStatus(session, `No saved file matched this quiz — falling back to Claude for all ${questions.length} questions.`);
        try {
          const cAnswers = await getClaudeAnswers(apiKey.trim(), heading, questions, questionShots);
          suggestedAnswers = cAnswers;
          pushStatus(session, 'Claude returned the answers. Save them to /answers/*.json afterwards if you want to skip Claude next time.');
        } catch (e) {
          pushStatus(session, `Claude call failed (${e.message}). Questions remain unanswered.`);
        }
      } else {
        pushStatus(session, 'No saved answers and no Claude API key — quiz cannot be answered automatically.');
      }
    } else {
      // Partial saved-file match — stay in saved-only mode, leave the rest unanswered.
      pushStatus(session, `${missingIdx.length} question${missingIdx.length === 1 ? '' : 's'} not in saved files — left unanswered. Add to /answers/*.json to fill them in.`);
    }
    session.suggestedAnswers = suggestedAnswers;

    if (session.sse) {
      sseSend(session.sse, 'review', {
        heading,
        questions,
        suggestedAnswers,
      });
    }
    emitPhase(session, 'review');
  } catch (err) {
    pushStatus(session, `ERROR: ${err.message}`);
    if (session.sse) sseSend(session.sse, 'error', { message: err.message });
    try { await browser?.close(); } catch {}
    sessions.delete(session.id);
  }
}

// ---------------------------------------------------------------------------
// Claude API
// ---------------------------------------------------------------------------

async function getClaudeAnswers(apiKey, heading, questions, screenshots = []) {
  const client = new Anthropic({ apiKey });

  // Build a Zod schema with one field per question, constrained to its options
  const shape = {};
  questions.forEach((q, i) => {
    shape[`q${i}`] = z.enum(q.options).describe(`Selected option for: ${q.text.slice(0, 80)}`);
  });
  const Schema = z.object(shape);

  const systemPrompt = [
    'You are an expert solving a multiple-choice quiz where every wrong answer costs points. Accuracy matters — work each question carefully and methodically.',
    '',
    'For every question, follow this procedure:',
    '1. Read both the text AND its screenshot. The screenshot is authoritative when the two differ — it preserves math symbols, code formatting, subscripts, special characters, and visual layout that text scraping loses.',
    '2. Identify exactly what concept, formula, fact, or operation is being tested.',
    '3. Solve the problem from first principles or recall the fact independently — do NOT let the option phrasing bias your reasoning. Form your own answer first.',
    '4. Compare your independent answer to each option. Eliminate options that are wrong, ill-defined, or only superficially correct.',
    '5. Among remaining options, pick the most technically precise one — the option an expert writer would have intended as correct.',
    '6. If a fact is uncertain, ambiguous, or potentially recent, use the web_search tool to verify BEFORE committing. Prefer authoritative sources (textbooks, official docs, standards bodies, RFCs, peer-reviewed papers) over forum posts.',
    '7. For numeric questions, redo the arithmetic step by step. Do not round prematurely. Watch for unit mismatches.',
    '8. For "which is true / NOT true / EXCEPT / always / never" questions, evaluate every option independently before picking; these are designed to catch shallow reading.',
    '9. For code or algorithm questions, mentally trace execution; do not pattern-match on superficial similarity.',
    '',
    'Return exactly one option string per question, copied verbatim from the provided choices. Never invent text outside the provided options.',
  ].join('\n');

  const userContent = [];
  userContent.push({ type: 'text', text: heading ? `Quiz: ${heading}\n\nThere are ${questions.length} questions. Solve each one carefully using the procedure above.` : `${questions.length} questions follow.` });
  questions.forEach((q, i) => {
    const optionLines = q.options.map((o, j) => `  ${String.fromCharCode(65 + j)}) ${o}`).join('\n');
    userContent.push({
      type: 'text',
      text: `\n--- Question ${i + 1} ---\n${q.text}\n\nOptions:\n${optionLines}`,
    });
    if (screenshots[i]) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: screenshots[i] },
      });
    }
  });
  userContent.push({ type: 'text', text: '\n\nNow output the structured answers — one verbatim option per question.' });

  const response = await client.messages.parse({
    model: 'claude-opus-4-7',
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: zodOutputFormat(Schema) },
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 12 }],
    system: [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userContent }],
  });

  const parsed = response.parsed_output;
  if (!parsed) throw new Error('Claude returned no parseable output');
  return questions.map((_, i) => parsed[`q${i}`]);
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

async function submitAnswers(session, finalAnswers) {
  const { page } = session;
  const items = await page.locator('div[role="listitem"]').all();
  const matched = [];
  let qIdx = 0;
  for (const item of items) {
    const radios = await item.locator('div[role="radio"]').count();
    if (radios === 0) continue;
    const answer = finalAnswers[qIdx++];
    if (!answer) continue;
    const target = item.locator(`div[role="radio"][aria-label="${answer.replace(/"/g, '\\"')}"]`);
    if (await target.count() === 0) {
      throw new Error(`Could not locate option "${answer}" for question ${qIdx}`);
    }
    await target.first().click();
    matched.push(qIdx);
  }
  pushStatus(session, `Filled ${matched.length} answers. Submitting.`);
  const submitBtn = page.getByRole('button', { name: /^Submit$/ });
  const nextBtn = page.getByRole('button', { name: /^Next$/ });
  if (await submitBtn.count()) {
    await submitBtn.click();
  } else if (await nextBtn.count()) {
    await nextBtn.click();
    await page.waitForTimeout(2500);
    const submitBtn2 = page.getByRole('button', { name: /^Submit$/ });
    if (await submitBtn2.count()) await submitBtn2.click();
  } else {
    throw new Error('Could not find Submit or Next button');
  }
  await page.waitForTimeout(5000);

  // Try to follow the "View score" link to extract the actual score.
  let score = null;
  let total = null;
  let scoreUrl = null;
  try {
    const viewScore = page.locator('a, button').filter({ hasText: /view\s*score/i }).first();
    if (await viewScore.count()) {
      pushStatus(session, 'Opening "View score"…');
      const href = await viewScore.getAttribute('href').catch(() => null);
      if (href && /^https?:\/\//.test(href)) {
        await page.goto(href, { waitUntil: 'domcontentloaded' });
      } else {
        await viewScore.click();
      }
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(2000);
      scoreUrl = page.url();

      const bodyText = await page.locator('body').innerText();
      const patterns = [
        /total\s+points?\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/i,
        /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s+points?/i,
        /score\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/i,
        /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/,
      ];
      for (const p of patterns) {
        const m = bodyText.match(p);
        if (m) { score = m[1]; total = m[2]; break; }
      }
      pushStatus(session, score ? `Score: ${score} / ${total}` : 'Score page loaded but score number could not be parsed.');
    } else {
      pushStatus(session, 'No "View score" link on confirmation page — score may not be released yet.');
    }
  } catch (e) {
    pushStatus(session, `Score fetch failed: ${e.message}`);
  }

  const url = page.url();
  const body = (await page.locator('body').innerText()).slice(0, 1500);
  return { url, body, score, total, scoreUrl };
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

app.post('/api/start', (req, res) => {
  const { quizUrl, name, enrollment } = req.body || {};
  if (!quizUrl || !name || !enrollment) {
    return res.status(400).json({ error: 'quizUrl, name, and enrollment are required' });
  }
  const id = newSessionId();
  const session = {
    id,
    input: { quizUrl, name, enrollment },
    phase: 'launching',
    heading: '',
    statusLog: [],
    questions: null,
    suggestedAnswers: null,
    browser: null,
    page: null,
    sse: null,
    lastTouch: Date.now(),
  };
  sessions.set(id, session);
  // Don't await — drive the browser in the background
  launchAndDrive(session);
  res.json({ sessionId: id });
});

app.get('/api/events', (req, res) => {
  const id = req.query.sessionId;
  const session = getSession(id);
  if (!session) return res.status(404).end();
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  session.sse = res;
  // Replay status log + phase
  for (const entry of session.statusLog) sseSend(res, 'status', { message: entry.message });
  if (session.phase) sseSend(res, 'phase', { phase: session.phase });
  if (session.phase === 'review') {
    sseSend(res, 'review', {
      heading: session.heading,
      questions: session.questions,
      suggestedAnswers: session.suggestedAnswers,
    });
  }
  req.on('close', () => {
    if (session.sse === res) session.sse = null;
  });
});

app.get('/api/screenshot', async (req, res) => {
  const session = getSession(req.query.sessionId);
  if (!session?.page) return res.status(404).end();
  try {
    // Page may close mid-screenshot if browser crashed — guard with isClosed.
    if (session.page.isClosed?.()) return res.status(410).end();
    const buf = await session.page.screenshot({ type: 'jpeg', quality: 65, fullPage: false, timeout: 5000 });
    res.set({
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    });
    res.send(buf);
  } catch (e) {
    // Don't crash the polling loop on transient failures
    res.status(503).json({ error: e.message });
  }
});

app.post('/api/input', async (req, res) => {
  const { sessionId, type, x, y, text, key, deltaY } = req.body || {};
  const session = getSession(sessionId);
  if (!session?.page) return res.status(404).json({ error: 'no session' });
  try {
    const page = session.page;
    if (type === 'click') {
      const cx = Math.max(0, Math.min(VIEWPORT_W, Number(x)));
      const cy = Math.max(0, Math.min(VIEWPORT_H, Number(y)));
      await page.mouse.click(cx, cy, { delay: 30 });
    } else if (type === 'type') {
      await page.keyboard.type(String(text || ''), { delay: 8 });
    } else if (type === 'key') {
      await page.keyboard.press(String(key || ''));
    } else if (type === 'scroll') {
      await page.mouse.wheel(0, Number(deltaY) || 0);
    } else {
      return res.status(400).json({ error: 'unknown input type' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/submit', async (req, res) => {
  const { sessionId, answers } = req.body || {};
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.phase !== 'review') return res.status(400).json({ error: `Cannot submit in phase ${session.phase}` });
  if (!Array.isArray(answers) || answers.length !== session.questions.length) {
    return res.status(400).json({ error: 'answers length must match questions length' });
  }
  session.phase = 'submitting';
  try {
    const result = await submitAnswers(session, answers);
    pushStatus(session, 'Submitted.');
    recordSubmission({
      name: session.input.name,
      enrollment: session.input.enrollment,
      quizUrl: session.input.quizUrl,
      quizName: session.heading || '',
      score: result.score,
      total: result.total,
      percentage: (result.score && result.total) ? (parseFloat(result.score) / parseFloat(result.total)) * 100 : null,
      alreadySubmitted: false,
    });
    if (session.sse) sseSend(session.sse, 'done', result);
    res.json({ ok: true, ...result });
    // Keep browser alive for 5 min so the user can view the score page in the live view if they want.
    setTimeout(async () => {
      try { await session.browser?.close(); } catch {}
      sessions.delete(session.id);
    }, 5 * 60 * 1000);
  } catch (err) {
    pushStatus(session, `Submit failed: ${err.message}`);
    if (session.sse) sseSend(session.sse, 'error', { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cancel', async (req, res) => {
  const { sessionId } = req.body || {};
  const session = sessionId ? sessions.get(sessionId) : null;
  if (session) {
    try { await session.browser?.close(); } catch {}
    sessions.delete(sessionId);
  }
  // Idempotent — also OK if session was already gone.
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Quiz Helper running at http://localhost:${PORT}`);
});
