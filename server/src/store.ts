// store.ts
// Reads and writes daily food log JSON files to disk
// Each day gets its own file at: {DATA_DIR}/users/{userId}/food/{YYYY-MM-DD}.json
// This is the only file that touches the filesystem.
//
// Two invariants worth knowing:
//
// - Writes are atomic. We write a temp file, fsync it, then rename over the target.
//   A bare writeFileSync that dies mid-write (crash, `pm2 restart`, power cut) leaves a
//   truncated file, and because appendEntries reads before it writes, that day becomes
//   permanently unreadable AND unwritable - you can't even overwrite your way out of it.
//
// - The path is always derived from the caller's date, never from the JSON's own `date`
//   field, and is asserted to stay inside DATA_DIR. Deriving it from the payload is how
//   a file named 2026-04-29.json that internally claimed to be 2026-04-30 would have had
//   a DELETE against the 29th silently overwrite the 30th.

import fs from "fs";
import path from "path";
import {
  DayLog, FoodEntry, DaySummary, LogBatch, SCHEMA_VERSION, NUTRIENT_KEYS,
  Goals, GOAL_KEYS, OPTIONAL_GOAL_KEYS, DEFAULT_GOALS,
  MetricKey, MetricPoint, DayMetrics, MetricReading, METRICS, METRIC_KEYS, convertMetric,
} from "./types";
import { sumNutrients, sumWaterMl, sanitizeNutrients } from "./enricher";
import { getLogger } from "./logger";

/**
 * An error caused by the caller, not by us.
 *
 * The alternative - the error middleware regex-matching messages to decide on 400 vs 500 -
 * silently mis-sorted anything phrased differently: "weight looks like a typo" came back to
 * the client as a 500 internal_error. Tagging the error at the throw site is the only place
 * that actually knows whose fault it was.
 */
export class ClientError extends Error {
  readonly status = 400;
  constructor(message: string, readonly code = "invalid_request") {
    super(message);
    this.name = "ClientError";
  }
}

// Get the base data directory from the environment, default to ./data
function getDataDir(): string {
  return process.env.DATA_DIR || "./data";
}

/**
 * Write JSON atomically: temp file, fsync, rename over the target.
 *
 * rename() is atomic within a filesystem, so a reader either sees the whole old file or
 * the whole new one. A bare writeFileSync that dies mid-write (crash, `pm2 restart`, power
 * cut) leaves a truncated file - and because every store here reads before it writes, that
 * makes the record permanently unreadable AND unwritable.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* temp file may not exist */ }
    throw err;
  }
}

/**
 * Resolve a path inside a user's data directory, refusing anything that escapes it.
 * Every per-user file goes through here.
 */
export function userFilePath(userId: string, ...segments: string[]): string {
  if (!isValidUserId(userId)) throw new ClientError(`Invalid userId: ${JSON.stringify(userId)}`, "invalid_user_id");
  const root = path.resolve(getDataDir());
  const filePath = path.resolve(path.join(root, "users", userId, ...segments));
  if (!filePath.startsWith(root + path.sep)) {
    throw new ClientError("Refusing to access a path outside the data directory", "invalid_path");
  }
  return filePath;
}

/**
 * Move an unreadable file aside so its bytes survive, and the path becomes writable again.
 *
 * Every JSON store in this file is read-modify-write, so "return an empty default on a bad
 * read" is not a safe fallback - the very next write persists that empty default over the
 * real data. Day logs already did this; metrics.json and profile.json did not, which meant
 * one EIO on an SD card could silently reduce four months of weigh-ins to a single reading
 * with no error surfaced anywhere. Preserve first, then fall back.
 */
