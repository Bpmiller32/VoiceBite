// server.ts
// Express HTTP server that exposes VoiceBite over the network.
// Runs on the Raspberry Pi behind a Cloudflare Tunnel (voicebite.billmill.dev -> :3000),
// and is called by the web frontend and by iPhone Shortcuts.
//
// Endpoints:
//   GET    /health                          - liveness + version, for monitoring
//   POST   /log                             - parse text, enrich, return a preview to confirm
//   POST   /confirm/:sessionId              - confirm a pending session, write it to disk
//   POST   /estimate                        - re-estimate one food item without saving
//   GET    /metrics/:userId                 - weight / distance / sleep series
//   PUT    /metrics/:userId/:date/:metric   - record or correct one reading
//   DELETE /metrics/:userId/:date/:metric   - remove one reading
//   GET    /profile/:userId                 - read daily goals
//   PUT    /profile/:userId                 - update daily goals
//   GET    /log/:userId/dates               - list all dates that have logs
//   GET    /log/:userId/range?from=&to=     - day summaries for a date range (powers the charts)
//   GET    /log/:userId/foods?from=&to=     - most-eaten foods across a window
//   GET    /log/:userId/:date               - read back one saved day
//   POST   /log/:userId/:date/entries       - add an entry by hand, no model call
//   PUT    /log/:userId/:date/:entryId      - update one entry
//   DELETE /log/:userId/:date/:entryId      - delete one entry
//
// The original /log and /confirm/:sessionId request shapes are unchanged, so existing
// iPhone Shortcuts keep working without edits.

// Loads .env. Must be the first local import - see src/env.ts for why the ordering matters.
import "./env";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { initLogger } from "./logger";
import { parseAndEnrich, estimateOne, sumNutrients, sumWaterMl, sanitizeNutrients, zeroNutrients } from "./enricher";
import {
  appendEntries, readDayLog, writeDayLog, listDates, readRange, buildDayLog,
  todayDateString, isValidDate, isValidUserId, readGoals, writeGoals,
  readMetrics, writeMetric, deleteMetric, ClientError, readFoodStats,
} from "./store";
import { createSession, getSession, deleteSession, purgeExpiredSessions, sessionCount } from "./sessions";
import { FoodEntry, DayLog, LogPreviewResponse, LogBatch, SCHEMA_VERSION } from "./types";
import { requireAuth, requireOwnUser, verifyPassword, signToken, authConfigured } from "./auth";

const logger = initLogger("server");
const startedAt = Date.now();

const app = express();

// CORS allow-list from ALLOWED_ORIGINS env (comma-separated), with a sensible default.
// Note this is not a security control - curl and server-to-server calls have no Origin
// and bypass it entirely. It exists so browsers can reach the API from the frontend.
// The convention across this Pi's apps: <name>.billmill.dev is the backend (this process,
// via the Cloudflare Tunnel) and <name>.web.app is the frontend on Firebase Hosting.
//
// Firebase serves a Hosting site at BOTH <site-id>.web.app and <site-id>.firebaseapp.com,
// so both belong here. Note the hostname comes from the SITE id, which is not necessarily
// the project id - this project is "voicebite-bpmiller" but the site is "voicebite".
// Getting that wrong is what made a perfectly healthy Pi look offline behind a
// "Can't reach the server" banner.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://voicebite.web.app",
  "https://voicebite.firebaseapp.com",
].join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => {
      // No origin (curl, iPhone Shortcut, server-to-server) - allow.
      // Origin in allow-list - allow. Otherwise deny cleanly (no Allow-Origin header set);
      // the browser blocks the request and we avoid a 500 + stack-trace leak.
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      // Log the rejection. A denied origin is otherwise completely silent on this side:
      // the browser reports "Can't reach the server" and the Pi's log shows a healthy 200,
      // so there is nothing connecting the symptom to the cause. This line is the whole
      // diagnosis - it names the origin that asked and what is actually allowed.
      logger.warn({ origin, allowedOrigins }, "CORS: rejected origin not in ALLOWED_ORIGINS");
      return cb(null, false);
    },
  })
);

// Cap request bodies. The Express default is 100KB, which on POST /log is ~25k input
// tokens of attacker- or typo-controlled text going straight into a paid model call.
app.use(express.json({ limit: "32kb" }));

