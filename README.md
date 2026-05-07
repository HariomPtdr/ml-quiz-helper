# Quiz Helper

A local web tool that runs a headless Chromium on your machine, embeds its live view in your browser, and auto-fills Google Form quizzes from a saved-answer file. Falls back to the Anthropic Claude API only when no saved file matches.

> ⚠️ For your own practice quizzes. Don't use this to submit on behalf of someone else.

## Features

- **Saved-answer files** in `answers/*.json` — fills 20/20 in under a second when the quiz matches.
- **Robust matching** — survives shuffled question/option order, Unicode subscripts (`w₁₁` ↔ `w11`), zero-width characters, dash variants, decimal precision differences. Falls through to a fuzzy fingerprint match (number-sequence + word overlap) when exact text differs slightly.
- **Embedded sign-in flow** — Chromium runs headless on the server, you see the live screenshot inline at ~10 fps, taps and keystrokes forward to the page so Google sign-in works without a separate window.
- **Read-only review screen** with a per-question 4-option breakdown so you can verify before submitting.
- **Score capture** — auto-follows the "View score" link after submission and renders a circular progress ring with the score and percentage. Detects "You've already responded" forms and jumps straight to the score view.
- **Quiz catalog sidebar** — pre-saved quiz URLs grouped by subject + unit. One tap fills the URL field.
- **Admin dashboard** at `/admin` — token-gated. Shows total fills, unique users, average score, per-quiz fill counts, and a searchable submissions table (name, enrollment, quiz, score, timestamp).
- **Mobile-friendly** — viewport meta, touch event handling, body scroll lock, iOS safe-area insets, prefers-reduced-motion respected.

## Setup

```bash
git clone https://github.com/HariomPtdr/ml-quiz-helper.git
cd ml-quiz-helper
npm install
npx playwright install chromium      # one-time
```

Create `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...                      # used only when no saved file matches
ADMIN_TOKEN=<generate a long random hex string>   # for /admin dashboard auth
```

Generate an admin token with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Start the server:

```bash
npm start
```

Open <http://localhost:3000> in your browser. Visit <http://localhost:3000/admin> for the dashboard.

## Adding saved answers for a new quiz

After completing a quiz once and viewing your score, drop a file in `answers/` like:

```json
{
  "name": "Subject — Unit N",
  "answers": [
    { "q": "Which field involves the development of algorithms…?", "a": "Machine Learning (ML)" },
    { "q": "...", "a": "..." }
  ]
}
```

The file watcher hot-reloads in 200 ms — no restart needed. Question text and answer text are normalized (lowercase, punctuation stripped, dashes unified, subscripts mapped to ASCII digits) before comparison, so casual copy-paste from the form usually just works.

## How matching works

1. **Exact match** on normalized question text + normalized answer text.
2. **Fuzzy fallback** — same number sequence + ≥ 70% long-word overlap covers wording variants.
3. **Numeric fallback for answers** — `[0.648, 0.352]` matches `(0.648, 0.352)` or `0.648, 0.352` if the underlying numbers agree (1e-3 tolerance).

If a question has no saved entry **at all**, the server falls back to Claude (with per-question screenshots + web search). If even one saved entry matches, Claude stays out — saving API spend on quizzes you've already verified.

## File layout

```
server.js              Express + Playwright + Anthropic SDK + admin API
public/
  index.html app.js    Main app (live browser, review, done)
  admin.html admin.js  /admin dashboard
  style.css favicon.svg
answers/
  ml-unit-N.json       Saved Q/A entries; hot-reloaded
data/
  submissions.jsonl    Append-only log of every fill (name, enrollment, score)
```

## API surface (admin)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/admin/login` | Body `{token}`. Sets `qh_admin` HttpOnly cookie for 7 days. |
| `POST` | `/api/admin/logout` | Clears the cookie. |
| `GET` | `/api/admin/me` | 200 if cookie matches `ADMIN_TOKEN`, 401 otherwise. |
| `GET` | `/api/admin/submissions` | Latest-first list of all recorded fills. |
| `GET` | `/api/admin/stats` | Aggregates: total, unique users, avg score %, by-quiz, by-enrollment. |

## License

MIT.
