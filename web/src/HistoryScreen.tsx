// History - the charts. Everything here exists to answer "what has the last N days
// actually looked like", so the two rules that matter most are about honesty:
//
//   1. A day with no log is a GAP, not a zero. The range endpoint simply omits
//      unlogged days; we rebuild a continuous date axis and give the missing days
//      `null` so `connectNulls={false}` breaks the line. A 0 kcal point for a day
//      the user never opened the app is a lie the old version told constantly.
//
//   2. A total built from zero known values is also `null`, not 0. `daily_totals`
//      is always a concrete number, but if `daily_coverage.sodium_mg` is 0 while
//      the day has 9 entries, that "0 mg" means "nobody knew", not "no sodium".
//      Plotting it flattened the sodium chart and is what made the old
//      micronutrient views show deficiencies that were not real.
//
// Colors come from --chart-1..6 in styles.css so they re-step with the theme.
// Assignment is fixed per entity: calories/protein = 1, 7-day trend/carbs = 2,
// fat/water = 3, sugar = 4, sodium = 5. On a light background slots 3, 4 and 5 sit
// just under 3:1 against white; the relief for that is shipped, not assumed - every
// chart has valued axes and a labeled limit line, and the Table view is a
// color-free twin of the whole range.

import { useMemo, useState } from "react";
import type { ReactElement } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, shiftDate, toDateString } from "./api";
import { useGoals } from "./goals";
import {
  MetricChart, WeightAgainst, WeekdayPattern, TopFoods, NutrientCoverageChart,
  ShortNightEffect, MetricStats,
} from "./InsightCharts";
import type { FoodStat } from "./InsightCharts";
import { useAsync } from "./useAsync";
import { fmt } from "./types";
import type { DaySummary, NutrientKey, Goals, MetricPoint } from "./types";

type RangeKey = "7d" | "30d" | "90d" | "all";
type View = "charts" | "table";

const RANGE_DAYS: Record<Exclude<RangeKey, "all">, number> = { "7d": 7, "30d": 30, "90d": 90 };
const RANGE_LABEL: Record<RangeKey, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days", all: "All time" };

/** One point on the shared x-axis. Every numeric field is `number | null`; null = unknown. */
interface Row {
  date: string;
  logged: boolean;
  entryCount: number;
  calories: number | null;
  trend: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  sodium: number | null;
  sugar: number | null;
  water: number | null;
  /** Share of macro-derived calories, 0-100. Null when no macro was estimated at all. */
  proteinPct: number | null;
  carbsPct: number | null;
  fatPct: number | null;
  /** Known-value counts, so a tooltip can say "from 6 of 9 items". */
  coverage: Partial<Record<NutrientKey, number>>;
}

// ── data shaping ───────────────────────────────────────────────────────────

/**
 * A day's total, or null when nothing in the day knew this nutrient. Returning
 * `daily_totals` unconditionally would turn "unknown" into 0.
 *
 * `daily_coverage` is read defensively: day files written by older schema versions
 * can be missing a key outright, and `undefined === 0` is false, so a strict
 * equality check let those days through as a real 0.
 */
function knownTotal(day: DaySummary, key: NutrientKey): number | null {
  const known = day.daily_coverage?.[key] ?? 0;
  if (known <= 0) return null;
  const total = day.daily_totals?.[key];
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}

/**
 * Inclusive YYYY-MM-DD sequence, walked backwards from `to` so that the cap keeps the
 * most recent days. Building it forwards meant an "All time" range longer than the cap
 * silently dropped the newest days - the half the user actually looks at.
 */
function dateSequence(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = to;
  while (cursor >= from && out.length < 1200) {
    out.push(cursor);
    cursor = shiftDate(cursor, -1);
  }
  return out.reverse();
}

/**
 * Trailing 7-day mean over the days that were actually LOGGED in the window -
 * not over 7 calendar days. Dividing by 7 through the user's 3-month dormant
 * stretch would drag the trend line to near zero and read as "they ate less",
 * which is the opposite of what happened. Requiring 3 samples also stops the
 * trend from drawing a confident line straight across a gap.
 */