// Request ID middleware - generates a unique ID per request for log correlation
app.use((req, res, next) => {
  const requestId = crypto.randomUUID();
  (req as any).requestId = requestId;
  (req as any).log = logger.child({ requestId, method: req.method, path: req.url });
  (req as any).log.info("request received");
  const startMs = Date.now();
  res.on("finish", () => {
    (req as any).log.info({ statusCode: res.statusCode, latencyMs: Date.now() - startMs }, "request completed");
  });
  next();
});

// Minimal in-memory rate limiter.
//
// This is cost control, not access control: POST /log spends real money on the Anthropic
// API per request, and the service is reachable from the public internet. The limits are
// set well above any human usage pattern, so normal use never sees a 429.
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(max: number, windowMs = 60_000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.method}:${req.path}:${req.ip ?? "unknown"}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      (req as any).log?.warn({ key, max }, "rate limited");
      return res.status(429).json({ error: { code: "rate_limited", message: `Too many requests. Retry in ${retryAfter}s.` } });
    }
    bucket.count++;
    next();
  };
}
// Sweep expired buckets so the Map doesn't grow forever on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets.entries()) if (now > b.resetAt) rateBuckets.delete(k);
}, 5 * 60 * 1000);

const DEFAULT_USER = process.env.DEFAULT_USER || "default";

// Purge expired sessions on a timer. The interval is shorter than the session TTL so
// an expired session is collected promptly rather than lingering for another full period.
setInterval(purgeExpiredSessions, 60 * 1000);

// Reject bad userId/date before anything reaches the filesystem or a paid model call.
function validateParams(req: Request, res: Response, next: NextFunction) {
  const { userId, date } = req.params;
  if (userId !== undefined && !isValidUserId(userId)) {
    return res.status(400).json({ error: { code: "invalid_user_id", message: "userId must be 1-32 letters, digits, underscore or hyphen" } });
  }
  if (date !== undefined && !isValidDate(date)) {
    return res.status(400).json({ error: { code: "invalid_date", message: "date must be a real calendar date in YYYY-MM-DD form" } });
  }
  next();
}

// Wrap an async handler so a rejected promise reaches the error middleware
// instead of hanging the request.
const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

// GET /health
// Liveness and build info. Also lets StatusWatch (already running on :3003) monitor this.
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "voicebite",
    schemaVersion: SCHEMA_VERSION,
    model: process.env.CLAUDE_MODEL || "claude-opus-5",
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    pendingSessions: sessionCount(),
  });
});

// POST /auth/login
// Body: { password }
// Rate-limited hard: this is the one endpoint where guessing is the attack.
app.post("/auth/login", rateLimit(8, 15 * 60_000), (req, res) => {
  const reqLog = (req as any).log;
  const { password } = req.body ?? {};

  if (!authConfigured()) {
    res.status(503).json({ error: { code: "auth_not_configured", message: "Authentication is not configured on this server" } });
    return;
  }
  if (typeof password !== "string" || password.length === 0) {
    res.status(400).json({ error: { code: "missing_password", message: "Enter your password" } });
    return;
  }
  if (!verifyPassword(password, process.env.AUTH_PASSWORD_HASH as string)) {
    reqLog.warn("failed login attempt");
    // Deliberately vague. There is one account; naming which half was wrong helps nobody
    // except someone guessing.
    res.status(401).json({ error: { code: "bad_password", message: "That password isn't right" } });
    return;
  }

  const { token, expiresAt } = signToken(DEFAULT_USER);
  reqLog.info({ userId: DEFAULT_USER }, "login succeeded");
  res.json({ token, expiresAt, userId: DEFAULT_USER });
});

// GET /auth/me - is this token still good? Lets the app decide on load whether to show
// the real log or the demo, without waiting for a data request to 401.
app.get("/auth/me", requireAuth, (req, res) => {
  res.json({ userId: (req as any).userId });
});

