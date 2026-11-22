# PitchPulse Quant

An experimental live-soccer analysis app. It scrapes live match data, estimates match-outcome probabilities
from in-play flow (shots, corners, possession, form) with a Poisson model, compares them with scraped
bookmaker odds, and flags apparent "+EV" prices. It can notify you in the browser or, with a server push
setup, in the background.

> **Not betting advice.** The model's probabilities have **not** been shown to be calibrated or to beat
> bookmaker prices. Flagged edges are estimates built on unofficial, sometimes stale data. Betting carries
> a real risk of loss. See [Limitations](#limitations).

## Stack

React 19 + Vite + Tailwind (PWA) · Express 4 server · Firebase Auth/Firestore (optional sync) ·
`web-push` (VAPID) · Gemini via `@google/genai` (optional AI briefs) · TypeScript (strict) · `node:test`.

## Quick start

Requires Node `^20.19 || >=22.12`.

```bash
npm install
cp .env.example .env     # fill in what you need; the app runs without any keys
npm run dev              # http://localhost:3000 (Express + Vite middleware)
```

Production:

```bash
npm run build            # client -> dist/, server -> dist-server/server.js
npm start                # node dist-server/server.js
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server with Vite middleware |
| `npm run build` / `npm start` | Production build / run |
| `npm run lint` | Type-check (`tsc --noEmit`, strict) |
| `npm test` | Unit and server tests (scraper, security, push, app routes, evaluation, pipeline) |
| `npm run test:rules` | Firestore security-rules tests (need the emulator; skipped otherwise) |
| `npm run collect:history -- --days 90` | Download finished matches to `data/history.json` |
| `npm run record:live` | Log live matches **and odds** to `data/live-log.jsonl` |
| `npm run backtest` | Compare the model with baselines on a chronological hold-out |
| `npm run fit -- --write` | Fit structural parameters; only saved if they beat defaults and baselines on held-out data |

Rules tests: `npx firebase-tools emulators:exec --only firestore --project demo-ppq "npm run test:rules"`
(needs Java). CI runs everything in `.github/workflows/ci.yml`.

## Configuration

See `.env.example` for all variables. The important ones:

- `GEMINI_API_KEY`, `FIREBASE_API_KEY`: AI briefs need both. The brief endpoint requires a signed-in
  user's Firebase ID token and is limited by `AI_DAILY_LIMIT_GLOBAL` / `AI_DAILY_LIMIT_PER_USER`.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`: background push. In production the push
  endpoints return 503 until the keys are set (ephemeral keys are never generated in production).
- `PUSH_STORE_PATH`: subscriptions are stored in a JSON file. On hosts with an ephemeral filesystem
  (many PaaS/containers) mount a persistent volume or subscriptions are lost on restart.
- `TRUST_PROXY`: number of proxies in front of the app so rate limits see real client IPs (default 1 in production).
- `PUSH_ENDPOINT_ALLOWLIST`: extra push-service hosts. Only known push services are accepted by default,
  which prevents the subscribe endpoint being used for server-side request forgery.
- `GEMINI_MODEL`: defaults to `gemini-3.8-flash`; verify the ID against the current Gemini docs.

## Security notes

- Per-route rate limits, request-size limits, and generic upstream error messages.
- Push endpoints are validated against an allowlist; `/api/push/test` only targets the caller's own endpoint.
- AI briefs require a verified Firebase sign-in and a daily budget.
- Firestore rules default-deny and validate every document shape (`firestore.rules`).

## Data sources and terms

Live data comes from ESPN's unofficial public scoreboard/summary JSON and a BBC page scrape. These are
not licensed APIs and may change or be restricted at any time. **Review the providers' terms of use, or
move to a licensed data provider, before any public or commercial deployment.** This review has not been
done as part of this repository's work.

## Limitations

- The model's constants (base goal rates, shot/corner/possession/form coefficients) are hand-chosen.
  `src/engine/fittedParams.json` is `fitted: false` until you collect data and run `npm run fit`.
- No backtest results are committed. Run `collect:history` + `backtest` yourself; the report states when a
  sample is too small to judge. The Learning tab shows Brier skill against a uniform guess for the same reason.
- Historical odds are unavailable from the feed, so the "edge" claim can only be tested from odds you
  record yourself (`record:live`).
- Odds are used for +EV flags only when marked verified-live (default; you can opt out in the UI).
- The model can saturate its intensity clamp in lively early-match situations, inflating goal expectations;
  treat extreme outputs sceptically.

## Project layout

```
src/engine/      probability model, evaluation metrics, value detection, paper ledger
src/hooks/       state hooks (auth, live feed, learning, ledger, alerts, push, AI briefs)
src/components/  UI (lazy-loaded Alerts/Learning/Methodology views)
server/          Express app, scraper, push service, security helpers (+ tests)
scripts/         data collection, backtest and fitting CLIs
firestore.rules  security rules (tested in tests/rules)
```
