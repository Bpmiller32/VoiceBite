// One day at a time: what the totals were, what was eaten, and - the part that took two
// rewrites to get right - how much of each total is actually KNOWN.
//
// `daily_totals` is only ever the sum of the entries that had a value for that nutrient,
// so a total shown on its own is a half-truth. Every figure here carries its coverage,
// and a nutrient nobody estimated says "no data" instead of drawing a 0% bar. The 0% bar
// is the specific bug this screen exists to kill: the old version rendered "0 mg iron,
// 0% of RDA" for days where iron simply hadn't been estimated, and the user spent a month
// believing in deficiencies that were never in the data.

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError, shiftDate, toDateString } from "./api";
import { useGoals } from "./goals";
import { useCountUp } from "./useCountUp";
import MetricsCard from "./MetricsCard";
import { useAsync } from "./useAsync";
import { NUTRIENT_KEYS, NUTRIENT_META, RDA, fmt } from "./types";
import type { DayLog, FoodEntry, Goals, NutrientKey, Nutrients, ParsedFood } from "./types";

interface TodayScreenProps {
  date: string;
  onDateChange: (d: string) => void;
  refreshKey: number;
}

/** Shown as headline stats, so the micronutrient list covers everything else. */
const HEADLINE_KEYS: NutrientKey[] = ["calories", "protein_g", "carbs_g", "fat_g"];
const MICRO_KEYS: NutrientKey[] = NUTRIENT_KEYS.filter((k) => !HEADLINE_KEYS.includes(k));

/**
 * How many unknown micronutrients before an entry is worth offering to re-estimate.
 * Set high on purpose: a couple of gaps is normal and honest, and a "fix me" affordance on
 * every row would be noise. Two thirds missing means the estimate was genuinely thin.
 */
const SPARSE_THRESHOLD = 16;

/** Fields the inline editor exposes. The other 25 nutrients stay as Claude estimated them. */
const EDITABLE_KEYS: NutrientKey[] = ["calories", "protein_g", "carbs_g", "fat_g"];