// POST /demo/parse
// Body: { text }
// The one thing demo mode cannot fake: turning a spoken sentence into structured nutrition.
// Parses and returns; creates no session and writes nothing to disk. Everything else in
// demo mode lives in the visitor's browser, so there is no demo data on this server to
// vandalise, reset, or leak.
//
// This spends real API credit on behalf of strangers, so the cap is deliberately mean:
// enough to try the product a few times, not enough to be worth abusing.
app.post("/demo/parse", rateLimit(6, 60 * 60_000), wrap(async (req, res) => {
  const reqLog = (req as any).log;
  const { text } = req.body ?? {};

  if (!text || typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: { code: "empty_text", message: "Say what you ate first" } });
    return;
  }
  if (text.length > 600) {
    res.status(400).json({ error: { code: "text_too_long", message: "Demo mode takes shorter entries - try one meal at a time." } });
    return;
  }

  const { entries } = await parseAndEnrich(text, reqLog);
  if (entries.length === 0) {
    res.status(422).json({ error: { code: "no_food_found", message: "I couldn't pick out any food from that." }, transcript: text });
    return;
  }
  reqLog.info({ entryCount: entries.length }, "demo parse");
  res.json({ transcript: text, entries });
}));

// POST /log
// Body: { text: string, userId?: string, date?: string, overwrite?: boolean }
// Parses the food text, enriches it with nutrients, and returns a preview to confirm.
// Nothing is written to disk yet - the client must call /confirm/:sessionId to save.
app.post("/log", requireAuth, rateLimit(20), wrap(async (req, res) => {
  const reqLog = (req as any).log;
  const { text, userId, date, overwrite } = req.body ?? {};

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    reqLog.warn("empty text field in request body");
    res.status(400).json({ error: { code: "empty_text", message: "Request body must include a non-empty 'text' field" } });
    return;
  }
  // Cap input length before the model call, independent of the body size limit.
  if (text.length > 8000) {
    res.status(400).json({ error: { code: "text_too_long", message: "That's too much text for one entry. Try splitting it up." } });
    return;
  }

  const user = userId ?? DEFAULT_USER;
  const logDate = date ?? todayDateString();

  if (!isValidUserId(user)) {
    res.status(400).json({ error: { code: "invalid_user_id", message: "userId must be 1-32 letters, digits, underscore or hyphen" } });
    return;
  }
  if (!isValidDate(logDate)) {
    res.status(400).json({ error: { code: "invalid_date", message: "date must be a real calendar date in YYYY-MM-DD form" } });
    return;
  }

  // Read the existing day BEFORE the model call. A bad date or a corrupt file used to
  // burn a full multi-second, multi-thousand-token paid call before failing.
  const existingLog = readDayLog(user, logDate);
  const existingCount = existingLog ? existingLog.entries.length : 0;
  const existingCalories = existingLog ? Math.round(existingLog.daily_totals.calories) : 0;

  reqLog.info({ userId: user, date: logDate }, "parsing and estimating nutrition");
  const { entries } = await parseAndEnrich(text, reqLog);
  reqLog.info({ userId: user, entryCount: entries.length }, "parsed and enriched entries");

  // A microphone produces silence, background noise, and non-food chatter. Without this,
  // that path returned 200 with an empty preview and a confirm that wrote nothing while
  // reporting success.
  if (entries.length === 0) {
    res.status(422).json({
      error: { code: "no_food_found", message: "I couldn't pick out any food from that. Try describing what you ate again." },
      transcript: text,
    });
    return;
  }

  const sessionId = createSession(user, logDate, entries, text, overwrite === true);

  const sum = (fn: (e: FoodEntry) => number | null) =>
    entries.reduce((acc, e) => acc + (fn(e) ?? 0), 0);

  const preview: LogPreviewResponse = {
    sessionId,
    date: logDate,
    transcript: text,
    entries,
    summary: {
      totalCalories: Math.round(sum((e) => e.nutrients.calories)),
      totalProtein_g: Math.round(sum((e) => e.nutrients.protein_g) * 10) / 10,
      totalFat_g: Math.round(sum((e) => e.nutrients.fat_g) * 10) / 10,
      totalCarbs_g: Math.round(sum((e) => e.nutrients.carbs_g) * 10) / 10,
    },
    existingEntries: existingCount,
    existingCalories,
  };

  reqLog.info({ sessionId, totalCalories: preview.summary.totalCalories }, "preview ready");
  res.json(preview);
}));

