// demoApi.ts
// The same surface as the real API, backed by an in-memory dataset instead of the Pi.
//
// Why the demo lives here and not on the server: a shared `demo` user would mean visitors
// stomping each other's edits, one person emptying the charts for everyone after them, and
// a reset job with no natural trigger. In the browser each visitor gets a private copy,
// and "erases at the end of the session" costs nothing - closing the tab is the reset.
//
// The one thing that is NOT faked is parsing. Turning a spoken sentence into structured
// nutrition is the entire point of the product; a canned response would demo nothing. That
// call goes to /demo/parse, which is open but hard rate-limited and writes nothing.

import type {
  ConfirmResult, DayLog, DaySummary, FoodEntry, Goals, LogBatch, LogPreview,
  Nutrients, ParsedFood, MetricPoint, MetricKey,
} from "./types";
import { DEFAULT_GOALS, NUTRIENT_KEYS, METRICS, METRIC_KEYS } from "./types";
import { generateDemoData, toDayLog, toSummary, dayOffset, DEMO_DAYS } from "./demoData";

const BASE = import.meta.env.DEV
  ? "/api"
  : (import.meta.env.VITE_API_BASE as string | undefined) ?? "https://voicebite.billmill.dev";

// Generated once per page load, anchored on today. A reload rolls the window forward.
const data = generateDemoData();
let goals: Goals = { ...DEFAULT_GOALS };

// Pending previews, exactly like the server's session map - so the preview/confirm flow
// behaves identically and the screens need no demo-specific branches.
const sessions = new Map<string, { date: string; entries: FoodEntry[]; transcript: string }>();

const uid = () => `demo-${Math.random().toString(36).slice(2, 10)}`;

class DemoError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ApiError"; // screens branch on ApiError.code; keep that working
  }
}

function ensureDay(date: string) {
  if (!data.days.has(date)) data.days.set(date, { entries: [], batches: [] });
  return data.days.get(date)!;
}

function dayOrThrow(date: string): DayLog {
  const d = data.days.get(date);
  if (!d || d.entries.length === 0) {
    throw new DemoError(404, "day_not_found", `No log for ${date}`);
  }
  return toDayLog(date, d);
}