export default function TodayScreen({ date, onDateChange, refreshKey }: TodayScreenProps) {
  const day = useAsync<DayLog | null>(
    () =>
      api.day(date).catch((err: unknown) => {
        // A 404 is not a failure here. This tracker has gaps in it - a three-month dormant
        // stretch, plenty of skipped days - so "nothing logged" is an ordinary state and
        // deserves an empty state, not a red banner.
        if (err instanceof ApiError && (err.code === "day_not_found" || err.status === 404)) {
          return null;
        }
        throw err;
      }),
    [date, refreshKey],
  );

  // Mutations return the recomputed log, and deletes apply optimistically, so the rendered
  // log can legitimately be ahead of what useAsync last fetched.
  const [override, setOverride] = useState<DayLog | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetched = day.data;
  useEffect(() => {
    // A fresh fetch (new date, or the parent bumped refreshKey after a save) supersedes any
    // local edit state - keeping a half-open editor across a date change was disorienting.
    setOverride(null);
    setActionError(null);
    setConfirmingId(null);
    setEditingId(null);
  }, [fetched]);

  // Re-read on refreshKey so saving goals elsewhere is reflected without a reload.
  const goals = useGoals();

  const log = override ?? fetched;
  const hasEntries = !!log && log.entries.length > 0;

  // A write is addressed to the day it was fired from, but the arrows move faster than a
  // round trip. Without this, deleting an item and immediately tapping "previous day"
  // painted the *old* day's returned log over the new day's header - the food from
  // Tuesday listed under Monday, which is indistinguishable from data corruption.
  const [filling, setFilling] = useState(false);
  const dateRef = useRef(date);
  dateRef.current = date;

  async function handleDelete(entry: FoodEntry) {
    if (!log) return;
    const forDate = date;
    const previous = log;
    setConfirmingId(null);
    setActionError(null);
    setBusyId(entry.id);
    setOverride(recomputeLog(log, log.entries.filter((e) => e.id !== entry.id)));
    try {
      const res = await api.deleteEntry(forDate, entry.id);
      // The delete still happened on the server; it just isn't this screen's day anymore.
      if (dateRef.current !== forDate) return;
      setOverride(res.log);
    } catch (err) {
      if (dateRef.current !== forDate) return;
      setOverride(previous);
      setActionError(errorMessage(err, `Couldn't delete "${entry.food_name}".`));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Re-ask Claude for one entry's nutrients and save the result.
   *
   * This is what turns the coverage numbers from a caveat into a to-do. Before it existed
   * the UI could tell you "sodium came from 6 of 9 items" but gave you no way to do
   * anything about it short of deleting the row and re-dictating the whole meal.
   *
   * Only `nutrients` is written - the name and serving you see are left exactly as they
   * are, so a re-estimate can never quietly change what you said you ate.
   */
  async function handleReestimate(entry: FoodEntry) {
    const forDate = date;
    setActionError(null);
    setBusyId(entry.id);
    try {
      const { nutrients } = await api.estimate(parsedFromEntry(entry));
      if (dateRef.current !== forDate) return;
      const res = await api.updateEntry(forDate, entry.id, { nutrients });
      if (dateRef.current !== forDate) return;
      setOverride(res.log);
    } catch (err) {
      if (dateRef.current !== forDate) return;
      setActionError(errorMessage(err, `Couldn't re-estimate "${entry.food_name}".`));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Re-estimate every thin entry in the day, one at a time.
   *
   * Sequential rather than parallel: each item is a separate paid model call, and the
   * server rate-limits /estimate. Stops at the first failure and reports it rather than
   * hammering through - if the Pi is down, item two will fail the same way item one did.
   */
  async function handleFillGaps(entries: FoodEntry[]) {
    const forDate = date;
    setActionError(null);
    setFilling(true);
    try {
      for (const entry of entries) {
        setBusyId(entry.id);
        const { nutrients } = await api.estimate(parsedFromEntry(entry));
        if (dateRef.current !== forDate) return;
        const res = await api.updateEntry(forDate, entry.id, { nutrients });
        if (dateRef.current !== forDate) return;
        setOverride(res.log);
      }
    } catch (err) {
      if (dateRef.current !== forDate) return;
      setActionError(errorMessage(err, "Couldn't finish filling in the missing nutrients."));
    } finally {
      setBusyId(null);
      setFilling(false);
    }
  }

  async function handleSave(entry: FoodEntry, patch: EntryPatch) {
    const forDate = date;
    setActionError(null);
    setBusyId(entry.id);
    try {
      const res = await api.updateEntry(forDate, entry.id, patch);
      if (dateRef.current !== forDate) return;
      setOverride(res.log);
      setEditingId(null);
    } catch (err) {
      if (dateRef.current !== forDate) return;
      setActionError(errorMessage(err, `Couldn't save "${entry.food_name}".`));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="stack">
      <DateNav date={date} onDateChange={onDateChange} />
      <MetricsCard date={date} />

      {day.status === "error" && (
        <div className="banner banner-error">
          <div className="stack-sm">
            <div>{day.error}</div>
            <div>
              <button type="button" className="btn btn-sm" onClick={day.reload}>
                Try again
              </button>
            </div>
          </div>
        </div>
      )}

      {actionError && <div className="banner banner-error">{actionError}</div>}

      {/* "idle" counts as loading: useAsync only flips to loading inside an effect, so the
          first render after a date change has neither data nor an error yet. Leaving it
          out flashed a bare date picker with nothing under it on every navigation. */}
      {(day.status === "idle" || day.status === "loading") && !log && <DaySkeleton />}

      {log && !hasEntries && <NothingLogged date={date} />}
      {day.status === "success" && !log && <NothingLogged date={date} />}

      {log && hasEntries && (
        <>
          <Headline log={log} goals={goals} />
          <MacroSplit log={log} />
          <Entries
            log={log}
            busyId={busyId}
            confirmingId={confirmingId}
            editingId={editingId}
            onConfirmDelete={setConfirmingId}
            onDelete={handleDelete}
            onReestimate={handleReestimate}
            onFillGaps={handleFillGaps}
            filling={filling}
            onEdit={setEditingId}
            onSave={handleSave}
          />
          <Micronutrients log={log} goals={goals} />
        </>
      )}
    </div>
  );
}

/* ── Date navigation ──────────────────────────────────────────────────────── */

// How far ahead you can plan. A year is well past any real meal-planning horizon and
// still stops a fat-fingered year in the date field from creating a log in 2126.
const MAX_DAYS_AHEAD = 365;

function DateNav({ date, onDateChange }: { date: string; onDateChange: (d: string) => void }) {
  const today = toDateString();
  const horizon = shiftDate(today, MAX_DAYS_AHEAD);
  const canGoForward = date < horizon;

  return (
    <div className="card">
      <div className="card-body stack-sm">
        {/* Both arrows are the same 44px width, so space-between centers the label exactly. */}
        <div className="row-between">
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Previous day"
            onClick={() => onDateChange(shiftDate(date, -1))}
          >
            <Chevron direction="left" />
          </button>

          <div className="h2">{dayLabel(date, today)}</div>

          <button
            type="button"
            className="btn btn-icon"
            aria-label="Next day"
            // Forward used to stop at today. It shouldn't: planning tomorrow's food is a
            // normal thing to want, and the log is just as valid written before you eat it.
            disabled={!canGoForward}
            onClick={() => canGoForward && onDateChange(shiftDate(date, 1))}
          >
            <Chevron direction="right" />
          </button>
        </div>

        {/* Only when you're not already on today. A permanently-present button that does
            nothing most of the time is worse than one that appears when it's useful, and
            its presence doubles as a signal that you've wandered off today. */}
        {date !== today && (
          <button type="button" className="btn btn-sm" onClick={() => onDateChange(today)}>
            Go to today
          </button>
        )}

        <input
          className="input num"
          type="date"
          // iOS gives date inputs native metrics that ignore the .input padding/height,
          // so without this one field sits visibly taller than everything around it.
          style={{ WebkitAppearance: "none", appearance: "none" }}
          value={date}
          max={horizon}
          aria-label="Pick a date"
          onChange={(e) => {
            const next = e.target.value;
            // Safari fires a change with "" while the picker is mid-edit.
            if (!next) return;
            onDateChange(next > horizon ? horizon : next);
          }}
        />
      </div>
    </div>
  );
}

/* ── Headline stats ───────────────────────────────────────────────────────── */

function Headline({ log, goals }: { log: DayLog; goals: Goals }) {
  const total = log.daily_totals.calories;
  const entryCount = log.entries.length;
  const calorieCoverage = log.daily_coverage.calories;
  // Zero coverage means nobody estimated calories for anything today. `daily_totals` still
  // reads 0, and rendering that 0 as the day's headline figure - with a 0% bar and "2,200
  // left" beside it - is the exact lie this screen was rewritten to stop telling.
  const known = calorieCoverage > 0;
  // The day's headline figure travels to its new value, so logging a meal visibly moves
  // the number rather than swapping it. Feeding it 0 when nothing is known keeps the
  // hook's hands off the em dash the `known` branch renders instead.
  const animatedTotal = useCountUp(known ? total : 0);
  const pct = goals.calories > 0 ? (total / goals.calories) * 100 : 0;
  const remaining = goals.calories - total;

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">Calories</div>
        <div className="card-subtitle num">
          {known ? `${fmt(total)} of ${fmt(goals.calories)} kcal` : `goal ${fmt(goals.calories)} kcal`}
        </div>
      </div>
      <div className="card-body stack">
        <div className="stack-sm">
          <div className="row-between">
            <div className="h1 num">{known ? fmt(Math.round(animatedTotal)) : fmt(null)}</div>
            <div className="small muted num">
              {!known
                ? "no calorie estimates"
                : remaining >= 0
                  ? `${fmt(remaining)} left`
                  : `${fmt(-remaining)} over`}
            </div>
          </div>
          {known && (
            <div className="bar">
              <div
                className="bar-fill"
                style={{
                  width: `${clamp(pct, 0, 100)}%`,
                  background: pct > 100 ? "var(--warn)" : "var(--accent)",
                }}
              />
            </div>
          )}
          {known ? (
            <CoverageNote coverage={calorieCoverage} entryCount={entryCount} noun="items" />
          ) : (
            <div className="small muted">
              None of today's {entryCount} {entryCount === 1 ? "item" : "items"} came back with a
              calorie estimate, so there is no total to show — not a zero-calorie day.
            </div>
          )}
        </div>

        <div className="grid-auto">
          <MacroStat label="Protein" nutrientKey="protein_g" log={log} goal={goals.protein_g} />
          <MacroStat label="Carbs" nutrientKey="carbs_g" log={log} goal={goals.carbs_g} />
          <MacroStat label="Fat" nutrientKey="fat_g" log={log} goal={goals.fat_g} />
          <div className="stat">
            <div className="stat-label">Water</div>
            <div className="stat-value num">{fmt(log.daily_water_ml)}</div>
            <div className="stat-sub num">of {fmt(goals.water_ml)} ml</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MacroStat({
  label,
  nutrientKey,
  log,
  goal,
}: {
  label: string;
  nutrientKey: NutrientKey;
  log: DayLog;
  goal: number;
}) {
  const total = log.daily_totals[nutrientKey];
  const coverage = log.daily_coverage[nutrientKey];
  // Same rule as the calorie headline: nothing known means no number, not a zero.
  const known = coverage > 0;
  const partial = known && coverage < log.entries.length;

  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value num">{known ? `${fmt(total, nutrientKey)} g` : fmt(null)}</div>
      <div className="stat-sub num">
        {known ? `of ${fmt(goal)} g` : "not estimated"}
        {partial && (
          <>
            {" · "}
            <span className="badge">{coverage} of {log.entries.length}</span>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Macro split ──────────────────────────────────────────────────────────── */

function MacroSplit({ log }: { log: DayLog }) {
  const entryCount = log.entries.length;

  // 4 kcal/g for protein and carbs, 9 for fat - the Atwater factors the backend uses too.
  const all = (
    [
      { key: "protein_g", label: "Protein", factor: 4, color: "var(--chart-1)" },
      { key: "carbs_g", label: "Carbs", factor: 4, color: "var(--chart-3)" },
      { key: "fat_g", label: "Fat", factor: 9, color: "var(--chart-2)" },
    ] as const
  ).map((s) => {
    const coverage = log.daily_coverage[s.key];
    const grams = log.daily_totals[s.key];
    return { ...s, coverage, known: coverage > 0, grams, kcal: grams * s.factor };
  });

  // A macro nobody estimated is not zero grams of it. Left in the split it contributes
  // 0 kcal and draws a legend entry reading "Fat 0% · 0 g", which is read as "you ate no
  // fat today" - the same unknown-as-zero lie the micronutrient rows were rebuilt to stop
  // telling. Unestimated macros come out of the denominator and get named instead.
  const segments = all.filter((s) => s.known);
  const missing = all.filter((s) => !s.known);
  const macroKcal = segments.reduce((sum, s) => sum + s.kcal, 0);
  const reported = log.daily_totals.calories;

  if (macroKcal <= 0) {
    return (
      <div className="card">
        <div className="card-header">
          <div className="card-title">Macro split</div>
        </div>
        <div className="card-body">
          <div className="empty">
            {segments.length === 0
              ? "No macro grams were estimated for today, so there's nothing to split."
              : "Today's items add up to no macro grams at all, so there's nothing to split."}
          </div>
        </div>
      </div>
    );
  }

  // A drift this large means one of the day's estimates disagrees with itself - Claude gave
  // grams and a calorie count that can't both be right. Saying so is better than silently
  // rendering percentages of a number the user has no reason to trust.
  const drift = reported > 0 ? (macroKcal - reported) / reported : 0;
  const inconsistent = reported > 0 && Math.abs(drift) > 0.2;
  // Min across the macros that were estimated at all: a macro with zero coverage is
  // reported separately rather than dragging this to 0 and printing "0 of 9 items".
  const macroCoverage = Math.min(...segments.map((s) => s.coverage));
  const partialMacros = macroCoverage < entryCount;

  let offset = 0;
  const placed = segments.map((s) => {
    const share = (s.kcal / macroKcal) * 100;
    const left = offset;
    offset += share;
    return { ...s, share, left };
  });

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">Macro split</div>
        <div className="card-subtitle num">
          {fmt(macroKcal)} kcal from {segments.map((s) => s.label.toLowerCase()).join(" + ")}
        </div>
      </div>
      <div className="card-body stack-sm">
        <div className="bar">
          {placed.map((s) => (
            // Absolute placement rather than flex: .bar is the shared class and it already
            // clips + rounds its children, so the only thing each segment supplies is its
            // computed position and color.
            <div
              key={s.key}
              className="bar-fill"
              style={{
                position: "absolute",
                top: 0,
                left: `${s.left}%`,
                width: `${s.share}%`,
                background: s.color,
                borderRadius: 0,
              }}
            />
          ))}
        </div>

        <div className="row-wrap small">
          {placed.map((s) => (
            <span key={s.key} className="num">
              <span style={{ color: s.color }} aria-hidden="true">■</span>{" "}
              {s.label} {Math.round(s.share)}%
              <span className="muted"> · {fmt(s.grams, s.key)} g</span>
            </span>
          ))}
          {/* Named, not omitted: an absent macro would otherwise look like one that came
              out at 0%, and silence is what made a missing estimate read as a real zero. */}
          {missing.map((s) => (
            <span key={s.key} className="num muted">
              <span aria-hidden="true">□</span> {s.label} {fmt(null)}
            </span>
          ))}
        </div>

        {missing.length > 0 && (
          <div className="small muted">
            {missing.map((s) => s.label.toLowerCase()).join(" and ")}{" "}
            {missing.length === 1 ? "was" : "were"} not estimated for any of today's items, so{" "}
            {missing.length === 1 ? "it is" : "they are"} left out of the split entirely rather
            than counted as none.
          </div>
        )}

        {inconsistent && (
          <div className="small muted">
            These grams work out to {fmt(macroKcal)} kcal, {Math.abs(Math.round(drift * 100))}%{" "}
            {drift > 0 ? "above" : "below"} the {fmt(reported)} kcal logged
            {partialMacros || missing.length > 0
              ? " (some items had no macro breakdown, which explains part of it)"
              : ""} —
            one of today's estimates disagrees with itself.
          </div>
        )}
        {!inconsistent && partialMacros && (
          <div className="small muted">
            Based on the {macroCoverage} of {entryCount} items that had macro grams.
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Entries ──────────────────────────────────────────────────────────────── */

interface EntryPatch {
  food_name?: string;
  serving_description?: string;
  nutrients?: Nutrients;
  water_ml?: number;
}

interface EntryGroup {
  key: string;
  batchId: string | null;
  transcript: string | null;
  entries: FoodEntry[];
}

function Entries({
  log,
  busyId,
  confirmingId,
  editingId,
  onConfirmDelete,
  onDelete,
  onEdit,
  onSave,
  onReestimate,
  onFillGaps,
  filling,
}: {
  log: DayLog;
  busyId: string | null;
  confirmingId: string | null;
  editingId: string | null;
  onConfirmDelete: (id: string | null) => void;
  onDelete: (entry: FoodEntry) => void;
  onEdit: (id: string | null) => void;
  onSave: (entry: FoodEntry, patch: EntryPatch) => void;
  onReestimate: (entry: FoodEntry) => void;
  onFillGaps: (entries: FoodEntry[]) => void;
  filling: boolean;
}) {
  // The items dragging the day's coverage down, offered as one action instead of
  // making the user hunt for them row by row.
  const sparseEntries = log.entries.filter(isSparse);
  const groups = useMemo(() => groupByBatch(log), [log]);
  const legacy = log.entries.filter((e) => e.source === "gpt_estimate" || e.source === "usda");

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">Entries</div>
        {sparseEntries.length > 0 && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={filling || busyId !== null}
            onClick={() => onFillGaps(sparseEntries)}
            title="Ask Claude again for the items whose nutrient data came back thin"
          >
            {filling
              ? "Filling in…"
              : `Fill gaps in ${sparseEntries.length} ${sparseEntries.length === 1 ? "item" : "items"}`}
          </button>
        )}
        <div className="card-subtitle">
          {log.entries.length} {log.entries.length === 1 ? "item" : "items"}
        </div>
      </div>
      <div className="card-body stack">
        {groups.map((group) => (
          <div key={group.key} className="stack-sm">
            {/* This is what the transcript is stored for: seeing the sentence next to the
                rows it produced is the fastest way to spot a misparse. */}
            {group.transcript && (
              <div className="small muted">you said: “{group.transcript}”</div>
            )}
            <div>
              {group.entries.map((entry) =>
                editingId === entry.id ? (
                  <EntryEditor
                    key={entry.id}
                    entry={entry}
                    busy={busyId === entry.id}
                    onCancel={() => onEdit(null)}
                    onSave={(patch) => onSave(entry, patch)}
                  />
                ) : (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    busy={busyId === entry.id}
                    confirming={confirmingId === entry.id}
                    onReestimate={onReestimate}
            anyBusy={busyId !== null || filling}
            onConfirmDelete={onConfirmDelete}
                    onDelete={onDelete}
                    onEdit={onEdit}
                  />
                ),
              )}
            </div>
          </div>
        ))}

        {legacy.length > 0 && <SourceLegend entries={legacy} />}
      </div>
    </div>
  );
}

/**
 * How many of an entry's micronutrients Claude had no number for.
 *
 * Macros are excluded because the model is required to estimate all four - if those are
 * missing the entry is broken in a different way. This counts only the 25 fields that are
 * legitimately allowed to come back unknown.
 */
export function unknownMicros(entry: FoodEntry): number {
  const n = entry.nutrients ?? ({} as Nutrients);
  let unknown = 0;
  for (const key of MICRO_KEYS) {
    const v = n[key];
    if (v === null || v === undefined) unknown += 1;
  }
  return unknown;
}

/** An entry is worth offering to re-estimate when most of its micronutrients are missing. */
export function isSparse(entry: FoodEntry): boolean {
  // Water is legitimately all zeros, not unknown - never flag it.
  if (entry.source === "water") return false;
  return unknownMicros(entry) >= SPARSE_THRESHOLD;
}

/**
 * Rebuild the structured parse an entry came from, so a re-estimate asks about the same
 * food and serving rather than guessing from the display string.
 *
 * Schema v2 entries carry `parsed` directly. Older ones are reconstructed, keeping any
 * descriptive parenthetical in the name - stripping "(full bag)" from a jerky entry is how
 * a re-estimate silently re-prices it as a standard 1 oz serving.
 */
export function parsedFromEntry(entry: FoodEntry): ParsedFood {
  if (entry.parsed) return entry.parsed;
  const match = entry.serving_description?.match(/^([\d.]+)\s+(.+)$/);
  const name = entry.food_name.replace(/\s*\([\d.]+\s+[^()]*\)$/, "").trim() || entry.food_name;
  return match
    ? { name, quantity: parseFloat(match[1]), unit: match[2] }
    : { name, quantity: 1, unit: "serving" };
}

function EntryRow({
  entry,
  busy,
  anyBusy,
  confirming,
  onConfirmDelete,
  onDelete,
  onEdit,
  onReestimate,
}: {
  entry: FoodEntry;
  busy: boolean;
  /** True while any row is mid-request, not just this one - see the re-estimate button. */
  anyBusy: boolean;
  confirming: boolean;
  onConfirmDelete: (id: string | null) => void;
  onDelete: (entry: FoodEntry) => void;
  onEdit: (id: string | null) => void;
  onReestimate: (entry: FoodEntry) => void;
}) {
  // Entries written by earlier versions of this app don't always carry a full nutrient
  // object; fmt() renders a missing value as an em dash, same as an explicit null.
  const n: Partial<Nutrients> = entry.nutrients ?? {};
  const badge = sourceBadge(entry.source);
  const missing = unknownMicros(entry);
  const sparse = isSparse(entry);

  return (
    <div className="entry">
      <div className="entry-main">
        <div className="entry-name">
          <span className="truncate">{entry.food_name}</span>
          {badge && (
            <>
              {" "}
              <span className="badge" title={`Source: ${entry.source}`}>{badge}</span>
            </>
          )}
        </div>
        <div className="entry-serving truncate">
          {entry.serving_description || "no serving noted"}
          {entry.water_ml ? ` · ${fmt(entry.water_ml)} ml water` : ""}
        </div>
        {sparse && (
          // Names the specific item behind a partial daily total. Knowing "sodium came
          // from 6 of 9 items" is only useful if you can tell which three are missing.
          <div className="entry-serving small">
            <span className="badge" title={`${missing} of 25 micronutrients were not estimated`}>
              {missing} nutrients unknown
            </span>
          </div>
        )}
      </div>

      <div className="entry-macros">
        {fmt(n.calories)} kcal
        <span className="muted">
          {" · "}P {fmt(n.protein_g, "protein_g")} · C {fmt(n.carbs_g, "carbs_g")} · F{" "}
          {fmt(n.fat_g, "fat_g")}
        </span>
      </div>

      <div className="entry-actions">
        {confirming ? (
          <>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={() => onDelete(entry)}
            >
              Delete
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onConfirmDelete(null)}
            >
              Keep
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-sm btn-icon btn-ghost"
              aria-label={`Edit ${entry.food_name}`}
              disabled={busy}
              onClick={() => onEdit(entry.id)}
            >
              <PencilIcon />
            </button>
            {sparse && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-label={`Re-estimate ${entry.food_name}`}
                title="Ask Claude again for this item's full nutrient profile"
                // Gated on ANY row being busy, not just this one. Each press is a separate
                // paid model call, and only the working row shows a spinner - so without
                // this, a second press (or a click re-dispatched by the layout shift as the
                // "nutrients unknown" badge disappears) silently buys another estimate.
                // Verified: one click used to fire two /estimate requests 1.7s apart.
                disabled={anyBusy}
                onClick={() => onReestimate(entry)}
              >
                {busy ? "…" : "Re-estimate"}
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm btn-icon btn-ghost"
              aria-label={`Delete ${entry.food_name}`}
              disabled={busy}
              onClick={() => onConfirmDelete(entry.id)}
            >
              <TrashIcon />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function EntryEditor({
  entry,
  busy,
  onCancel,
  onSave,
}: {
  entry: FoodEntry;
  busy: boolean;
  onCancel: () => void;
  onSave: (patch: EntryPatch) => void;
}) {
  const [name, setName] = useState(entry.food_name);
  const [serving, setServing] = useState(entry.serving_description ?? "");
  const [water, setWater] = useState(entry.water_ml === undefined ? "" : String(entry.water_ml));
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const key of EDITABLE_KEYS) initial[key] = toInput(entry.nutrients?.[key] ?? null);
    return initial;
  });
  const [localError, setLocalError] = useState<string | null>(null);

  const isWater = entry.source === "water" || entry.water_ml !== undefined;

  function submit(e: FormEvent) {
    e.preventDefault();
    const nutrients: Nutrients = { ...entry.nutrients };
    for (const key of EDITABLE_KEYS) {
      const raw = (values[key] ?? "").trim();
      // An empty field means UNKNOWN, not zero. Coercing it to 0 here would quietly
      // manufacture the fake-deficiency data this app was rewritten to stop producing.
      if (raw === "") {
        nutrients[key] = null;
        continue;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setLocalError(`${NUTRIENT_META[key].label} must be a number, or empty for unknown.`);
        return;
      }
      nutrients[key] = parsed;
    }

    const patch: EntryPatch = {
      food_name: name.trim() || entry.food_name,
      serving_description: serving.trim(),
      nutrients,
    };

    if (isWater) {
      const parsedWater = Number(water.trim());
      if (water.trim() !== "" && (!Number.isFinite(parsedWater) || parsedWater < 0)) {
        setLocalError("Water must be a number of millilitres.");
        return;
      }
      patch.water_ml = water.trim() === "" ? 0 : parsedWater;
    }

    setLocalError(null);
    onSave(patch);
  }

  return (
    <form className="entry" onSubmit={submit}>
      <div className="entry-main stack-sm">
        <div className="grid-2">
          <div className="field">
            <label className="label" htmlFor={`name-${entry.id}`}>Food</label>
            <input
              id={`name-${entry.id}`}
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor={`serving-${entry.id}`}>Serving</label>
            <input
              id={`serving-${entry.id}`}
              className="input"
              value={serving}
              placeholder="1 cup, 2 slices…"
              onChange={(e) => setServing(e.target.value)}
            />
          </div>
        </div>

        <div className="grid-2">
          {EDITABLE_KEYS.map((key) => (
            <div className="field" key={key}>
              <label className="label" htmlFor={`${key}-${entry.id}`}>
                {NUTRIENT_META[key].label} ({NUTRIENT_META[key].unit})
              </label>
              <input
                id={`${key}-${entry.id}`}
                className="input num"
                inputMode="decimal"
                value={values[key] ?? ""}
                placeholder="unknown"
                onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
              />
            </div>
          ))}
          {isWater && (
            <div className="field">
              <label className="label" htmlFor={`water-${entry.id}`}>Water (ml)</label>
              <input
                id={`water-${entry.id}`}
                className="input num"
                inputMode="decimal"
                value={water}
                onChange={(e) => setWater(e.target.value)}
              />
            </div>
          )}
        </div>

        <div className="small muted">
          Leave a field empty to mark it unknown — it won't be counted as zero.
        </div>

        {localError && <div className="banner banner-error">{localError}</div>}

        <div className="row-wrap">
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {busy && <span className="spinner" aria-hidden="true" />}
        </div>
      </div>
    </form>
  );
}

function SourceLegend({ entries }: { entries: FoodEntry[] }) {
  const gpt = entries.filter((e) => e.source === "gpt_estimate").length;
  const usda = entries.filter((e) => e.source === "usda").length;
  const parts = [
    gpt > 0 ? `${gpt} from an older GPT estimate` : null,
    usda > 0 ? `${usda} from a USDA lookup` : null,
  ].filter(Boolean);

  return (
    <div className="small muted">
      {entries.length} {entries.length === 1 ? "item" : "items"} came from earlier versions of this
      app ({parts.join(", ")}). Those rows often carry fewer micronutrients, which is why some
      coverage counts below are short.
    </div>
  );
}

/* ── Micronutrients ───────────────────────────────────────────────────────── */

function Micronutrients({ log, goals }: { log: DayLog; goals: Goals }) {
  const [open, setOpen] = useState(false);
  // Starts on. Opening this card to 25 rows, half of them reading "no data · 0 of 9", buries
  // the twelve nutrients that do have numbers - and the header above already states how many
  // of the 25 were estimated, so nothing is being hidden, only deferred to one tap.
  const [hideEmpty, setHideEmpty] = useState(true);

  const entryCount = log.entries.length;
  const withData = MICRO_KEYS.filter((k) => log.daily_coverage[k] > 0);
  const rows = hideEmpty ? withData : MICRO_KEYS;
  const anyPartial = withData.some((k) => log.daily_coverage[k] < entryCount);

  return (
    <div className="card">
      <div className="card-header">
        <div className="stack-sm">
          <div className="card-title">Micronutrients</div>
          <div className="card-subtitle">
            {withData.length} of {MICRO_KEYS.length} estimated today
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : "Show"}
          <Chevron direction={open ? "up" : "down"} />
        </button>
      </div>

      {open && (
        <div className="card-body stack">
          {anyPartial && (
            <div className="small muted">
              Dimmed bars are partial: only some of today's items had a value for that nutrient.
              A short bar there means missing data, not a shortfall.
            </div>
          )}

          <div className="row-wrap">
            <button
              type="button"
              className={`chip${hideEmpty ? " is-on" : ""}`}
              aria-pressed={hideEmpty}
              onClick={() => setHideEmpty((v) => !v)}
            >
              {/* Stable label, state carried by .is-on and aria-pressed - a chip whose
                  text flips between "hide" and "show" makes you read it twice. */}
              Only the {withData.length} with data
            </button>
          </div>

          {rows.length === 0 ? (
            <div className="empty">Nothing was estimated for today's micronutrients.</div>
          ) : (
            <div className="grid-2">
              {rows.map((key) => (
                <MicroRow
                  key={key}
                  nutrientKey={key}
                  total={log.daily_totals[key]}
                  coverage={log.daily_coverage[key]}
                  entryCount={entryCount}
                  limit={limitFor(key, goals)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MicroRow({
  nutrientKey,
  total,
  coverage,
  entryCount,
  limit,
}: {
  nutrientKey: NutrientKey;
  total: number;
  coverage: number;
  entryCount: number;
  limit: number | null;
}) {
  const meta = NUTRIENT_META[nutrientKey];
  const rda = RDA[nutrientKey] ?? null;
  const target = rda ?? limit;
  const known = coverage > 0;
  const partial = known && coverage < entryCount;
  const pct = known && target ? (total / target) * 100 : null;
  const overLimit = limit !== null && rda === null && pct !== null && pct > 100;

  return (
    <div className="stack-sm">
      <div className="row-between">
        <span className="small">
          {meta.label}
          {partial && (
            <>
              {" "}
              <span className="badge">partial</span>
            </>
          )}
        </span>
        <span className="small num">
          {/* "no data" rather than "0 mg": nobody estimated this, so we have no number. */}
          {known ? `${fmt(total, nutrientKey)} ${meta.unit}` : <span className="muted">no data</span>}
        </span>
      </div>

      {known && pct !== null && (
        <div className="bar">
          <div
            className="bar-fill"
            style={{
              width: `${clamp(pct, 0, 100)}%`,
              background: partial
                ? "var(--text-faint)"
                : overLimit
                  ? "var(--warn)"
                  : "var(--accent)",
            }}
          />
        </div>
      )}

      <div className="row-between small muted">
        <span className="num">
          {pct === null
            ? known
              ? "no reference amount"
              : "not estimated for any item"
            : `${Math.round(pct)}% of ${fmt(target, nutrientKey)} ${meta.unit}${rda ? " RDA" : " limit"}`}
        </span>
        <span className="num">
          {known ? `from ${coverage} of ${entryCount}` : `0 of ${entryCount}`}
        </span>
      </div>
    </div>
  );
}

/* ── Empty / loading ──────────────────────────────────────────────────────── */

function NothingLogged({ date }: { date: string }) {
  const today = toDateString();
  const isToday = date === today;
  // A day that hasn't happened yet isn't missing data, it's a blank page. Saying
  // "Nothing logged on this day" about tomorrow reads like something went wrong.
  const isFuture = date > today;
  return (
    <div className="card">
      <div className="card-body">
        <div className="empty">
          <div className="h3">
            {isFuture ? "Nothing planned yet" : `Nothing logged ${isToday ? "yet today" : "on this day"}`}
          </div>
          <div className="small">
            {isFuture
              ? "You can log a day before you eat it. Describe the meal you're planning and it saves exactly like any other day."
              : "Say or type a sentence — “a banana and a black coffee” is enough to start. Nothing is saved until you have looked it over."}
          </div>
          {/* A dead-end empty state on the app's default tab is the difference between
            * "what now?" and one tap. The hash IS the router, so a plain link is the whole
            * navigation - no callback to thread down from App. */}
          <a className="btn btn-primary" href="#/log">
            {isFuture ? "Plan this day" : isToday ? "Log what you ate" : "Log something"}
          </a>
        </div>
      </div>
    </div>
  );
}

function DaySkeleton() {
  // Shaped like the card it is standing in for - a headline figure, its bar, then the
  // macro tiles - so the layout does not jump when the real numbers land.
  return (
    <div className="card">
      <div className="card-body stack">
        <div className="stack-sm">
          <div className="skeleton" style={{ height: 34, width: "45%" }} />
          <div className="skeleton" style={{ height: 8 }} />
        </div>
        <div className="grid-auto">
          <div className="skeleton" style={{ height: 68 }} />
          <div className="skeleton" style={{ height: 68 }} />
          <div className="skeleton" style={{ height: 68 }} />
          <div className="skeleton" style={{ height: 68 }} />
        </div>
      </div>
    </div>
  );
}

function CoverageNote({
  coverage,
  entryCount,
  noun,
}: {
  coverage: number;
  entryCount: number;
  noun: string;
}) {
  if (coverage >= entryCount) return null;
  return (
    <div className="small muted num">
      from {coverage} of {entryCount} {noun} — the rest had no estimate and are not counted
    </div>
  );
}

/* ── Icons (no icon package on this project - these are the whole set) ─────── */

function Chevron({ direction }: { direction: "left" | "right" | "up" | "down" }) {
  const rotation = { left: 180, right: 0, up: 270, down: 90 }[direction];
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M11.2 2.3l2.5 2.5M2.5 13.5l3.4-.6 7-7a1.4 1.4 0 000-2l-.8-.8a1.4 1.4 0 00-2 0l-7 7-.6 3.4z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 4h11M6 4V2.8h4V4M4 4l.6 9.2h6.8L12 4M6.6 6.5v4.4M9.4 6.5v4.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function toInput(value: number | null): string {
  return value === null || value === undefined ? "" : String(value);
}

function dayLabel(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === shiftDate(today, 1)) return "Tomorrow";
  if (date === shiftDate(today, -1)) return "Yesterday";
  // Noon avoids the UTC-parse-shifts-the-day trap that "YYYY-MM-DD" alone falls into.
  const d = new Date(`${date}T12:00:00`);
  const sameYear = d.getFullYear() === new Date(`${today}T12:00:00`).getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function sourceBadge(source: FoodEntry["source"]): string | null {
  if (source === "gpt_estimate") return "GPT";
  if (source === "usda") return "USDA";
  return null;
}

/** Sodium and sugar have no RDA - they're ceilings, and the user's goals hold the numbers. */
function limitFor(key: NutrientKey, goals: Goals): number | null {
  if (key === "sodium_mg") return goals.sodium_mg;
  if (key === "sugar_g") return goals.sugar_g;
  return null;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function groupByBatch(log: DayLog): EntryGroup[] {
  const transcripts = new Map(log.batches.map((b) => [b.batch_id, b.transcript]));
  const groups: EntryGroup[] = [];

  for (const entry of log.entries) {
    const batchId = entry.batch_id ?? null;
    const last = groups[groups.length - 1];
    // Entries are stored in log order, so a batch's items already sit together. Starting a
    // new group only when the id changes keeps the day chronological instead of reshuffling
    // it into batch order - which mattered the day a lunch batch was edited hours later.
    if (last && last.batchId === batchId) {
      last.entries.push(entry);
      continue;
    }
    groups.push({
      // Keyed off the first entry too, so a batch split across two groups can't collide.
      key: `${batchId ?? "solo"}-${entry.id}`,
      batchId,
      transcript: batchId ? transcripts.get(batchId) ?? null : null,
      entries: [entry],
    });
  }
  return groups;
}

/**
 * Re-sum a log locally after an optimistic delete. The server does the same on its side, but
 * waiting a round trip to update the totals makes the delete feel broken. Re-deriving beats
 * subtracting the removed entry, which would have to know whether it contributed to each
 * coverage count in the first place - and a null contributed to neither total nor coverage.
 */
function recomputeLog(log: DayLog, entries: FoodEntry[]): DayLog {
  const totals = {} as Record<NutrientKey, number>;
  const coverage = {} as Record<NutrientKey, number>;
  for (const key of NUTRIENT_KEYS) {
    totals[key] = 0;
    coverage[key] = 0;
  }

  for (const entry of entries) {
    for (const key of NUTRIENT_KEYS) {
      const value = entry.nutrients?.[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        totals[key] += value;
        coverage[key] += 1;
      }
    }
  }

  return {
    ...log,
    entries,
    daily_totals: totals,
    daily_coverage: coverage,
    daily_water_ml: entries.reduce((sum, e) => sum + (e.water_ml ?? 0), 0),
  };
}