// POST /confirm/:sessionId
// Body: { userId?: string, overwrite?: boolean, entries?: FoodEntry[] }
//
// `entries` is the important addition. The old version wrote session.entries verbatim,
// so anything the user fixed in the preview screen was silently discarded and their only
// recourse was confirm-then-repair - writing known-bad data, then issuing PUT/DELETE
// against it, with wrong totals visible in between.
app.post("/confirm/:sessionId", requireAuth, wrap(async (req, res) => {
  const reqLog = (req as any).log;
  const { sessionId } = req.params;
  const { userId, overwrite, entries: editedEntries } = req.body ?? {};
  const user = userId ?? DEFAULT_USER;

  const session = getSession(sessionId);
  if (!session) {
    reqLog.warn({ sessionId }, "session not found or expired");
    res.status(404).json({ error: { code: "session_not_found", message: "That session expired or the server restarted. Please re-submit." } });
    return;
  }
  if (session.userId !== user) {
    reqLog.warn({ sessionId, sessionUser: session.userId, requestUser: user }, "session user mismatch");
    res.status(403).json({ error: { code: "session_user_mismatch", message: "This session belongs to a different user" } });
    return;
  }

  // If the client sent edited entries, accept only entries whose ids came from this
  // session - so a confirm can revise or drop what was previewed, but can't smuggle in
  // arbitrary rows - and re-sanitize every nutrient value before it reaches disk.
  let entriesToSave: FoodEntry[] = session.entries;
  if (Array.isArray(editedEntries)) {
    const allowed = new Map(session.entries.map((e) => [e.id, e]));
    entriesToSave = editedEntries
      .filter((e: any) => e && typeof e.id === "string" && allowed.has(e.id))
      .map((e: any) => {
        const original = allowed.get(e.id)!;
        return {
          ...original,
          food_name: typeof e.food_name === "string" && e.food_name.trim() ? e.food_name.trim() : original.food_name,
          serving_description: typeof e.serving_description === "string" && e.serving_description.trim()
            ? e.serving_description.trim() : original.serving_description,
          nutrients: e.nutrients ? sanitizeNutrients(e.nutrients) : original.nutrients,
        };
      });
    if (entriesToSave.length === 0) {
      res.status(400).json({ error: { code: "no_entries", message: "Nothing left to save - all entries were removed." } });
      return;
    }
  }

  const useOverwrite = overwrite === undefined ? session.overwrite : overwrite === true;

  const batch: LogBatch = {
    batch_id: crypto.randomUUID(),
    logged_at: new Date().toISOString(),
    transcript: session.transcript,
    entry_count: entriesToSave.length,
  };
  entriesToSave = entriesToSave.map((e) => ({ ...e, batch_id: batch.batch_id }));

  let log: DayLog;
  if (useOverwrite) {
    // Re-read inside the same synchronous section rather than trusting the snapshot
    // taken when the session was created, which could be half an hour stale.
    log = buildDayLog(session.userId, session.date, entriesToSave, [batch]);
    writeDayLog(log);
  } else {
    ({ log } = appendEntries(session.userId, session.date, entriesToSave, batch));
  }

  deleteSession(sessionId);

  reqLog.info({
    sessionId, userId: user, date: session.date,
    totalEntries: log.entries.length, totalCalories: Math.round(log.daily_totals.calories), overwrite: useOverwrite,
  }, "session confirmed and saved");

  res.json({
    success: true,
    message: `Logged ${entriesToSave.length} new entries for ${session.date}. Day total: ${log.entries.length} entries, ${Math.round(log.daily_totals.calories)} calories`,
    log,
  });
}));

// POST /estimate
// Body: { name: string, quantity?: number, unit?: string }
// Re-estimate one food item and return its nutrients without saving anything.
// This logic previously existed only inside the CLI, so the API was strictly less
// capable than the terminal in exactly the "fix what it misheard" dimension.
app.post("/estimate", requireAuth, rateLimit(30), wrap(async (req, res) => {
  const reqLog = (req as any).log;
  const { name, quantity, unit } = req.body ?? {};

  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: { code: "invalid_name", message: "Body must include a non-empty 'name'" } });
    return;
  }
  const food = {
    name: name.trim().slice(0, 300),
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    unit: typeof unit === "string" && unit.trim() ? unit.trim().slice(0, 60) : "serving",
  };

  const nutrients = await estimateOne(food, reqLog);
  res.json({ parsed: food, nutrients });
}));