function rollingMean(values: (number | null)[], window = 7, minSamples = 3): (number | null)[] {
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      const v = values[j];
      if (v !== null) {
        sum += v;
        n += 1;
      }
    }
    return n >= minSamples ? sum / n : null;
  });
}

function buildRows(from: string, to: string, days: DaySummary[]): Row[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const dates = dateSequence(from, to);

  const rows: Row[] = dates.map((date) => {
    const day = byDate.get(date);
    // A day whose entries were all deleted still has a file, and its totals are all a
    // truthful-looking 0. It holds no food, so it is a gap exactly like a day that was
    // never opened - Today says "Nothing logged" for it and the charts must agree,
    // or one emptied day drags the average down as if it were a fast.
    if (!day || day.entry_count <= 0) {
      return {
        date, logged: false, entryCount: 0,
        calories: null, trend: null, protein: null, carbs: null, fat: null,
        proteinPct: null, carbsPct: null, fatPct: null,
        sodium: null, sugar: null, water: null, coverage: {},
      };
    }
    const protein = knownTotal(day, "protein_g");
    const carbs = knownTotal(day, "carbs_g");
    const fat = knownTotal(day, "fat_g");
    // Atwater factors: 4 kcal/g for protein and carbs, 9 for fat. The denominator counts
    // only macros that were actually estimated, so an unestimated fat doesn't get read as
    // "0% of calories from fat" - it drops out and the remaining shares are of what's known.
    const kcal = (protein ?? 0) * 4 + (carbs ?? 0) * 4 + (fat ?? 0) * 9;
    const share = (grams: number | null, factor: number) =>
      grams === null || kcal <= 0 ? null : Math.round(((grams * factor) / kcal) * 1000) / 10;

    return {
      date,
      logged: true,
      entryCount: day.entry_count,
      calories: knownTotal(day, "calories"),
      trend: null, // filled below, once the whole series exists
      protein,
      carbs,
      fat,
      proteinPct: share(protein, 4),
      carbsPct: share(carbs, 4),
      fatPct: share(fat, 9),
      sodium: knownTotal(day, "sodium_mg"),
      sugar: knownTotal(day, "sugar_g"),
      water: day.daily_water_ml,
      coverage: day.daily_coverage,
    };
  });

  const trend = rollingMean(rows.map((r) => r.calories));
  return rows.map((r, i) => ({ ...r, trend: trend[i] }));
}

// ── small formatting helpers ───────────────────────────────────────────────

const tickDate = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

/** Noon avoids the UTC-midnight-becomes-yesterday class of bug. */
const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

const compact = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

/** Round an axis top up to a clean 0.5-decade step so ticks land on round numbers. */
function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 10;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const step = magnitude / 2;
  return Math.ceil(value / step) * step;
}

function maxOf(rows: Row[], key: keyof Row): number {
  let max = 0;
  for (const r of rows) {
    const v = r[key];
    if (typeof v === "number" && v > max) max = v;
  }
  return max;
}

// ── chart chrome ───────────────────────────────────────────────────────────

interface SeriesSpec {
  key: "calories" | "trend" | "protein" | "carbs" | "fat" | "sodium" | "sugar" | "water"
     | "proteinPct" | "carbsPct" | "fatPct";
  label: string;
  color: string;
  nutrient?: NutrientKey;
  unit: string;
  mark: "line" | "rect";
  /** Optional second field appended to the tooltip value, e.g. "16% · 84 g". A share
   *  chart is comparable across a 1,600 and a 2,800 kcal day, but you still want the
   *  absolute grams when you stop to read one. */
  also?: "protein" | "carbs" | "fat";
  alsoUnit?: string;
}

const AXIS_TICK = { fill: "var(--chart-axis)", fontSize: 11 };
const GRID = "var(--chart-grid)";