/** Parse for real. This is the only demo call that touches the network. */
async function parseText(text: string): Promise<{ transcript: string; entries: FoodEntry[] }> {
  const res = await fetch(`${BASE}/demo/parse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch(() => {
    throw new DemoError(0, "network_error", "Can't reach the server. Is the Pi online?");
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new DemoError(res.status, body?.error?.code ?? "http_error", body?.error?.message ?? "Couldn't parse that");
  }
  return body;
}

export const demoApi = {
  health: () =>
    Promise.resolve({ ok: true, model: "demo", schemaVersion: 2, uptimeSeconds: 0 }),

  dates: async () => ({
    userId: "demo",
    dates: [...data.days.keys()].filter((d) => (data.days.get(d)?.entries.length ?? 0) > 0).sort().reverse(),
  }),

  day: async (date: string) => dayOrThrow(date),

  range: async (from: string, to: string) => {
    const days: DaySummary[] = [];
    for (const [date, d] of data.days) {
      if (date >= from && date <= to && d.entries.length > 0) days.push(toSummary(date, d));
    }
    days.sort((a, b) => a.date.localeCompare(b.date));
    return { from, to, days };
  },

  foods: async (from: string, to: string, limit = 20) => {
    const byKey = new Map<string, { key: string; name: string; count: number; total_calories: number }>();
    for (const [date, d] of data.days) {
      if (date < from || date > to) continue;
      for (const e of d.entries) {
        if (e.source === "water") continue;
        const key = e.food_name.toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").trim();
        const row = byKey.get(key) ?? { key, name: e.food_name, count: 0, total_calories: 0 };
        row.count += 1;
        row.total_calories += e.nutrients.calories ?? 0;
        byKey.set(key, row);
      }
    }
    const foods = [...byKey.values()]
      .map((r) => ({ ...r, total_calories: Math.round(r.total_calories), avg_calories: Math.round(r.total_calories / r.count) }))
      .sort((a, b) => b.total_calories - a.total_calories)
      .slice(0, limit);
    return { foods };
  },

  metrics: async (from?: string, to?: string, metric?: MetricKey) => ({
    metrics: data.metrics
      .filter((m) => (!from || m.date >= from) && (!to || m.date <= to) && (!metric || m.metric === metric))
      .sort((a, b) => a.date.localeCompare(b.date)),
  }),

  putMetric: async (date: string, metric: MetricKey, value: number, unit: string) => {
    if (date > dayOffset(0)) {
      throw new DemoError(400, "future_metric", `You can't record ${METRICS[metric].label.toLowerCase()} for a future date`);
    }
    if (!METRIC_KEYS.includes(metric)) throw new DemoError(400, "unknown_metric", "Unknown metric");
    const def = METRICS[metric];
    if (value > (def.max[unit] ?? Infinity)) {
      throw new DemoError(400, "invalid_metric", `That looks like a typo - the most this accepts is ${def.max[unit]} ${unit}`);
    }
    const units: Record<string, number> =
      metric === "weight"
        ? unit === "kg" ? { kg: value, lb: Math.round(value * 2.2046226218 * 1000) / 1000 } : { lb: value, kg: Math.round((value / 2.2046226218) * 1000) / 1000 }
        : metric === "distance"
          ? unit === "km" ? { km: value, mi: Math.round((value / 1.609344) * 1000) / 1000 } : { mi: value, km: Math.round(value * 1.609344 * 1000) / 1000 }
          : { h: value };
    const point: MetricPoint = { date, metric, value, unit, logged_at: new Date().toISOString(), in: units };
    data.metrics = data.metrics.filter((m) => !(m.date === date && m.metric === metric));
    data.metrics.push(point);
    return { metric: point };
  },

  deleteMetric: async (date: string, metric: MetricKey) => {
    data.metrics = data.metrics.filter((m) => !(m.date === date && m.metric === metric));
    return { success: true };
  },

  getGoals: async () => ({ userId: "demo", goals }),
  putGoals: async (patch: Partial<Goals>) => {
    goals = { ...goals, ...patch };
    return { userId: "demo", goals };
  },

  log: async (text: string, date: string): Promise<LogPreview> => {
    const { entries } = await parseText(text);
    const sessionId = uid();
    sessions.set(sessionId, { date, entries, transcript: text });

    const existing = data.days.get(date);
    const sum = (fn: (e: FoodEntry) => number | null) => entries.reduce((a, e) => a + (fn(e) ?? 0), 0);

    return {
      sessionId,
      date,
      transcript: text,
      entries,
      summary: {
        totalCalories: Math.round(sum((e) => e.nutrients.calories)),
        totalProtein_g: Math.round(sum((e) => e.nutrients.protein_g) * 10) / 10,
        totalFat_g: Math.round(sum((e) => e.nutrients.fat_g) * 10) / 10,
        totalCarbs_g: Math.round(sum((e) => e.nutrients.carbs_g) * 10) / 10,
      },
      existingEntries: existing?.entries.length ?? 0,
      existingCalories: existing ? Math.round(toDayLog(date, existing).daily_totals.calories) : 0,
    };
  },

  confirm: async (sessionId: string, opts?: { entries?: FoodEntry[]; overwrite?: boolean }): Promise<ConfirmResult> => {
    const s = sessions.get(sessionId);
    if (!s) throw new DemoError(404, "session_not_found", "That preview expired. Please re-submit.");

    // Mirror the server: only ids that came from this preview may be saved.
    const allowed = new Map(s.entries.map((e) => [e.id, e]));
    const toSave = opts?.entries
      ? opts.entries.filter((e) => allowed.has(e.id)).map((e) => ({ ...allowed.get(e.id)!, ...e }))
      : s.entries;

    const batch: LogBatch = {
      batch_id: uid(),
      logged_at: new Date().toISOString(),
      transcript: s.transcript,
      entry_count: toSave.length,
    };
    const stamped = toSave.map((e) => ({ ...e, batch_id: batch.batch_id }));

    const day = ensureDay(s.date);
    if (opts?.overwrite) {
      day.entries = stamped;
      day.batches = [batch];
    } else {
      day.entries = [...day.entries, ...stamped];
      day.batches = [...day.batches, batch];
    }
    sessions.delete(sessionId);

    const log = toDayLog(s.date, day);
    return {
      success: true,
      message: `Logged ${stamped.length} new entries for ${s.date}. Day total: ${log.entries.length} entries, ${Math.round(log.daily_totals.calories)} calories`,
      log,
    };
  },

  // `ref` is accepted and ignored: demo data has no stored batches to recover a
  // transcript from, and the signature has to match the real api.
  estimate: async (food: ParsedFood, _ref?: { date: string; entryId: string }): Promise<{ parsed: ParsedFood; nutrients: Nutrients }> => {
    // Re-uses the same open parse endpoint rather than adding a second one.
    const { entries } = await parseText(`${food.quantity} ${food.unit} of ${food.name}`);
    if (entries.length === 0) throw new DemoError(422, "no_food_found", "Couldn't estimate that.");
    return { parsed: food, nutrients: entries[0].nutrients };
  },

  addEntry: async (date: string, entry: { food_name: string; serving_description?: string; nutrients?: Partial<Nutrients>; water_ml?: number }) => {
    const day = ensureDay(date);
    const zeroed = Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, null])) as Nutrients;
    const created: FoodEntry = {
      id: uid(),
      food_name: entry.food_name,
      serving_description: entry.serving_description ?? "1 serving",
      source: entry.water_ml !== undefined ? "water" : "claude_estimate",
      nutrients: { ...zeroed, ...(entry.nutrients as Nutrients | undefined) },
      water_ml: entry.water_ml,
    };
    day.entries.push(created);
    return { entry: created, log: toDayLog(date, day) };
  },

  updateEntry: async (date: string, entryId: string, patch: Partial<FoodEntry>) => {
    const day = ensureDay(date);
    const idx = day.entries.findIndex((e) => e.id === entryId);
    if (idx === -1) throw new DemoError(404, "entry_not_found", "That entry is gone.");
    day.entries[idx] = {
      ...day.entries[idx],
      ...patch,
      nutrients: patch.nutrients
        ? { ...day.entries[idx].nutrients, ...patch.nutrients }
        : day.entries[idx].nutrients,
    };
    return { entry: day.entries[idx], log: toDayLog(date, day) };
  },

  deleteEntry: async (date: string, entryId: string) => {
    const day = ensureDay(date);
    const idx = day.entries.findIndex((e) => e.id === entryId);
    if (idx === -1) throw new DemoError(404, "entry_not_found", "That entry is gone.");
    const [deleted] = day.entries.splice(idx, 1);
    return { deleted, log: toDayLog(date, day) };
  },
};

export { DEMO_DAYS };