// GET    /metrics/:userId?from=&to=&metric=  - every reading, oldest first
// PUT    /metrics/:userId/:date/:metric       - record or correct one: { value, unit? }
// DELETE /metrics/:userId/:date/:metric       - remove one
//
// Weight, distance walked and sleep share one shape and one set of routes. Adding a fourth
// (steps, resting heart rate) is a row in METRICS, not another four handlers.
//
// These live outside the day logs so a weigh-in or a walk on a day you didn't eat-log
// doesn't create an entry-less day file, which every chart would read as a 0 kcal gap.
app.get("/metrics/:userId", requireAuth, requireOwnUser, validateParams, (req, res) => {
  const { userId } = req.params;
  const from = typeof req.query.from === "string" ? req.query.from : undefined;
  const to = typeof req.query.to === "string" ? req.query.to : undefined;
  const metric = typeof req.query.metric === "string" ? req.query.metric : undefined;
  if ((from && !isValidDate(from)) || (to && !isValidDate(to))) {
    res.status(400).json({ error: { code: "invalid_date", message: "'from' and 'to' must be YYYY-MM-DD" } });
    return;
  }
  res.json({ userId, metrics: readMetrics(userId, from, to, metric as any) });
});

app.put("/metrics/:userId/:date/:metric", requireAuth, requireOwnUser, validateParams, (req, res) => {
  const reqLog = (req as any).log;
  const { userId, date, metric } = req.params;
  const point = writeMetric(userId, date, metric, req.body?.value, req.body?.unit);
  reqLog.info({ userId, date, metric }, "metric recorded");
  res.json({ userId, metric: point });
});

app.delete("/metrics/:userId/:date/:metric", requireAuth, requireOwnUser, validateParams, (req, res) => {
  const { userId, date, metric } = req.params;
  if (!deleteMetric(userId, date, metric)) {
    res.status(404).json({ error: { code: "metric_not_found", message: `No ${metric} recorded for ${date}` } });
    return;
  }
  res.json({ success: true, date, metric });
});

// GET /profile/:userId  - the daily targets every chart draws its reference lines from
// PUT /profile/:userId  - body is a partial Goals object; omitted fields keep their value
//
// Server-side rather than in the browser so the phone and the desktop agree.
app.get("/profile/:userId", requireAuth, requireOwnUser, validateParams, (req, res) => {
  const { userId } = req.params;
  res.json({ userId, goals: readGoals(userId) });
});

app.put("/profile/:userId", requireAuth, requireOwnUser, validateParams, (req, res) => {
  const reqLog = (req as any).log;
  const { userId } = req.params;
  const goals = writeGoals(userId, req.body?.goals ?? req.body);
  reqLog.info({ userId }, "goals updated");
  res.json({ userId, goals });
});

// GET /log/:userId/dates
// Returns every date that has a food log for a user, newest first.
// NOTE: must be registered before /:date so "dates" doesn't match the :date param.
app.get("/log/:userId/dates", requireAuth, requireOwnUser, validateParams, (req, res) => {
  const reqLog = (req as any).log;
  const { userId } = req.params;
  const dates = listDates(userId);
  reqLog.info({ userId, dateCount: dates.length }, "listed dates");
  res.json({ userId, dates });
});

// GET /log/:userId/range?from=YYYY-MM-DD&to=YYYY-MM-DD
// Day summaries across a date range, in one request.
// Registered before /:date for the same reason as /dates above.
app.get("/log/:userId/range", requireAuth, requireOwnUser, validateParams, (req, res) => {
  const reqLog = (req as any).log;
  const { userId } = req.params;
  const to = typeof req.query.to === "string" ? req.query.to : todayDateString();

  // Default to the last 30 days if no start given.
  let from: string;
  if (typeof req.query.from === "string") {
    from = req.query.from;
  } else {
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 29);
    from = d.toISOString().slice(0, 10);
  }

  if (!isValidDate(from) || !isValidDate(to)) {
    res.status(400).json({ error: { code: "invalid_date", message: "'from' and 'to' must be real calendar dates in YYYY-MM-DD form" } });
    return;
  }
  if (from > to) {
    res.status(400).json({ error: { code: "invalid_range", message: "'from' must be on or before 'to'" } });
    return;
  }

  const days = readRange(userId, from, to);
  reqLog.info({ userId, from, to, dayCount: days.length }, "read range");
  res.json({ userId, from, to, days });
});