function Legend({ series }: { series: SeriesSpec[] }) {
  return (
    <div className="chart-legend">
      {series.map((s) => (
        <span className="chart-legend-item" key={s.key}>
          <span
            className={s.mark === "line" ? "chart-key-line" : "chart-key"}
            style={{ background: s.color }}
          />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/**
 * One tooltip for every series at the hovered date - the reader never has to land
 * on a specific line to get a number. It reads the whole Row off payload[0] rather
 * than the payload entries, so a series whose value is null still gets a row
 * saying so instead of silently vanishing.
 */
// Recharts' tooltip/dot prop types churn between minor versions; `any` here keeps
// this file from breaking on a patch bump. The shapes are asserted below instead.
function makeTooltip(series: SeriesSpec[]) {
  return function ChartTooltip(props: any) {
    if (!props?.active || !props.payload?.length) return null;
    const row = props.payload[0]?.payload as Row | undefined;
    if (!row) return null;
    const note = row.logged ? partialNote(row, series) : null;

    return (
      <div className="chart-tip">
        <div className="chart-tip-date">{longDate(row.date)}</div>
        {!row.logged ? (
          <div className="chart-tip-label">Nothing logged</div>
        ) : (
          series.map((s) => {
            const value = row[s.key];
            return (
              <div className="chart-tip-row" key={s.key}>
                <span
                  className={s.mark === "line" ? "chart-key-line" : "chart-key"}
                  style={{ background: s.color }}
                />
                <span className="chart-tip-label">{s.label}</span>
                <span className="chart-tip-value">
                  {value === null
                    ? "—"
                    : `${fmt(value, s.nutrient)} ${s.unit}`
                      + (s.also && row[s.also] !== null ? ` · ${fmt(row[s.also])} ${s.alsoUnit ?? "g"}` : "")}
                </span>
              </div>
            );
          })
        )}
        {note && (
          <div className="chart-note" style={{ marginTop: 6 }}>
            {note}
          </div>
        )}
      </div>
    );
  };
}

/** "Sodium from 6 of 9 items" - surfaced whenever a total is an undercount. */
function partialNote(row: Row, series: SeriesSpec[]): string | null {
  const partial = series
    .filter((s) => s.nutrient !== undefined)
    .map((s) => ({ s, known: row.coverage[s.nutrient as NutrientKey] ?? 0 }))
    .filter(({ known }) => known > 0 && known < row.entryCount);
  if (partial.length === 0) return null;
  const names = partial.map(({ s, known }) => `${s.label.toLowerCase()} from ${known} of ${row.entryCount}`);
  return `Partial: ${names.join(", ")}.`;
}

/**
 * Dots only where the day broke the limit. A dot on every point is noise; a dot on
 * the four days that went over is the whole message, and it survives greyscale and
 * colorblindness because position + the danger ring carry it, not hue.
 */

/** Wide charts scroll inside themselves. The page never scrolls sideways. */
function ChartFrame({ days, pxPerDay, children }: { days: number; pxPerDay: number; children: ReactElement }) {
  const minWidth = Math.max(300, days * pxPerDay);
  return (
    <div className="chart-scroll">
      <div className="chart" style={{ minWidth }}>
        {children}
      </div>
    </div>
  );
}

// ── screen ─────────────────────────────────────────────────────────────────

export default function HistoryScreen({ onPickDate }: { onPickDate: (date: string) => void }) {
  // A week is the span you can actually act on; a month is for stepping back.
  const [range, setRange] = useState<RangeKey>("7d");
  const [view, setView] = useState<View>("charts");
  const [armedDate, setArmedDate] = useState<string | null>(null);
  const coarsePointer = typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(hover: none)").matches;
  const touchHint = coarsePointer
    ? "tap a day for its numbers, tap again to open it."
    : "click any day to open it.";

  const goals = useGoals();

  const { status, data, error, reload } = useAsync(async () => {
    const to = toDateString();
    let from: string;
    if (range === "all") {
      // The range endpoint needs a start date, and "all" has no fixed length -
      // ask which days exist first and anchor on the earliest.
      const { dates } = await api.dates();
      from = dates.length ? [...dates].sort()[0] : shiftDate(to, -29);
    } else {
      from = shiftDate(to, -(RANGE_DAYS[range] - 1));
    }
    const res = await api.range(from, to);
    return { from, to, days: res.days };
  }, [range]);

  // Weight and food stats are separate resources from the day range, fetched once the
  // window is known. Keyed on the resolved dates rather than on `range`, so the "All"
  // window - whose start is only known after api.dates() resolves - refetches correctly.
  const extra = useAsync(
    async () => {
      if (!data) return { metrics: [] as MetricPoint[], foods: [] as FoodStat[] };
      const [m, f] = await Promise.all([
        api.metrics(data.from, data.to),
        api.foods(data.from, data.to, 12),
      ]);
      return { metrics: m.metrics, foods: f.foods };
    },
    [data?.from, data?.to],
  );

  const rows = useMemo(
    () => (data ? buildRows(data.from, data.to, data.days) : []),
    [data],
  );

  const loggedRows = useMemo(() => rows.filter((r) => r.logged), [rows]);

  // Averages count only days where the value was actually known - the whole point
  // of `knownTotal` is undone if the mean divides by days it had no number for.
  const calorieDays = loggedRows.filter((r) => r.calories !== null);
  const avgCalories = calorieDays.length
    ? calorieDays.reduce((sum, r) => sum + (r.calories as number), 0) / calorieDays.length
    : null;


  // "idle" has to count as a first load: useAsync starts idle and only flips to loading
  // in an effect, so the very first render has no data and no error. Treating that render
  // as "loaded with nothing" walked straight into the empty branch below and dereferenced
  // a null `data`, which crashed this screen every single time it mounted.
  const isFirstLoad = !data && status !== "error";
  const isRefetching = status === "loading" && !!data;

  const filters = (
    <div className="stack-sm">
      <div className="row-wrap">
        {(Object.keys(RANGE_LABEL) as RangeKey[]).map((key) => (
          <button
            key={key}
            type="button"
            className={`chip${range === key ? " is-on" : ""}`}
            aria-pressed={range === key}
            onClick={() => { setArmedDate(null); setRange(key); }}
          >
            {key === "all" ? "All" : key}
          </button>
        ))}
        <span className="spacer" />
        <button
          type="button"
          className={`chip${view === "table" ? " is-on" : ""}`}
          aria-pressed={view === "table"}
          onClick={() => setView(view === "table" ? "charts" : "table")}
        >
          Table
        </button>
      </div>
      <p className="chart-note">
        {RANGE_LABEL[range]} · {touchHint} Days with nothing logged are left blank,
        never drawn as zero.
      </p>
    </div>
  );

  if (isFirstLoad) {
    return (
      <div className="stack">
        {filters}
        <div className="grid-auto">
          <div className="skeleton" style={{ height: 76 }} />
          <div className="skeleton" style={{ height: 76 }} />
          <div className="skeleton" style={{ height: 76 }} />
          <div className="skeleton" style={{ height: 76 }} />
        </div>
        <div className="skeleton" style={{ height: 280 }} />
        <div className="skeleton" style={{ height: 280 }} />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="stack">
        {filters}
        <div className="banner banner-error">
          <div className="stack-sm">
            <strong>Couldn’t load your history.</strong>
            <span>{error}</span>
            <div>
              <button type="button" className="btn btn-sm" onClick={reload}>
                Try again
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (loggedRows.length === 0) {
    return (
      <div className="stack">
        {filters}
        <div className="card">
          <div className="empty">
            <span className="h3">No data in this range</span>
            <span className="small">
              Nothing was logged in this range.
            </span>
          </div>
        </div>
      </div>
    );
  }

  // A non-empty loggedRows can only come from a resolved fetch, but that is a chain
  // TypeScript can't follow through useMemo - so narrow it once here rather than
  // sprinkling `data!` through every chart below.
  if (!data) return null;

  const dayCount = rows.length;

  // Tap-to-read, tap-again-to-open on touch.
  //
  // With a mouse the tooltip follows the pointer, so a click is unambiguously "open this
  // day". On a touchscreen there is no hover: the same tap both opens the tooltip and
  // navigates away, so the numbers flash and vanish and no value in History is readable
  // on a phone at all. Here the first tap on a day just parks the tooltip; tapping the
  // same day again opens it. Pointer capability, not viewport width - a touchscreen
  // laptop should behave like a phone.
  const jumpToDay = (state: any) => {
    const date = state?.activeLabel;
    if (typeof date !== "string") return;

    const coarse = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(hover: none)").matches;

    if (!coarse || armedDate === date) {
      setArmedDate(null);
      onPickDate(date);
      return;
    }
    setArmedDate(date);
  };

  const calorieSeries: SeriesSpec[] = [
    { key: "calories", label: "Calories", color: "var(--chart-1)", nutrient: "calories", unit: "kcal", mark: "rect" },
    { key: "trend", label: "7-day average", color: "var(--chart-2)", unit: "kcal", mark: "line" },
  ];
  const macroSeries: SeriesSpec[] = [
    { key: "proteinPct", label: "Protein", color: "var(--chart-1)", unit: "%", mark: "rect", also: "protein", alsoUnit: "g" },
    { key: "carbsPct", label: "Carbs", color: "var(--chart-2)", unit: "%", mark: "rect", also: "carbs", alsoUnit: "g" },
    { key: "fatPct", label: "Fat", color: "var(--chart-3)", unit: "%", mark: "rect", also: "fat", alsoUnit: "g" },
  ];
  const waterSeries: SeriesSpec[] = [
    { key: "water", label: "Water", color: "var(--chart-3)", unit: "ml", mark: "rect" },
  ];

  const calorieMax = niceMax(Math.max(maxOf(rows, "calories"), goals.calories) * 1.1);
  const waterMax = niceMax(Math.max(maxOf(rows, "water"), goals.water_ml) * 1.1);

  return (
    <div className="stack">
      {filters}

      {/* Refetching holds the previous render at reduced opacity instead of flashing a
        * skeleton - swapping ranges shouldn't make the page jump. The chips stay at full
        * strength: dimming the control you just tapped reads as "that didn't work". */}
      <div className="stack" style={{ opacity: isRefetching ? 0.55 : 1 }}>
      <div className="grid-auto">
        <div className="stat">
          <span className="stat-label">Avg calories</span>
          <span className="stat-value">{avgCalories === null ? "—" : compact(avgCalories)}</span>
          <span className="stat-sub">
            {calorieDays.length < loggedRows.length
              ? `over ${calorieDays.length} of ${loggedRows.length} logged days`
              : `over ${calorieDays.length} logged days`}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Days logged</span>
          <span className="stat-value">{loggedRows.length}</span>
          <span className="stat-sub">of {dayCount} in range</span>
        </div>
      </div>

      {view === "table" ? (
        <RangeTable rows={loggedRows} goals={goals} onPickDate={onPickDate} />
      ) : (
        <>
          {/* 1 - Calories against goal, with the trend that the daily noise hides. */}
          <section className="card">
            <div className="card-header">
              <div>
                <div className="card-title">Calories</div>
                <div className="card-subtitle">Daily intake vs your {compact(goals.calories)} kcal goal</div>
              </div>
              <Legend series={calorieSeries} />
            </div>
            <div className="card-body">
              <ChartFrame days={dayCount} pxPerDay={9}>
                <ResponsiveContainer width="100%" height={230}>
                  <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} onClick={jumpToDay}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={tickDate}
                      tick={AXIS_TICK}
                      tickLine={false}
                      axisLine={{ stroke: GRID }}
                      minTickGap={24}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      domain={[0, calorieMax]}
                      tick={AXIS_TICK}
                      tickLine={false}
                      axisLine={false}
                      width={46}
                      tickFormatter={compact}
                    />
                    <Tooltip content={makeTooltip(calorieSeries)} cursor={{ stroke: GRID, strokeWidth: 1 }} />
                    <ReferenceLine
                      y={goals.calories}
                      stroke="var(--chart-axis)"
                      strokeDasharray="5 5"
                      label={{ value: "Goal", position: "insideTopRight", fill: "var(--chart-axis)", fontSize: 11 }}
                    />
                    <Area
                      type="monotone"
                      dataKey="calories"
                      stroke="var(--chart-1)"
                      strokeWidth={2}
                      fill="var(--chart-1)"
                      fillOpacity={0.1}
                      dot={false}
                      activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2 }}
                      connectNulls={false}
                      isAnimationActive animationDuration={480} animationEasing="ease-out"
                    />
                    <Line
                      type="monotone"
                      dataKey="trend"
                      stroke="var(--chart-2)"
                      strokeWidth={2}
                      dot={false}
                      activeDot={false}
                      connectNulls={false}
                      isAnimationActive animationDuration={480} animationEasing="ease-out"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </ChartFrame>
              <p className="chart-note">
                The average is over whatever days you logged inside each trailing 7-day window, and needs at least three of
                them, so it stops rather than drawing a line through a stretch you didn’t log.
              </p>
            </div>
          </section>

          {/* 2 - Where the calories came from. */}
          <section className="card">
            <div className="card-header">
              <div>
                <div className="card-title">Macros</div>
                <div className="card-subtitle">Share of calories from each macro</div>
              </div>
              <Legend series={macroSeries} />
            </div>
            <div className="card-body">
              <ChartFrame days={dayCount} pxPerDay={12}>
                <ResponsiveContainer width="100%" height={230}>
                  <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} onClick={jumpToDay}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={tickDate}
                      tick={AXIS_TICK}
                      tickLine={false}
                      axisLine={{ stroke: GRID }}
                      minTickGap={24}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      domain={[0, 100]}
                      ticks={[0, 25, 50, 75, 100]}
                      tick={AXIS_TICK}
                      tickLine={false}
                      axisLine={false}
                      width={46}
                      tickFormatter={(v: number) => `${v}%`}
                    />
                    <Tooltip content={makeTooltip(macroSeries)} cursor={{ fill: "var(--accent-soft)" }} />
                    {/* The 2px surface-colored stroke IS the surface gap between stacked
                        segments - Recharts has no gap property, and a real gap is what
                        keeps two adjacent hues reading as distinct without a border. */}
                    <Bar dataKey="proteinPct" stackId="macros" fill="var(--chart-1)" stroke="var(--surface)" strokeWidth={2} maxBarSize={24} isAnimationActive animationDuration={480} animationEasing="ease-out" />
                    <Bar dataKey="carbsPct" stackId="macros" fill="var(--chart-2)" stroke="var(--surface)" strokeWidth={2} maxBarSize={24} isAnimationActive animationDuration={480} animationEasing="ease-out" />
                    <Bar dataKey="fatPct" stackId="macros" fill="var(--chart-3)" stroke="var(--surface)" strokeWidth={2} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive animationDuration={480} animationEasing="ease-out" />
                  </BarChart>
                </ResponsiveContainer>
              </ChartFrame>
            </div>
          </section>

          {/* 3 - The hand-entered daily numbers, in the same order they're logged on
                 Today: weight, distance, sleep. Each metric's own charts sit together. */}
          <MetricStats points={extra.data?.metrics ?? []} goals={goals} />
          <MetricChart metric="weight" points={extra.data?.metrics ?? []} goals={goals} from={data.from} to={data.to} />
          <MetricChart metric="distance" points={extra.data?.metrics ?? []} goals={goals} from={data.from} to={data.to} />
          <WeightAgainst days={data.days} points={extra.data?.metrics ?? []} goals={goals} against="distance" />
          <WeightAgainst days={data.days} points={extra.data?.metrics ?? []} goals={goals} against="calories" />
          <MetricChart metric="sleep" points={extra.data?.metrics ?? []} goals={goals} from={data.from} to={data.to} />
          <ShortNightEffect days={data.days} points={extra.data?.metrics ?? []} goals={goals} />

          {/* 6 - Patterns across the range rather than day by day. */}
          <WeekdayPattern days={data.days} goals={goals} />
          <TopFoods foods={extra.data?.foods ?? []} />
          <NutrientCoverageChart days={data.days} goals={goals} />

          {/* 4 - Hydration. */}
          <section className="card">
            <div className="card-header">
              <div>
                <div className="card-title">Water</div>
                <div className="card-subtitle">Millilitres per day vs your {compact(goals.water_ml)} ml goal</div>
              </div>
            </div>
            <div className="card-body">
              <ChartFrame days={dayCount} pxPerDay={12}>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} onClick={jumpToDay}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={tickDate}
                      tick={AXIS_TICK}
                      tickLine={false}
                      axisLine={{ stroke: GRID }}
                      minTickGap={24}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      domain={[0, waterMax]}
                      tick={AXIS_TICK}
                      tickLine={false}
                      axisLine={false}
                      width={46}
                      tickFormatter={compact}
                    />
                    <Tooltip content={makeTooltip(waterSeries)} cursor={{ fill: "var(--accent-soft)" }} />
                    <ReferenceLine
                      y={goals.water_ml}
                      stroke="var(--chart-axis)"
                      strokeDasharray="5 5"
                      label={{ value: "Goal", position: "insideTopRight", fill: "var(--chart-axis)", fontSize: 11 }}
                    />
                    <Bar
                      dataKey="water"
                      fill="var(--chart-3)"
                      maxBarSize={24}
                      radius={[4, 4, 0, 0]}
                      isAnimationActive animationDuration={480} animationEasing="ease-out"
                    />
                  </BarChart>
                </ResponsiveContainer>
              </ChartFrame>
            </div>
          </section>
        </>
      )}
      </div>
    </div>
  );
}
// ── table view ─────────────────────────────────────────────────────────────

/**
 * The colour-free twin of every chart above. It exists so no value in this screen
 * is reachable only by hovering a hue - which matters most in light mode, where
 * three of the six chart hues sit just under 3:1 against white.
 */
function RangeTable({
  rows,
  goals,
  onPickDate,
}: {
  rows: Row[];
  goals: Goals;
  onPickDate: (date: string) => void;
}) {
  const newestFirst = [...rows].reverse();
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <div className="card-title">Every logged day</div>
          <div className="card-subtitle">
            {rows.length} days · “—” means nothing in that day knew the value
          </div>
        </div>
      </div>
      <div className="card-body">
        <div className="chart-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">kcal</th>
                <th scope="col">Protein</th>
                <th scope="col">Carbs</th>
                <th scope="col">Fat</th>
                <th scope="col">Sodium</th>
                <th scope="col">Sugar</th>
                <th scope="col">Water</th>
                <th scope="col">Items</th>
              </tr>
            </thead>
            <tbody>
              {newestFirst.map((r) => (
                <tr key={r.date}>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onPickDate(r.date)}>
                      {longDate(r.date)}
                    </button>
                  </td>
                  <td>{fmt(r.calories, "calories")}</td>
                  <td>{fmt(r.protein, "protein_g")}</td>
                  <td>{fmt(r.carbs, "carbs_g")}</td>
                  <td>{fmt(r.fat, "fat_g")}</td>
                  <td style={{ color: r.sodium !== null && r.sodium > goals.sodium_mg ? "var(--danger)" : undefined }}>
                    {fmt(r.sodium, "sodium_mg")}
                  </td>
                  <td style={{ color: r.sugar !== null && r.sugar > goals.sugar_g ? "var(--danger)" : undefined }}>
                    {fmt(r.sugar, "sugar_g")}
                  </td>
                  <td>{fmt(r.water)}</td>
                  <td>{r.entryCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