function quarantine(filePath: string, err: unknown, context: Record<string, unknown>): string | null {
  const log = getLogger();
  const dest = `${filePath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(filePath, dest);
    log.error({ err, ...context, filePath, quarantine: dest }, "file is unreadable - quarantined");
    return dest;
  } catch {
    // If we cannot even move it, do not let a later write clobber it. The throw is the
    // safest outcome available: loud, and it leaves the bytes where they are.
    log.error({ err, ...context, filePath }, "file is unreadable and could not be quarantined");
    return null;
  }
}

// A date must be a real calendar date in YYYY-MM-DD form.
// "2026-13-45" matches a naive regex but isn't a date, and would create a junk file
// that listDates() then returns and every chart chokes on.
export function isValidDate(date: unknown): date is string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

// A userId is a directory name, so it has to be one path segment of safe characters.
export function isValidUserId(userId: unknown): userId is string {
  return typeof userId === "string" && /^[a-z0-9_-]{1,32}$/i.test(userId);
}

// Build the full path to a user's daily food file, refusing anything that escapes DATA_DIR.
// Example: ./data/users/billy/food/2026-04-12.json
function getDayFilePath(userId: string, date: string): string {
  if (!isValidUserId(userId)) throw new ClientError(`Invalid userId: ${JSON.stringify(userId)}`, "invalid_user_id");
  if (!isValidDate(date)) throw new ClientError(`Invalid date: ${JSON.stringify(date)}`, "invalid_date");

  const root = path.resolve(getDataDir());
  const filePath = path.resolve(path.join(root, "users", userId, "food", `${date}.json`));

  // Belt and braces. The two validators above already make traversal impossible,
  // but this is the assertion that actually guarantees it.
  if (!filePath.startsWith(root + path.sep)) {
    throw new ClientError("Refusing to access a path outside the data directory", "invalid_path");
  }
  return filePath;
}

// Bring any historical file up to the current schema shape, in memory only.
//
// The corpus contains four schema generations: entries with `gpt_estimate` and `usda`
// sources, entries carrying fdc_id/fdc_description, and entries with all 29 nutrients
// present as numbers. None of them have batches, coverage, or a version marker.
// Normalizing on read means the API serves one shape and the frontend needs one code path,
// without rewriting a single byte of history until that day is next edited.
function normalizeDayLog(raw: any, userId: string, date: string): DayLog {
  const entries: FoodEntry[] = (Array.isArray(raw?.entries) ? raw.entries : []).map((e: any) => {
    const entry: FoodEntry = {
      id: typeof e?.id === "string" ? e.id : crypto.randomUUID(),
      food_name: String(e?.food_name ?? "unnamed item"),
      serving_description: String(e?.serving_description ?? "1 serving"),
      source: e?.source ?? "claude_estimate",
      nutrients: sanitizeNutrients(e?.nutrients),
    };
    // NOTE: this is an explicit whitelist, and it runs on every DELETE and PUT via
    // readDayLog -> buildDayLog -> writeDayLog. A field that is written to disk but not
    // listed here is erased from the entire day the next time any entry in it is touched.
    // Add new per-entry data inside `parsed` or `estimate`, which pass through wholesale.
    if (Number.isFinite(e?.water_ml)) entry.water_ml = e.water_ml;
    if (typeof e?.batch_id === "string") entry.batch_id = e.batch_id;
    if (typeof e?.logged_at === "string") entry.logged_at = e.logged_at;
    if (e?.parsed) entry.parsed = e.parsed;
    if (e?.estimate && typeof e.estimate === "object") entry.estimate = e.estimate;

    // Legacy USDA provenance lived as loose top-level fields; tuck it away rather than drop it.
    if (e?.fdc_id !== undefined || e?.fdc_description !== undefined) {
      entry.provenance = { fdc_id: e.fdc_id, fdc_description: e.fdc_description };
    } else if (e?.provenance) {
      entry.provenance = e.provenance;
    }

    // One historical water entry was written by the retired GPT path with no water_ml,
    // so `source === "water"` alone was never a reliable hydration filter. Recover the
    // volume from the name if we can.
    if (entry.water_ml === undefined && /^water\b/i.test(entry.food_name)) {
      const m = entry.food_name.match(/([\d.]+)\s*ml/i);
      if (m) entry.water_ml = Math.round(parseFloat(m[1]));
    }
    return entry;
  });

  const { totals, coverage } = sumNutrients(entries);

  return {
    schema_version: Number.isFinite(raw?.schema_version) ? raw.schema_version : 1,
    // Always the caller's date. A stale `date` inside the payload is not authoritative.
    date,
    userId,
    entries,
    daily_totals: totals,
    daily_coverage: coverage,
    daily_water_ml: sumWaterMl(entries),
    batches: Array.isArray(raw?.batches) ? (raw.batches as LogBatch[]) : [],
  };
}

// Read a user's food log for a day - returns null if the file doesn't exist yet.
// A file that exists but won't parse is quarantined rather than thrown, so one bad
// write can't wedge the whole day for reads.
export function readDayLog(userId: string, date: string): DayLog | null {
  const log = getLogger();
  const filePath = getDayFilePath(userId, date);

  if (!fs.existsSync(filePath)) {
    log.debug({ userId, date, filePath }, "day log not found");
    return null;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    log.error({ err, userId, date, filePath }, "failed to read day log");
    throw err;
  }

  // Parse and normalize are separated on purpose. Only a parse failure means the FILE is
  // corrupt; a normalize failure is our bug, and quarantining the user's day because of it
  // would turn a code defect into data loss.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    quarantine(filePath, err, { userId, date });
    return null;
  }

  const dayLog = normalizeDayLog(parsed, userId, date);
  log.debug({ userId, date, entryCount: dayLog.entries.length, filePath }, "read day log");
  return dayLog;
}

// Write (or overwrite) the day log file for a user, atomically.
// Creates the directory structure if it doesn't exist yet.
export function writeDayLog(dayLog: DayLog): string {
  const log = getLogger();
  const filePath = getDayFilePath(dayLog.userId, dayLog.date);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;

  const toWrite: DayLog = { ...dayLog, schema_version: SCHEMA_VERSION };

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Write to a temp file and fsync before renaming. rename() is atomic within a
    // filesystem, so a reader either sees the whole old file or the whole new one.
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(toWrite, null, 2), "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);

    log.info({
      userId: toWrite.userId,
      date: toWrite.date,
      entryCount: toWrite.entries.length,
      totalCalories: Math.round(toWrite.daily_totals.calories),
      filePath,
    }, "wrote day log");

    return filePath;
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* temp file may not exist */ }
    log.error({ err, userId: dayLog.userId, date: dayLog.date, filePath }, "failed to write day log");
    throw err;
  }
}

// Build a DayLog from a set of entries, recomputing every derived field from scratch.
// Totals are never adjusted incrementally, so a bad total self-heals on the next write.
export function buildDayLog(userId: string, date: string, entries: FoodEntry[], batches: LogBatch[]): DayLog {
  const { totals, coverage } = sumNutrients(entries);
  return {
    schema_version: SCHEMA_VERSION,
    date,
    userId,
    entries,
    daily_totals: totals,
    daily_coverage: coverage,
    daily_water_ml: sumWaterMl(entries),
    batches,
  };
}

// Append new entries to an existing day log, or create a new one if none exists.
export function appendEntries(
  userId: string,
  date: string,
  newEntries: FoodEntry[],
  batch?: LogBatch,
): { log: DayLog; filePath: string } {
  const logger = getLogger();

  const existing = readDayLog(userId, date);
  const allEntries = existing ? [...existing.entries, ...newEntries] : newEntries;
  const allBatches = existing ? [...existing.batches] : [];
  if (batch) allBatches.push(batch);

  const dayLog = buildDayLog(userId, date, allEntries, allBatches);
  const filePath = writeDayLog(dayLog);

  logger.info({
    userId,
    date,
    newEntries: newEntries.length,
    totalEntries: allEntries.length,
    totalCalories: Math.round(dayLog.daily_totals.calories),
  }, "appended entries to day log");

  return { log: dayLog, filePath };
}

// List all dates that have food logs for a user.
// Returns YYYY-MM-DD strings sorted newest first, ignoring anything that isn't a real date.
export function listDates(userId: string): string[] {
  const log = getLogger();
  if (!isValidUserId(userId)) throw new ClientError(`Invalid userId: ${JSON.stringify(userId)}`, "invalid_user_id");

  const foodDir = path.join(path.resolve(getDataDir()), "users", userId, "food");

  if (!fs.existsSync(foodDir)) {
    log.debug({ userId, foodDir }, "food directory not found");
    return [];
  }

  const dates = fs.readdirSync(foodDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter(isValidDate)
    .sort()
    .reverse();

  log.debug({ userId, dateCount: dates.length }, "listed dates");
  return dates;
}

// Summaries for every logged day in an inclusive date range.
//
// This is the endpoint the history charts run on. Without it, drawing a 90-day trend
// means 90 sequential HTTP round trips to a Pi behind a tunnel - about 19 seconds at the
// ~209ms per request measured over the live tunnel, for data that fits in one response.
//
// Days with no file are omitted entirely rather than returned as zeros: "didn't log" and
// "ate nothing" are different, and a chart that draws the first as a 0 kcal day is lying.
export function readRange(userId: string, from: string, to: string): DaySummary[] {
  const log = getLogger();
  if (!isValidDate(from)) throw new ClientError(`Invalid 'from' date: ${JSON.stringify(from)}`, "invalid_date");
  if (!isValidDate(to)) throw new ClientError(`Invalid 'to' date: ${JSON.stringify(to)}`, "invalid_date");
  if (from > to) throw new ClientError("'from' must be on or before 'to'", "invalid_range");

  const dates = listDates(userId).filter((d) => d >= from && d <= to).sort();

  const summaries: DaySummary[] = [];
  for (const date of dates) {
    const day = readDayLog(userId, date);
    if (!day) continue;
    summaries.push({
      date: day.date,
      entry_count: day.entries.length,
      daily_totals: day.daily_totals,
      daily_coverage: day.daily_coverage,
      daily_water_ml: day.daily_water_ml,
    });
  }

  log.debug({ userId, from, to, dayCount: summaries.length }, "read range");
  return summaries;
}

/**
 * What you actually eat, aggregated across a range.
 *
 * Done server-side because the alternative is shipping every entry in the window to the
 * browser just to count them - roughly 8 entries x 29 nutrients per day, so a 90-day
 * "what do I eat most" question would move megabytes to answer with twenty rows.
 *
 * Grouped on a normalized name rather than the raw string: the corpus has 180 distinct
 * food_names for 226 entries, including three spellings of the same magnesium gummy, so
 * grouping on the display string would report almost everything as a one-off.
 */
export interface FoodStat {
  key: string;
  name: string;
  count: number;
  total_calories: number;
  avg_calories: number;
}

function foodKey(name: string): string {
  return name
    .toLowerCase()
    // Drop the trailing serving parenthetical food_name is built with - "(3 stick)" -
    // so the same food at two portions still groups together.
    .replace(/\s*\([\d.]+\s+[^()]*\)\s*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function readFoodStats(userId: string, from: string, to: string, limit = 20): FoodStat[] {
  if (!isValidDate(from)) throw new ClientError(`Invalid 'from' date: ${JSON.stringify(from)}`, "invalid_date");
  if (!isValidDate(to)) throw new ClientError(`Invalid 'to' date: ${JSON.stringify(to)}`, "invalid_date");

  const byKey = new Map<string, FoodStat & { names: Map<string, number> }>();

  for (const date of listDates(userId).filter((d) => d >= from && d <= to)) {
    const day = readDayLog(userId, date);
    if (!day) continue;
    for (const entry of day.entries) {
      // Water is logged as an entry but isn't food, and it would otherwise top the list.
      if (entry.source === "water") continue;
      const key = foodKey(entry.food_name);
      if (!key) continue;
      const cal = entry.nutrients?.calories;
      const stat = byKey.get(key) ?? { key, name: entry.food_name, count: 0, total_calories: 0, avg_calories: 0, names: new Map() };
      stat.count += 1;
      if (typeof cal === "number" && Number.isFinite(cal)) stat.total_calories += cal;
      stat.names.set(entry.food_name, (stat.names.get(entry.food_name) ?? 0) + 1);
      byKey.set(key, stat);
    }
  }

  return [...byKey.values()]
    .map((s) => {
      // Label the group with whichever spelling you used most - the canonical-looking one.
      const name = [...s.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? s.name;
      return {
        key: s.key,
        name,
        count: s.count,
        total_calories: Math.round(s.total_calories),
        avg_calories: Math.round(s.total_calories / s.count),
      };
    })
    .sort((a, b) => b.total_calories - a.total_calories || b.count - a.count)
    .slice(0, limit);
}

// ── Goals ──────────────────────────────────────────────────────────────────
//
// One small JSON file per user, next to their food/ directory. Same atomic-write and
// path-validation rules as a day log, for the same reasons.

function getProfilePath(userId: string): string {
  if (!isValidUserId(userId)) throw new ClientError(`Invalid userId: ${JSON.stringify(userId)}`, "invalid_user_id");
  const root = path.resolve(getDataDir());
  const filePath = path.resolve(path.join(root, "users", userId, "profile.json"));
  if (!filePath.startsWith(root + path.sep)) {
    throw new ClientError("Refusing to access a path outside the data directory", "invalid_path");
  }
  return filePath;
}

// Coerce arbitrary input into a valid Goals object, falling back per-field to the default.
// A goal of 0 or a negative number would make every "percent of target" render as Infinity
// or a negative bar, so those are rejected rather than stored.
export function sanitizeGoals(input: unknown, base: Goals = DEFAULT_GOALS): Goals {
  const out: Goals = { ...base };
  if (!input || typeof input !== "object") return out;
  const raw = input as Record<string, unknown>;
  for (const key of GOAL_KEYS) {
    const v = raw[key];

    // Absent means "leave this one alone" - a partial update must not reset the rest.
    if (v === undefined) continue;

    // An explicit null or "" means "clear this target", and is only honoured for the
    // optional ones. Without this branch an optional goal could be set but never unset:
    // the value was skipped as unparseable, merged back over itself by writeGoals, and
    // the UI reported "Saved" while the old goal line stayed on every chart.
    // The required goals have no meaningful empty state - clearing calories would make
    // every "percent of target" render as Infinity - so for those, blank still means
    // "unchanged".
    if (v === null || v === "") {
      if (OPTIONAL_GOAL_KEYS.includes(key)) delete out[key];
      continue;
    }

    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    (out[key] as number) = n;
  }
  if (raw.weight_unit === "lb" || raw.weight_unit === "kg") out.weight_unit = raw.weight_unit;
  if (raw.distance_unit === "mi" || raw.distance_unit === "km") out.distance_unit = raw.distance_unit;
  return out;
}

// Read a user's goals. Missing or unreadable file means "never set them" - hand back the
// defaults rather than failing, so a fresh install still renders every chart.
export function readGoals(userId: string): Goals {
  const filePath = getProfilePath(userId);
  if (!fs.existsSync(filePath)) return { ...DEFAULT_GOALS };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return sanitizeGoals(parsed?.goals ?? parsed);
  } catch (err) {
    // Quarantine before falling back. writeGoals merges onto whatever this returns, so a
    // silent fallback to defaults means the next Settings save permanently overwrites the
    // real targets with DEFAULT_GOALS - and reports "Saved" while doing it.
    quarantine(filePath, err, { userId });
    return { ...DEFAULT_GOALS };
  }
}

// Write a user's goals atomically. Returns the sanitized values that actually landed.
export function writeGoals(userId: string, goals: unknown): Goals {
  const log = getLogger();
  const filePath = getProfilePath(userId);
  // Merge onto what is already stored, so a partial update doesn't reset the other fields.
  const clean = sanitizeGoals(goals, readGoals(userId));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify({ userId, goals: clean }, null, 2), "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
    log.info({ userId, goals: clean }, "wrote goals");
    return clean;
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* temp file may not exist */ }
    log.error({ err, userId, filePath }, "failed to write goals");
    throw err;
  }
}

// ── Daily metrics ──────────────────────────────────────────────────────────
//
// Weight, distance walked, sleep - one file, one shape, one set of endpoints.
//
// Kept out of the day logs for the same reason weight was: you can weigh yourself, or walk,
// on a day you never log food. Putting these in the day log would mean creating a day file
// with zero food entries, and an entry-less day is treated everywhere as a gap - so a
// weigh-in on a fasting day would have registered as a 0 kcal day and dragged every
// average down.

function getMetricsPath(userId: string): string {
  if (!isValidUserId(userId)) throw new ClientError(`Invalid userId: ${JSON.stringify(userId)}`, "invalid_user_id");
  const root = path.resolve(getDataDir());
  const filePath = path.resolve(path.join(root, "users", userId, "metrics.json"));
  if (!filePath.startsWith(root + path.sep)) {
    throw new ClientError("Refusing to access a path outside the data directory", "invalid_path");
  }
  return filePath;
}

type MetricsFile = { userId: string; entries: Record<string, DayMetrics> };

function readMetricsFile(userId: string): MetricsFile {
  const filePath = getMetricsPath(userId);
  if (!fs.existsSync(filePath)) return { userId, entries: {} };

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    // A read error is transient (EIO, EACCES), not corruption. Returning {} here would let
    // the next writeMetric persist an empty file over the whole weight/sleep/distance
    // history - the one dataset with no per-day granularity to recover from. Rethrow so
    // the request fails visibly instead.
    getLogger().error({ err, userId, filePath }, "failed to read metrics file");
    throw err;
  }

  try {
    const parsed = JSON.parse(raw);
    const entries: Record<string, DayMetrics> = {};
    for (const [date, raw] of Object.entries(parsed?.entries ?? {})) {
      if (!isValidDate(date)) continue;
      const day: DayMetrics = {};
      for (const key of METRIC_KEYS) {
        const r = (raw as any)?.[key];
        const value = Number(r?.value);
        if (!Number.isFinite(value) || value <= 0) continue;
        const def = METRICS[key];
        day[key] = {
          value,
          unit: def.units.includes(r?.unit) ? r.unit : def.units[0],
          logged_at: typeof r?.logged_at === "string" ? r.logged_at : new Date().toISOString(),
        };
      }
      if (Object.keys(day).length > 0) entries[date] = day;
    }
    return { userId, entries };
  } catch (err) {
    quarantine(filePath, err, { userId });
    return { userId, entries: {} };
  }
}

function writeMetricsFile(userId: string, file: MetricsFile): void {
  const log = getLogger();
  const filePath = getMetricsPath(userId);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(file, null, 2), "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* temp file may not exist */ }
    log.error({ err, userId, filePath }, "failed to write metrics file");
    throw err;
  }
}

function toPoint(date: string, metric: MetricKey, r: MetricReading): MetricPoint {
  return { ...r, date, metric, in: convertMetric(metric, r.value, r.unit) };
}

/** Every reading in a range, oldest first. Optionally filtered to one metric. */
export function readMetrics(userId: string, from?: string, to?: string, metric?: MetricKey): MetricPoint[] {
  const { entries } = readMetricsFile(userId);
  const out: MetricPoint[] = [];
  for (const [date, day] of Object.entries(entries)) {
    if ((from && date < from) || (to && date > to)) continue;
    for (const key of METRIC_KEYS) {
      if (metric && key !== metric) continue;
      const r = day[key];
      if (r) out.push(toPoint(date, key, r));
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.metric.localeCompare(b.metric));
}

/**
 * Record (or replace) one metric for one day.
 *
 * One reading per metric per day: weighing yourself twice in a morning should correct the
 * number, not put two points on the chart.
 */
export function writeMetric(userId: string, date: string, metric: string, value: unknown, unit: unknown): MetricPoint {
  const log = getLogger();
  if (!isValidDate(date)) throw new ClientError(`Invalid date: ${JSON.stringify(date)}`, "invalid_date");
  if (!METRIC_KEYS.includes(metric as MetricKey)) {
    throw new ClientError(`Unknown metric: ${JSON.stringify(metric)}`, "unknown_metric");
  }
  const key = metric as MetricKey;
  const def = METRICS[key];

  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ClientError(`${def.label} must be a number greater than zero`, "invalid_metric");
  }
  const u = typeof unit === "string" && def.units.includes(unit) ? unit : def.units[0];
  // Unit-aware ceiling. A single flat bound can't serve pounds and hours at once - and a
  // loose one is worse than none: 1814 once sailed through a flat max of 2000.
  if (n > def.max[u]) {
    throw new ClientError(`That looks like a typo - the most this accepts is ${def.max[u]} ${u}`, "invalid_metric");
  }
  // Food can be logged before you eat it; you cannot weigh yourself, walk, or sleep on a
  // day that hasn't happened. One day of slack absorbs a client in a timezone ahead of us.
  if (date > shiftDays(todayDateString(), 1)) {
    throw new ClientError(`You can't record ${def.label.toLowerCase()} for a future date`, "future_metric");
  }

  const file = readMetricsFile(userId);
  const day = file.entries[date] ?? {};
  day[key] = { value: n, unit: u, logged_at: new Date().toISOString() };
  file.entries[date] = day;
  writeMetricsFile(userId, file);
  log.info({ userId, date, metric: key, value: n, unit: u }, "wrote metric");
  return toPoint(date, key, day[key]!);
}

export function deleteMetric(userId: string, date: string, metric: string): boolean {
  if (!isValidDate(date)) throw new ClientError(`Invalid date: ${JSON.stringify(date)}`, "invalid_date");
  if (!METRIC_KEYS.includes(metric as MetricKey)) {
    throw new ClientError(`Unknown metric: ${JSON.stringify(metric)}`, "unknown_metric");
  }
  const file = readMetricsFile(userId);
  const day = file.entries[date];
  if (!day || !day[metric as MetricKey]) return false;
  delete day[metric as MetricKey];
  if (Object.keys(day).length === 0) delete file.entries[date];
  writeMetricsFile(userId, file);
  getLogger().info({ userId, date, metric }, "deleted metric");
  return true;
}

/** Shift a YYYY-MM-DD by N days. Noon avoids the DST-midnight-rolls-backwards trap. */
function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Return today's date as a YYYY-MM-DD string in local time.
// Server-local only - clients should send their own date so a late-night log
// filed from a different timezone lands on the day the user thinks it did.
export function todayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  // getMonth() is 0-indexed so we add 1, then pad to 2 digits
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Re-export so callers don't need to reach into types.ts for the nutrient list
export { NUTRIENT_KEYS };
