// All backend calls live here. One fetch wrapper, one error shape, no data fetching
// scattered through components.
//
// Base URL resolution:
//   dev  - "/api", which vite.config.ts proxies to the Pi so the browser sees same-origin
//   prod - VITE_API_BASE (set at build time), defaulting to the public tunnel hostname
//
// The API is currently unauthenticated. When auth lands, `authHeaders()` below is the
// single place a bearer token needs to be attached.

import { getToken, onUnauthorized, getSession } from "./session";
import { demoApi } from "./demoApi";
import type { DayLog, DaySummary, LogPreview, ConfirmResult, FoodEntry, Nutrients, ParsedFood, Goals, MetricPoint, MetricKey } from "./types";

const BASE = import.meta.env.DEV
  ? "/api"
  : (import.meta.env.VITE_API_BASE as string | undefined) ?? "https://voicebite.billmill.dev";

export const USER = (import.meta.env.VITE_USER as string | undefined) ?? "billy";

/** Thrown for any non-2xx response, carrying the server's stable error code. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...authHeaders(),
        ...init?.headers,
      },
    });
  } catch {
    // fetch only rejects on network failure, so this is "the Pi is unreachable"
    // rather than anything the server said.
    throw new ApiError(0, "network_error", "Can't reach the server. Is the Pi online?");
  }

  const text = await res.text();
  let body: any = null;
  if (text) {
    try { body = JSON.parse(text); } catch { /* non-JSON body handled below */ }
  }

  if (!res.ok) {
    // A rejected token means the session is over - expired, or AUTH_SECRET was rotated.
    // Drop it here rather than letting every subsequent screen fail the same way.
    if (res.status === 401) onUnauthorized();
    const code = body?.error?.code ?? "http_error";
    const message = body?.error?.message ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, code, message);
  }
  return body as T;
}

/** YYYY-MM-DD for a Date, in the browser's local timezone (not UTC). */
export function toDateString(d: Date = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Shift a YYYY-MM-DD string by N days without tripping over timezones. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return toDateString(d);
}

const realApi = {
  health: () =>
    request<{ ok: boolean; model: string; schemaVersion: number; uptimeSeconds: number }>("/health"),

  /** Submit text for parsing. Returns a preview - nothing is saved until confirm(). */
  log: (text: string, date: string, overwrite = false) =>
    request<LogPreview>("/log", {
      method: "POST",
      body: JSON.stringify({ text, date, userId: USER, overwrite }),
    }),

  /**
   * Save a previewed session. Pass `entries` to save an edited version of the preview -
   * the server accepts only entries whose ids came from this session, so you can revise
   * or drop rows but not invent new ones.
   */
  confirm: (sessionId: string, opts?: { entries?: FoodEntry[]; overwrite?: boolean }) =>
    request<ConfirmResult>(`/confirm/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      body: JSON.stringify({ userId: USER, ...opts }),
    }),

  /** Re-estimate one item without saving. Used to fix a bad row in the preview. */
  estimate: (food: ParsedFood) =>
    request<{ parsed: ParsedFood; nutrients: Nutrients }>("/estimate", {
      method: "POST",
      body: JSON.stringify(food),
    }),

  day: (date: string) =>
    request<DayLog>(`/log/${USER}/${date}`),

  dates: () =>
    request<{ userId: string; dates: string[] }>(`/log/${USER}/dates`),

  /** Day summaries across a range - one request, however many days. Powers the charts. */
  range: (from: string, to: string) =>
    request<{ from: string; to: string; days: DaySummary[] }>(
      `/log/${USER}/range?from=${from}&to=${to}`,
    ),

  addEntry: (date: string, entry: { food_name: string; serving_description?: string; nutrients?: Partial<Nutrients>; water_ml?: number }) =>
    request<{ entry: FoodEntry; log: DayLog }>(`/log/${USER}/${date}/entries`, {
      method: "POST",
      body: JSON.stringify(entry),
    }),

  updateEntry: (date: string, entryId: string, patch: Partial<Pick<FoodEntry, "food_name" | "serving_description" | "nutrients" | "water_ml">>) =>
    request<{ entry: FoodEntry; log: DayLog }>(`/log/${USER}/${date}/${entryId}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  /** Most-eaten foods across a window, aggregated on the server. */
  foods: (from: string, to: string, limit = 20) =>
    request<{ foods: Array<{ key: string; name: string; count: number; total_calories: number; avg_calories: number }> }>(
      `/log/${USER}/foods?from=${from}&to=${to}&limit=${limit}`,
    ),

  /**
   * Daily metrics: weight, distance walked, sleep. One shape for all three.
   *
   * Kept outside the day logs so recording one on a day you didn't eat-log doesn't create
   * an entry-less day that every chart reads as a 0 kcal gap.
   */
  metrics: (from?: string, to?: string, metric?: MetricKey) => {
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    if (metric) q.set("metric", metric);
    const qs = q.toString();
    return request<{ metrics: MetricPoint[] }>(`/metrics/${USER}${qs ? `?${qs}` : ""}`);
  },

  putMetric: (date: string, metric: MetricKey, value: number, unit: string) =>
    request<{ metric: MetricPoint }>(`/metrics/${USER}/${date}/${metric}`, {
      method: "PUT",
      body: JSON.stringify({ value, unit }),
    }),

  deleteMetric: (date: string, metric: MetricKey) =>
    request<{ success: boolean }>(`/metrics/${USER}/${date}/${metric}`, { method: "DELETE" }),

  /** Daily targets. Server-side so the phone and the desktop agree - see goals.ts. */
  getGoals: () => request<{ userId: string; goals: Goals }>(`/profile/${USER}`),

  putGoals: (goals: Partial<Goals>) =>
    request<{ userId: string; goals: Goals }>(`/profile/${USER}`, {
      method: "PUT",
      body: JSON.stringify({ goals }),
    }),

  deleteEntry: (date: string, entryId: string) =>
    request<{ deleted: FoodEntry; log: DayLog }>(`/log/${USER}/${date}/${entryId}`, {
      method: "DELETE",
    }),
}

/**
 * Route every call to the real backend or the in-browser demo, decided per call.
 *
 * A Proxy rather than two imports so no screen needs to know which mode it's in - the
 * choice is made at call time, which also means signing in or out takes effect immediately
 * instead of on the next remount.
 *
 * `health` deliberately always hits the real server: in demo mode it's what tells you the
 * Pi is reachable for the one live call the demo does make (parsing).
 */
export const api = new Proxy({} as typeof realApi, {
  get(_target, prop: string) {
    if (prop === "health") return realApi.health;
    const impl = getSession().mode === "demo" ? (demoApi as any) : (realApi as any);
    return impl[prop] ?? (realApi as any)[prop];
  },
});