// GET /log/:userId/foods?from=&to=&limit=
// What you eat most across a window, aggregated server-side.
// Registered before /:date, like /dates and /range, so "foods" isn't read as a date.
app.get("/log/:userId/foods", requireAuth, requireOwnUser, validateParams, (req, res) => {
  const { userId } = req.params;
  const to = typeof req.query.to === "string" ? req.query.to : todayDateString();
  let from: string;
  if (typeof req.query.from === "string") {
    from = req.query.from;
  } else {
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 29);
    from = d.toISOString().slice(0, 10);
  }
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20")) || 20, 1), 100);
  res.json({ userId, from, to, foods: readFoodStats(userId, from, to, limit) });
});

// GET /log/:userId/:date
// Returns the saved food log for a specific user and date
app.get("/log/:userId/:date", requireAuth, requireOwnUser, validateParams, (req, res) => {
  const reqLog = (req as any).log;
  const { userId, date } = req.params;
  const log = readDayLog(userId, date);

  if (!log) {
    reqLog.info({ userId, date }, "day log not found");
    res.status(404).json({ error: { code: "day_not_found", message: `No log found for '${userId}' on ${date}` } });
    return;
  }

  reqLog.info({ userId, date, entryCount: log.entries.length }, "day log retrieved");
  res.json(log);
});

// POST /log/:userId/:date/entries
// Body: { food_name, serving_description?, nutrients, water_ml? }
// Add an entry by hand. Every other way to add food spends an Anthropic call;
// this is the escape hatch for when you already know the numbers.
app.post("/log/:userId/:date/entries", requireAuth, requireOwnUser, validateParams, (req, res) => {
  const reqLog = (req as any).log;
  const { userId, date } = req.params;
  const body = req.body ?? {};

  if (!body.food_name || typeof body.food_name !== "string" || !body.food_name.trim()) {
    res.status(400).json({ error: { code: "invalid_food_name", message: "Body must include a non-empty 'food_name'" } });
    return;
  }

  const isWater = body.water_ml !== undefined && Number.isFinite(body.water_ml);
  const entry: FoodEntry = {
    id: crypto.randomUUID(),
    food_name: body.food_name.trim().slice(0, 300),
    serving_description: typeof body.serving_description === "string" && body.serving_description.trim()
      ? body.serving_description.trim().slice(0, 120) : "1 serving",
    source: isWater ? "water" : "claude_estimate",
    nutrients: isWater ? zeroNutrients() : sanitizeNutrients(body.nutrients),
    logged_at: new Date().toISOString(),
  };
  if (isWater) entry.water_ml = Math.round(body.water_ml);

  const { log } = appendEntries(userId, date, [entry]);
  reqLog.info({ userId, date, entryId: entry.id, food: entry.food_name }, "manual entry added");
  res.status(201).json({ success: true, entry, log });
});

// DELETE /log/:userId/:date/:entryId
// Removes a single entry from a day log by its ID
app.delete("/log/:userId/:date/:entryId", requireAuth, requireOwnUser, validateParams, (req, res) => {
  const reqLog = (req as any).log;
  const { userId, date, entryId } = req.params;

  const existing = readDayLog(userId, date);
  if (!existing) {
    res.status(404).json({ error: { code: "day_not_found", message: `No log found for '${userId}' on ${date}` } });
    return;
  }

  const idx = existing.entries.findIndex((e) => e.id === entryId);
  if (idx === -1) {
    res.status(404).json({ error: { code: "entry_not_found", message: `Entry '${entryId}' not found in ${date}` } });
    return;
  }

  const removed = existing.entries.splice(idx, 1)[0];
  // Rebuild rather than mutate, so totals, coverage and water are all recomputed together.
  const log = buildDayLog(userId, date, existing.entries, existing.batches);
  writeDayLog(log);

  reqLog.info({ userId, date, entryId, food: removed.food_name }, "entry deleted");
  res.json({ success: true, deleted: removed, log });
});

