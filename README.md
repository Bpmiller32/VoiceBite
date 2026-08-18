# VoiceBite

Talk about what you ate; get accurate calorie and nutrient tracking without the tedium of
searching a food database. Claude parses plain language ("for breakfast I had a banana, for
lunch a Chipotle bowl") into structured entries with full macro and micronutrient data.

**Live: [voicebite.web.app](https://voicebite.web.app)** — signed out it runs on synthetic
data generated in your browser, so it is a working app rather than a login wall.

```
VoiceBite/
├── server/   Express + TypeScript API. Runs on a Raspberry Pi under PM2, port 3000.
│   ├── src/          the service — parse, ground, verify, store
│   ├── src/eval/     the labelled corpus and the harness that scores against it
│   └── data/         one JSON file per day per user (gitignored except the demo seed)
└── web/      React + Vite frontend. Deploys to Firebase Hosting.
```

There is no build step on the server: `tsx` runs the TypeScript directly, and `tsc` is used
only to type-check. Two `package.json` files, no workspace tooling, no bundler for the API.

## Getting started

You need Node 20+ and an Anthropic API key.

```sh
git clone https://github.com/Bpmiller32/VoiceBite.git && cd VoiceBite

cd server
npm install
cp .env.example .env                          # set ANTHROPIC_API_KEY
npm run set-password -- "pick a password"     # prints the two auth lines to paste in
npm run server                                # http://localhost:3000
```

```sh
cd web
npm install
npm run dev                                   # http://localhost:5173
```

A fresh clone ships one synthetic user, `demo`, at `server/data/users/demo/` — three days
of logs, a pantry entry, and some weight/sleep readings. It exists so the charts, the
coverage disclosure and the gap handling all have something to render before you have
logged anything yourself. Real data never leaves the machine that produced it; everything
under `server/data/` other than that seed is gitignored.

## Running it

**Backend:**

```sh
cd server && npm run server      # foreground, for debugging
pm2 restart VoiceBite            # the normal way, once deployed
pm2 logs VoiceBite               # tail
curl localhost:3000/health       # liveness + which model is configured
```

**Frontend:**

```sh
cd web && npm run dev            # http://localhost:5173, proxies /api -> localhost:3000
cd web && npm run build          # type-checks, then builds to web/dist
```

The dev server proxies `/api` to `localhost:3000` so the browser sees one origin and CORS
never applies — which is exactly why a bad allow-list only ever shows up in production.
Set `VITE_PROXY_TARGET` to point the dev server at a backend somewhere else.

**CLI** (still the fastest way to log from a terminal):

```sh
cd server
npm start -- --food "2 eggs scrambled, toast with butter, chipotle burrito bowl"
npm start -- --date 2026-04-18          # edit an existing day
npm start -- --file ~/notes/today.txt
npm start -- --yes --food "..."         # skip all prompts
```

## How it's deployed

Same split as every other app on the Pi:

|                                  |                                                 |
| -------------------------------- | ----------------------------------------------- |
| `https://voicebite.billmill.dev` | backend — this Express server, via the tunnel   |
| `https://voicebite.web.app`      | frontend — the `web/` build on Firebase Hosting |

Cloudflare Tunnel (`~/.cloudflared/config.yml`) maps `voicebite.billmill.dev` → `localhost:3000`.
PM2 is registered with systemd (`pm2-billy.service`), so the API comes back after a reboot:

```sh
cd server
pm2 start npm --name VoiceBite -- run server
pm2 save && pm2 startup
```

The frontend deploy never touches the Pi:

```sh
cd web
npm run build                    # type-checks, then writes dist/
firebase deploy --only hosting   # goes to the "voicebite" site
```

`web/.env.production` sets `VITE_API_BASE=https://voicebite.billmill.dev`, so the built
bundle knows where the API is. It holds no secrets, which is why it is committed.

**The Firebase hostname comes from the SITE id, not the project id.** This project is
`voicebite-bpmiller`; the Hosting site is `voicebite`. Those are two different namespaces,
and confusing them is what once produced a "Can't reach the server" banner on a completely
healthy Pi: the browser was sending `Origin: https://voicebite-bpmiller.web.app`, which
wasn't in the allow-list, so every request was blocked while `curl` from the Pi worked
perfectly. Firebase also serves each site at `<site-id>.firebaseapp.com`, so **both**
hostnames have to be in `ALLOWED_ORIGINS`. Rejected origins are logged with the origin that
asked, which turns that from a hunt into a ten-second diagnosis:

```sh
grep CORS server/logs/voicebite.log
# -> origin: https://whatever.web.app   allowedOrigins: [ ... ]
```

The project holds two Hosting sites; only `voicebite` serves anything. `voicebite-bpmiller`
is the default site created with the project, and Firebase cannot delete a default site, so
it is disabled instead. `firebase.json` pins `"target": "app"` and `.firebaserc` maps that
to `voicebite` — worth leaving alone, because deploying with `--site voicebite-bpmiller`
would re-enable the dead URL.

## Auth

One password, one user. `server/src/auth.ts` — scrypt for the password, HMAC-SHA256 for
the token, both from node's `crypto`. No dependencies, no user table.

```sh
cd server
npm run set-password -- "your new password"   # prints the two .env lines to paste
pm2 restart VoiceBite
```

- The password is never stored, only a scrypt hash (`AUTH_PASSWORD_HASH`).
- Login returns a signed token, kept in `localStorage`, sent as `Authorization: Bearer`.
- `AUTH_SECRET` signs tokens. Changing it signs every device out.
- Comparisons use `timingSafeEqual`; login is rate-limited to 8 tries per 15 minutes.
- With either variable unset the gate returns 503 rather than falling open. An
  unconfigured gate that silently allows everything is the worst of both worlds.
- **The gate is on the server, not the UI.** Every `/log`, `/profile` and `/metrics` route
  requires a valid token, and the token's user must match the `:userId` in the path.
  A login screen that only hid React would be theatre — `curl` doesn't run JavaScript.

Open on purpose: `/health` (monitoring), `/auth/login`, and `/demo/parse`.

## Demo mode

Signed out, the app runs on synthetic data generated **in the browser**, so the portfolio
link is a working app rather than a login wall.

It lives in `web/src/demoData.ts` + `demoApi.ts`, and `api.ts` dispatches per call via a
Proxy — no screen knows which mode it is in.

Two properties are the whole design:

- **It is generated relative to today, on every page load.** Day 0 is always today, day 89
  is always 89 days ago. Someone opening the link next March sees the three months ending
  next March. There is no fixture to regenerate and nothing to go stale.
- **It lives only in the tab.** Every visitor gets a private copy and can add, edit and
  delete freely; closing the tab is the reset. No shared demo user to vandalise, no cleanup
  job, and nothing of mine is exposed.

The one thing not faked is parsing — that would be demoing nothing. `POST /demo/parse` runs
the real model, writes nothing, and is capped at 6 requests per hour per IP.

The data is deliberately imperfect: ~18 of 90 days unlogged, ~30% of entries missing
micronutrients, sodium and sugar frequently over. A tidy demo would hide the gap handling
and partial-coverage disclosure, which are the parts that took the most care.

## Data

One JSON file per day: `server/data/users/{userId}/food/{YYYY-MM-DD}.json`.
No database. At ~290 KB for a month of logs, files are the right call — greppable,
diffable, trivially backed up.

Two things about the schema are worth internalizing before touching any code that reads it:

**A nutrient value of `null` means UNKNOWN. `0` means the food contains none of it.**
These are different. Claude omits a nutrient when it has no basis for a number, and that
omission is recorded as `null` and excluded from daily totals. The previous version told
Claude to "use 0 if truly unknown", which made 45.8% of stored micronutrient fields hard
zeros and every RDA chart show deficiencies that were not real. Never render `null` as 0,
and never sum it as 0.

**`daily_coverage` says how many entries contributed a known value to each total.** When
coverage is below the entry count, the UI has to say so ("1,240 mg from 6 of 9 items")
rather than presenting a partial total as complete.

Hand-entered daily numbers — **weight, distance walked, sleep** — live in
`server/data/users/{userId}/metrics.json`, deliberately **not** inside the day logs: you
can step on a scale or take a walk on a day you never log food, and an entry-less day file
is read everywhere as a gap, so it would have registered as a 0 kcal day and dragged every
average down.

They share one shape, one file and one set of routes, driven by the `METRICS` table in
`types.ts`. Adding a fourth (steps, resting heart rate) is a row there and a row in the
client's mirror — not another file, endpoint set, card and chart.

Historical files are normalized to the current schema on read and only rewritten when that
day is next edited, so old data keeps working without a migration step.

## API

```
GET    /health                          open
POST   /auth/login                      open — { password } -> { token }
GET    /auth/me                         is this token still valid?
POST   /demo/parse                      open, hard rate-limited — parses, saves nothing
POST   /log                             { text, date?, userId?, overwrite? } -> preview
POST   /confirm/:sessionId              { entries?, overwrite? } -> saves; entries lets you save edits
POST   /estimate                        { name, quantity?, unit? } -> re-estimate one item
GET    /log/:userId/dates
GET    /log/:userId/range?from=&to=     day summaries; this is what the charts run on
GET    /log/:userId/foods?from=&to=     most-eaten foods, aggregated server-side
GET    /log/:userId/:date
POST   /log/:userId/:date/entries       add an entry by hand, no model call
PUT    /log/:userId/:date/:entryId
DELETE /log/:userId/:date/:entryId
GET    /profile/:userId                 daily goals (shared across devices)
PUT    /profile/:userId
GET    /metrics/:userId?from=&to=       weight / distance / sleep readings
PUT    /metrics/:userId/:date/:metric   { value, unit? }
DELETE /metrics/:userId/:date/:metric
```

Errors are always `{ error: { code, message } }`. Codes worth handling in a client:
`no_food_found`, `session_not_found`, `rate_limited`, `text_too_long`, `invalid_date`.

## Configuration

`server/.env` (see `.env.example`, which documents every variable the code reads). Note
`dotenv` runs with `override: true`, so **`.env` always beats your shell environment** — if
a key in your shell seems to be ignored, that's why.

| Variable                                                   | Notes                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                                        | Required.                                                                                                                                                                                                                          |
| `CLAUDE_MODEL`                                             | Default `claude-opus-5`. Must be a model that supports structured outputs.                                                                                                                                                         |
| `CLAUDE_EFFORT`                                            | `low`…`max`, default `medium`. The reasoning-heavy parse call.                                                                                                                                                                     |
| `CLAUDE_LOOKUP_EFFORT`                                     | Effort for a grounding lookup — retrieval, not reasoning. Default `medium`.                                                                                                                                                        |
| `CLAUDE_BACKFILL_EFFORT`                                   | Effort for bulk `npm run backfill` runs. Default `medium`.                                                                                                                                                                         |
| `CLAUDE_MAX_TOKENS`                                        | Default 32000. A ceiling on _generated_ tokens — not a timeout, not a spend cap. You are only billed for what's produced.                                                                                                          |
| `AUTH_PASSWORD_HASH`, `AUTH_SECRET`                        | Both required for any authenticated route. Generate with `npm run set-password`.                                                                                                                                                   |
| `ALLOWED_ORIGINS`                                          | CORS allow-list. Must contain the exact origin the browser sends — for Firebase that is `<site-id>.web.app` **and** `<site-id>.firebaseapp.com`. A missing entry looks exactly like "the Pi is down"; rejected origins are logged. |
| `VOICEBITE_GROUNDING`, `VOICEBITE_MICRO_PASS`              | `on`/`off`. Turning either off is how you measure what it contributes.                                                                                                                                                             |
| `VOICEBITE_BUDGET_MS`                                      | Wall-clock ceiling for one `POST /log`. Default 80000, below the client's 95s abort and the tunnel's ~100s origin timeout.                                                                                                         |
| `DEFAULT_USER`, `DATA_DIR`, `LOG_DIR`, `LOG_LEVEL`, `PORT` |                                                                                                                                                                                                                                    |

## Estimation accuracy

The estimator no longer recalls numbers it can read. Three layers, in the order they run:

| Layer                                    | What it does                                                       | When it applies                       |
| ---------------------------------------- | ------------------------------------------------------------------ | ------------------------------------- |
| **Pantry** (`server/src/pantry.ts`)      | Scales stored per-serving values by a serving count, in TypeScript | A food you have logged before         |
| **Grounding** (`server/src/resolver.ts`) | Reads published nutrition facts via web search + fetch             | A branded or chain item, first time   |
| **Micronutrient pass**                   | Estimates the ~11 nutrients no label prints, from composition      | Any item still thin on micronutrients |

The server does the arithmetic, not the model. Scaling a self-consistent label by a scalar
stays self-consistent, so a pantry-resolved entry cannot contradict its own macros and
cannot disagree with yesterday's logging of the same food. Unknown scales to unknown,
never to zero.

```sh
cd server
npm run backfill                  # look up your repeat foods once, review, pin them
npm run backfill -- --dry-run     # resolve and print, write nothing
npm run backfill -- --gold        # also emit eval/gold.json

npm run eval -- --tag today       # measure the estimator against the stored corpus
npm run eval -- --diff before after   # compare two saved measurements
```

`src/eval/gold.json` is the labelled corpus — 15 branded items with their published label
values and the URL each came from, so a lookup can be scored against the real number rather
than a plausible one. `src/eval/results/final.json` is one scored run, committed so the
shape of the output is readable without running anything; further runs are gitignored.

Measuring what a layer contributes means running it both ways against the same corpus.
Flip the value **in `server/.env`**, not on the command line — `dotenv` runs with
`override: true`, so `VOICEBITE_GROUNDING=off npm run eval` is silently ignored the moment
that key exists in `.env`, and you get two identical measurements and a wrong conclusion:

```sh
# set VOICEBITE_GROUNDING=off in server/.env
npm run eval -- --tag no-grounding
# set it back to on
npm run eval -- --tag grounded
npm run eval -- --diff no-grounding grounded
```

The knobs are `VOICEBITE_GROUNDING`, `VOICEBITE_MICRO_PASS`, `VOICEBITE_BUDGET_MS`,
`CLAUDE_EFFORT` and `CLAUDE_LOOKUP_EFFORT`, all documented in `.env.example`.

Corrections you make in the preview, or later via edit/delete, are appended to
`data/users/<user>/corrections.jsonl`. Correcting a pantry item pins your value as
`verified_by: "owner"`, which no automated lookup may overwrite.