// PUT /log/:userId/:date/:entryId
// Body: partial FoodEntry fields to merge (id and source are preserved)
app.put("/log/:userId/:date/:entryId", requireAuth, requireOwnUser, validateParams, (req, res) => {
  const reqLog = (req as any).log;
  const { userId, date, entryId } = req.params;

  const existing = readDayLog(userId, date);
  if (!existing) {
    res.status(404).json({ error: { code: "day_not_found", message: `No log found for '${userId}' on ${date}` } });
    return;
  }

  const idx = existing.entries.findIndex((e) => e.id === entryId);
  if (idx === -1) {
    res.status(404).json({ error: { code: "entry_not_found", message: `Entry '${entryId}' not found in ${date}` } });
    return;
  }

  const update = req.body ?? {};
  const entry = existing.entries[idx];

  if (typeof update.food_name === "string" && update.food_name.trim()) {
    entry.food_name = update.food_name.trim().slice(0, 300);
  }
  if (typeof update.serving_description === "string" && update.serving_description.trim()) {
    entry.serving_description = update.serving_description.trim().slice(0, 120);
  }
  if (update.nutrients) {
    // Merge onto the existing profile, then sanitize the result. Without the sanitize
    // step a PUT of {"calories": "abc"} lands as NaN and serializes to null on disk,
    // poisoning that day's total permanently.
    entry.nutrients = sanitizeNutrients({ ...entry.nutrients, ...update.nutrients });
  }
  if (update.water_ml !== undefined) {
    entry.water_ml = Number.isFinite(update.water_ml) && update.water_ml >= 0 ? Math.round(update.water_ml) : undefined;
  }

  const log = buildDayLog(userId, date, existing.entries, existing.batches);
  writeDayLog(log);

  reqLog.info({ userId, date, entryId }, "entry updated");
  res.json({ success: true, entry, log });
});

// Unknown route - JSON, not Express's default HTML page.
app.use((_req, res) => {
  res.status(404).json({ error: { code: "not_found", message: "No such endpoint" } });
});

// Terminal error handler. Everything that throws lands here as JSON with a stable shape.
// Previously a malformed body, an oversize body, or any unhandled throw returned an HTML
// stack trace, so a frontend's `await res.json()` failed with "Unexpected token '<'" on
// the three most common client mistakes - and leaked absolute file paths publicly.
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  const reqLog = (req as any).log ?? logger;
  reqLog.error({ err: err?.message, stack: err?.stack }, "unhandled request error");

  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "invalid_json", message: "Request body is not valid JSON" } });
    return;
  }
  if (err?.type === "entity.too.large") {
    res.status(413).json({ error: { code: "body_too_large", message: "Request body is too large" } });
    return;
  }
  // Errors tagged at the throw site as the caller's fault carry a useful message back.
  // Everything else is ours, and a publicly reachable endpoint does not get to leak it.
  if (err instanceof ClientError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  res.status(500).json({
    error: { code: "internal_error", message: err?.message || "Something went wrong on the server" },
  });
});

const PORT = parseInt(process.env.PORT || "3000");
const server = app.listen(PORT, () => {
  logger.info({
    port: PORT,
    defaultUser: DEFAULT_USER,
    dataDir: process.env.DATA_DIR || "./data",
    logDir: process.env.LOG_DIR || "./logs",
    model: process.env.CLAUDE_MODEL || "claude-opus-5",
    schemaVersion: SCHEMA_VERSION,
  }, "VoiceBite server started");
});

// Drain in-flight requests on shutdown instead of dying mid-write.
// `pm2 restart` sends SIGINT, and a write interrupted at the wrong moment used to be
// how a day file got truncated.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

// Never let an unhandled rejection take the process down silently.
process.on("unhandledRejection", (reason) => logger.error({ reason }, "unhandled promise rejection"));
process.on("uncaughtException", (err) => logger.error({ err: err.message, stack: err.stack }, "uncaught exception"));
