// The second tier of History: charts that answer questions the daily trend can't.
//
// Kept out of HistoryScreen so that file stays about the core four (calories, macros,
// limits, water). Everything here takes plain data as props and owns no fetching.

import { useMemo } from "react";
import {
  Bar, BarChart, CartesianGrid, ComposedChart, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { DaySummary, Goals, MetricKey, MetricPoint, NutrientKey } from "./types";
import { NUTRIENT_META, RDA, fmt, METRICS, displayUnit, metricValue } from "./types";

const AXIS_TICK = { fill: "var(--chart-axis)", fontSize: 11 };
const GRID = "var(--chart-grid)";

const tickDate = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

/** Every date from `from` to `to` inclusive, so gaps stay visible as gaps. */
function dateSequence(from: string, to: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  while (cursor <= end && out.length < 1500) {
    out.push(
      `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`,
    );
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/**
 * Trailing mean over a calendar window, skipping days with no value.
 * Weight is noisy day to day - a couple of pounds of water is louder than a week of
 * actual change - so the smoothed line is the one worth reading.
 */
function rollingMean(values: (number | null)[], window = 7, minSamples = 3): (number | null)[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1).filter((v): v is number => v !== null);
    if (slice.length < minSamples) return null;
    return Math.round((slice.reduce((a, b) => a + b, 0) / slice.length) * 10) / 10;
  });
}

function CardShell({ title, subtitle, note, children }: {
  title: string; subtitle: string; note?: string; children: React.ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <div className="card-title">{title}</div>
          <div className="card-subtitle">{subtitle}</div>
        </div>
      </div>
      <div className="card-body">
        {children}
        {note && <p className="chart-note">{note}</p>}
      </div>
    </section>
  );
}

function Tip({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <div className="chart-tip">
      {rows.map((r) => (
        <div className="chart-tip-row" key={r.label}>
          <span className="chart-tip-label">{r.label}</span>
          <span className="chart-tip-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/* ── 1. A metric over time ────────────────────────────────────────────────── */

/**
 * Weight, distance or sleep on a shared shape: the raw series plus a 7-day average.
 *
 * The average is the point. All three of these are noisy day to day - a couple of pounds
 * of water, one long walk, one bad night - and the smoothed line is what actually reflects
 * a change in behaviour.
 */
export function MetricChart({ metric, points, goals, from, to }: {
  metric: MetricKey; points: MetricPoint[]; goals: Goals; from: string; to: string;
}) {
  const def = METRICS[metric];
  const unit = displayUnit(metric, goals);
  const target = def.goalKey ? (goals[def.goalKey] as number | undefined) : undefined;

  const mine = useMemo(() => points.filter((p) => p.metric === metric), [points, metric]);

  const rows = useMemo(() => {
    const byDate = new Map(mine.map((p) => [p.date, metricValue(p, goals)]));
    const dates = dateSequence(from, to);
    const raw = dates.map((d) => byDate.get(d) ?? null);
    const trend = rollingMean(raw);
    return dates.map((date, i) => ({ date, value: raw[i], trend: trend[i] }));
  }, [mine, goals, from, to]);

  if (mine.length === 0) {
    return (
      <CardShell title={def.short} subtitle={`No ${def.label.toLowerCase()} recorded yet`}>
        <div className="empty">
          <div className="h3">Nothing here yet</div>
          <div className="small">Add one from the Today screen and it starts plotting here.</div>
        </div>
      </CardShell>
    );
  }

  const values = mine.map((p) => metricValue(p, goals));
  const lo = Math.min(...values, target ?? Infinity);
  const hi = Math.max(...values, target ?? -Infinity);
  // Weight in particular moves in small increments against a big absolute number, so a
  // zero-based axis would flatten a real change into a straight line. Pad the observed
  // range instead - except for sleep and distance, where zero is genuinely meaningful.
  const zeroBased = metric !== "weight";
  const pad = Math.max((hi - lo) * 0.2, def.decimals >= 2 ? 0.5 : 1);
  const domain: [number, number] = zeroBased ? [0, Math.ceil(hi + pad)] : [Math.floor(lo - pad), Math.ceil(hi + pad)];

  const first = values[0];
  const last = values[values.length - 1];
  const change = Math.round((last - first) * 10) / 10;
  const avg = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;

  const subtitle =
    metric === "weight"
      ? `${mine.length} weigh-ins · ${change === 0 ? "no net change" : `${change > 0 ? "+" : ""}${change} ${unit} over the range`}`
      : `${mine.length} days recorded · ${avg} ${unit} average`;

  return (
    <CardShell
      title={def.short}
      subtitle={subtitle}
      note="The heavier line is a 7-day average. Day to day these bounce around; the average is the part that reflects a real change."
    >
      <ResponsiveContainer width="100%" height={210}>
        <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="date" tickFormatter={tickDate} tick={AXIS_TICK} tickLine={false}
                 axisLine={{ stroke: GRID }} minTickGap={24} interval="preserveStartEnd" />
          <YAxis domain={domain} tick={AXIS_TICK} tickLine={false} axisLine={false} width={46} />
          <Tooltip content={(p: any) => {
            if (!p?.active || !p.payload?.length) return null;
            const r = p.payload[0].payload;
            return <Tip rows={[
              { label: longDate(r.date), value: "" },
              { label: def.short, value: r.value === null ? "—" : `${r.value} ${unit}` },
              { label: "7-day avg", value: r.trend === null ? "—" : `${r.trend} ${unit}` },
            ]} />;
          }} />
          {target !== undefined && (
            <ReferenceLine y={target} stroke="var(--chart-4)" strokeDasharray="4 4"
                           label={{ value: `goal ${target}`, fill: "var(--chart-axis)", fontSize: 11, position: "insideTopRight" }} />
          )}
          {metric === "distance" ? (
            <Bar dataKey="value" fill="var(--chart-3)" maxBarSize={14} isAnimationActive animationDuration={480} animationEasing="ease-out" />
          ) : (
            <Line type="monotone" dataKey="value" stroke="var(--chart-1)" strokeWidth={1.5}
                  dot={{ r: 2 }} connectNulls={false} isAnimationActive animationDuration={480} animationEasing="ease-out" />
          )}
          <Line type="monotone" dataKey="trend" stroke="var(--chart-2)" strokeWidth={2.5}
                dot={false} connectNulls={false} isAnimationActive animationDuration={480} animationEasing="ease-out" />
        </ComposedChart>
      </ResponsiveContainer>
    </CardShell>
  );
}

/* ── 2. Weight against intake ─────────────────────────────────────────────── */

/**
 * Weight against something else you record, on two axes.
 *
 * Parameterised rather than copied because the two versions differ only in where the bars
 * come from - a second near-identical component would drift the moment one of them got a
 * fix. Two axes on purpose: the question is whether the shapes move together, not whether
 * pounds compare to kcal or miles.
 */
export function WeightAgainst({ days, points, goals, against }: {
  days: DaySummary[]; points: MetricPoint[]; goals: Goals; against: "calories" | "distance";
}) {
  const wUnit = displayUnit("weight", goals);
  const dUnit = displayUnit("distance", goals);

  const spec = against === "calories"
    ? {
        title: "Weight vs intake",
        blurb: "How the scale responds to what you ate",
        pairing: "a weigh-in and a food log",
        label: "Calories",
        unit: "kcal",
        reference: goals.calories,
        color: "var(--chart-3)",
      }
    : {
        title: "Weight vs distance",
        blurb: "How the scale responds to how much you walked",
        pairing: "a weigh-in and a recorded walk",
        label: "Distance",
        unit: dUnit,
        reference: goals.distance_target,
        color: "var(--chart-6)",
      };

  const rows = useMemo(() => {
    const other = against === "calories"
      ? new Map(days.filter((d) => d.entry_count > 0).map((d) => [d.date, d.daily_totals.calories]))
      : new Map(points.filter((p) => p.metric === "distance").map((p) => [p.date, metricValue(p, goals)]));

    return points
      .filter((p) => p.metric === "weight")
      .map((w) => ({ date: w.date, weight: metricValue(w, goals), other: other.get(w.date) ?? null }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [days, points, goals, against]);

  const overlap = rows.filter((r) => r.other !== null).length;
  if (overlap < 3) {
    return (
      <CardShell title={spec.title} subtitle={spec.blurb}>
        <div className="empty">
          <div className="h3">Not enough overlap yet</div>
          <div className="small">
            Needs at least three days with both {spec.pairing}. You have {overlap}.
          </div>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell
      title={spec.title}
      subtitle={`${overlap} days with both ${spec.pairing}`}
      note="Two different axes on purpose — this is about whether the shapes move together, not about comparing the units."
    >
      <ResponsiveContainer width="100%" height={230}>
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="date" tickFormatter={tickDate} tick={AXIS_TICK} tickLine={false}
                 axisLine={{ stroke: GRID }} minTickGap={24} interval="preserveStartEnd" />
          <YAxis yAxisId="other" tick={AXIS_TICK} tickLine={false} axisLine={false} width={46} />
          {/* Weight gets a padded axis, not a zero-based one - a 6 lb change against a
              180 lb number would otherwise render as a flat line. */}
          <YAxis yAxisId="wt" orientation="right" domain={["dataMin - 2", "dataMax + 2"]}
                 tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} />
          <Tooltip content={(p: any) => {
            if (!p?.active || !p.payload?.length) return null;
            const r = p.payload[0].payload;
            return <Tip rows={[
              { label: longDate(r.date), value: "" },
              { label: spec.label, value: r.other === null ? "—" : `${fmt(r.other)} ${spec.unit}` },
              { label: "Weight", value: `${r.weight} ${wUnit}` },
            ]} />;
          }} />
          {spec.reference != null && (
            <ReferenceLine yAxisId="other" y={spec.reference} stroke={GRID} strokeDasharray="4 4" />
          )}
          <Bar yAxisId="other" dataKey="other" fill={spec.color} maxBarSize={22} isAnimationActive animationDuration={480} animationEasing="ease-out" />
          <Line yAxisId="wt" type="monotone" dataKey="weight" stroke="var(--chart-1)"
                strokeWidth={2.5} dot={{ r: 2.5 }} connectNulls isAnimationActive animationDuration={480} animationEasing="ease-out" />
        </ComposedChart>
      </ResponsiveContainer>
    </CardShell>
  );
}

/* ── 3. Which days run high ───────────────────────────────────────────────── */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function WeekdayPattern({ days, goals }: { days: DaySummary[]; goals: Goals }) {
  const rows = useMemo(() => {
    const buckets = WEEKDAYS.map((label) => ({ label, total: 0, count: 0 }));
    for (const d of days) {
      if (d.entry_count <= 0) continue;
      const idx = new Date(`${d.date}T12:00:00`).getDay();
      buckets[idx].total += d.daily_totals.calories;
      buckets[idx].count += 1;
    }
    return buckets.map((b) => ({
      label: b.label,
      calories: b.count > 0 ? Math.round(b.total / b.count) : null,
      count: b.count,
    }));
  }, [days]);

  const withData = rows.filter((r) => r.calories !== null).length;
  if (withData < 2) return null;

  return (
    <CardShell
      title="By day of week"
      subtitle="Average calories, grouped by weekday"
      note="Days you never logged on are blank rather than zero, so a weekday you skip doesn't read as a fast."
    >
      <ResponsiveContainer width="100%" height={190}>
        <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={46} />
          <Tooltip content={(p: any) => {
            if (!p?.active || !p.payload?.length) return null;
            const r = p.payload[0].payload;
            return <Tip rows={[
              { label: r.label, value: "" },
              { label: "Average", value: r.calories === null ? "no data" : `${fmt(r.calories)} kcal` },
              { label: "Days logged", value: String(r.count) },
            ]} />;
          }} cursor={{ fill: "var(--accent-soft)" }} />
          <ReferenceLine y={goals.calories} stroke="var(--chart-2)" strokeDasharray="4 4" />
          <Bar dataKey="calories" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={44} isAnimationActive animationDuration={480} animationEasing="ease-out" />
        </BarChart>
      </ResponsiveContainer>
    </CardShell>
  );
}

/* ── 4. What you actually eat ─────────────────────────────────────────────── */

export interface FoodStat {
  key: string; name: string; count: number; total_calories: number; avg_calories: number;
}

export function TopFoods({ foods, onPick }: { foods: FoodStat[]; onPick?: (name: string) => void }) {
  if (foods.length === 0) return null;
  const max = Math.max(...foods.map((f) => f.total_calories), 1);

  return (
    <CardShell
      title="Biggest contributors"
      subtitle="Total calories each food added across this range"
      note="Ranked by total, not by size — something small you eat eight times outranks one big meal, which is usually the more useful thing to know."
    >
      <div className="stack-sm">
        {foods.slice(0, 12).map((f) => (
          <div key={f.key} className="stack-sm" style={{ gap: 4 }}>
            <div className="row-between">
              <span className="truncate" title={f.name}>
                {onPick ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onPick(f.name)}>
                    {f.name}
                  </button>
                ) : f.name}
              </span>
              <span className="small muted num">
                {fmt(f.total_calories)} kcal{f.count > 1 ? ` · ${f.count}×` : ""}
              </span>
            </div>
            <div className="bar">
              <div className="bar-fill" style={{ width: `${(f.total_calories / max) * 100}%`, background: "var(--chart-1)" }} />
            </div>
          </div>
        ))}
      </div>
    </CardShell>
  );
}

/* ── 5. Micronutrients across the whole range ─────────────────────────────── */

export function NutrientCoverageChart({ days, goals }: { days: DaySummary[]; goals: Goals }) {
  // Sodium and sugar are ceilings, not targets, so they can't just join the RDA list -
  // 140% of an RDA is fine, 140% of a sodium limit is the opposite. They get their own
  // rows with inverted colouring and a count of how many days went over.
  const limits = useMemo(
    () => [
      { key: "sodium_mg" as NutrientKey, limit: goals.sodium_mg },
      { key: "sugar_g" as NutrientKey, limit: goals.sugar_g },
    ],
    [goals.sodium_mg, goals.sugar_g],
  );

  const limitRows = useMemo(() => {
    const logged = days.filter((d) => d.entry_count > 0);
    return limits
      .map(({ key, limit }) => {
        const withData = logged.filter((d) => (d.daily_coverage?.[key] ?? 0) > 0);
        if (withData.length === 0) return null;
        const avg = withData.reduce((sum, d) => sum + d.daily_totals[key], 0) / withData.length;
        return {
          key,
          label: NUTRIENT_META[key].label,
          pct: Math.round((avg / limit) * 100),
          avg: Math.round(avg * 10) / 10,
          unit: NUTRIENT_META[key].unit,
          limit,
          over: withData.filter((d) => d.daily_totals[key] > limit).length,
          days: withData.length,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }, [days, limits]);

  const rows = useMemo(() => {
    const logged = days.filter((d) => d.entry_count > 0);
    if (logged.length === 0) return [];
    return (Object.keys(RDA) as NutrientKey[])
      .map((key) => {
        const rda = RDA[key];
        if (!rda) return null;
        // Average only over days that actually had a value for this nutrient. Averaging in
        // days where nothing was estimated would report a deficiency that is really a gap.
        const withData = logged.filter((d) => (d.daily_coverage?.[key] ?? 0) > 0);
        if (withData.length === 0) return null;
        const avg = withData.reduce((sum, d) => sum + d.daily_totals[key], 0) / withData.length;
        return {
          key,
          label: NUTRIENT_META[key].label,
          pct: Math.round((avg / rda) * 100),
          avg: Math.round(avg * 10) / 10,
          unit: NUTRIENT_META[key].unit,
          days: withData.length,
          total: logged.length,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => a.pct - b.pct);
  }, [days]);

  if (rows.length === 0 && limitRows.length === 0) return null;
  const short = rows.filter((r) => r.pct < 70).length;
  const overLimit = limitRows.filter((r) => r.pct > 100).length;

  const subtitle = [
    `${short} running below 70% of target`,
    limitRows.length ? `${overLimit} of ${limitRows.length} limits exceeded on average` : null,
  ].filter(Boolean).join(" · ");

  return (
    <CardShell
      title="Micronutrients"
      subtitle={subtitle}
      note="Each bar averages only the days where that nutrient was actually estimated, and says how many those were. A short bar backed by 3 of 30 days is a data gap, not a deficiency. Sodium and sugar are ceilings — for those, past 100% is the bad direction."
    >
      <div className="stack-sm">
        {limitRows.map((r) => (
          <div key={r.key} className="stack-sm" style={{ gap: 4 }}>
            <div className="row-between">
              <span>
                {r.label} <span className="badge">limit</span>
              </span>
              <span className="small muted num">
                {r.pct}% of {fmt(r.limit, r.key)} {r.unit} · over on {r.over} of {r.days} days
              </span>
            </div>
            <div className="bar">
              <div
                className="bar-fill"
                style={{
                  // Capped at 100% width: a 300% sodium day would otherwise render as a
                  // bar three times the width of its own track.
                  width: `${Math.min(r.pct, 100)}%`,
                  // Inverted against the RDA rows - being under a ceiling is the good case.
                  background: r.pct > 100 ? "var(--danger)" : r.pct > 80 ? "var(--warn)" : "var(--ok)",
                }}
              />
            </div>
          </div>
        ))}
        {rows.map((r) => (
          <div key={r.key} className="stack-sm" style={{ gap: 4 }}>
            <div className="row-between">
              <span>{r.label}</span>
              <span className="small muted num">
                {r.pct}% · {fmt(r.avg, r.key)} {r.unit}
                {r.days < r.total ? ` · from ${r.days}/${r.total} days` : ""}
              </span>
            </div>
            <div className="bar">
              <div
                className="bar-fill"
                style={{
                  width: `${Math.min(r.pct, 100)}%`,
                  // Colour by adequacy, and mute anything backed by less than half the range
                  // so a confident-looking bar can't be built on two days of data.
                  background: r.pct >= 100 ? "var(--ok)" : r.pct >= 70 ? "var(--chart-2)" : "var(--warn)",
                  opacity: r.days < r.total / 2 ? 0.45 : 1,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </CardShell>
  );
}


/* ── 6. Does a short night cost you the next day? ─────────────────────────── */

/**
 * Average calories on days FOLLOWING a short night, versus days following a decent one.
 *
 * The day offset is the whole point and the easy thing to get wrong: sleep recorded on the
 * 4th is the night that ends on the morning of the 4th, so what it plausibly influences is
 * the 4th's eating - not the 3rd's. Comparing same-day sleep to same-day calories would be
 * comparing a night to the food eaten before it.
 *
 * Two bars rather than a scatter because with ~60 usable pairs a scatter is a cloud, and
 * the question is a comparison, not a correlation.
 */
export function ShortNightEffect({ days, points, goals }: {
  days: DaySummary[]; points: MetricPoint[]; goals: Goals;
}) {
  const threshold = goals.sleep_target ?? 8;

  const result = useMemo(() => {
    const calByDate = new Map(days.filter((d) => d.entry_count > 0).map((d) => [d.date, d.daily_totals.calories]));
    const sleepByDate = new Map(
      points.filter((p) => p.metric === "sleep").map((p) => [p.date, p.in.h ?? p.value]),
    );

    const short: number[] = [];
    const rested: number[] = [];
    for (const [date, hours] of sleepByDate) {
      // Calories on the SAME date as the sleep: that night ends on this morning.
      const cal = calByDate.get(date);
      if (cal === undefined) continue;
      (hours < threshold ? short : rested).push(cal);
    }
    const mean = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
    return { short: mean(short), rested: mean(rested), shortN: short.length, restedN: rested.length };
  }, [days, points, threshold]);

  // Three per side is the floor for saying anything at all; below that it's an anecdote.
  if (result.short === null || result.rested === null || result.shortN < 3 || result.restedN < 3) {
    return null;
  }

  const delta = result.short - result.rested;
  const rows = [
    { label: `Under ${threshold}h`, calories: result.short, n: result.shortN },
    { label: `${threshold}h or more`, calories: result.rested, n: result.restedN },
  ];

  return (
    <CardShell
      title="After a short night"
      subtitle={
        delta === 0
          ? "No difference in what you eat"
          : `You eat ${Math.abs(delta)} kcal ${delta > 0 ? "more" : "less"} on days that start with under ${threshold}h`
      }
      note={`Compares the ${result.shortN} days that began with a short night against the ${result.restedN} that didn't. Sleep recorded on a date is the night ending that morning, so it is matched to that day's eating. Averages, not proof.`}
    >
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }} />
          <YAxis type="category" dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} width={96} />
          <Tooltip content={(p: any) => {
            if (!p?.active || !p.payload?.length) return null;
            const r = p.payload[0].payload;
            return <Tip rows={[
              { label: r.label, value: "" },
              { label: "Average", value: `${fmt(r.calories)} kcal` },
              { label: "Days", value: String(r.n) },
            ]} />;
          }} cursor={{ fill: "var(--accent-soft)" }} />
          <ReferenceLine x={goals.calories} stroke="var(--chart-2)" strokeDasharray="4 4" />
          <Bar dataKey="calories" fill="var(--chart-1)" radius={[0, 4, 4, 0]} maxBarSize={34} isAnimationActive animationDuration={480} animationEasing="ease-out" />
        </BarChart>
      </ResponsiveContainer>
    </CardShell>
  );
}

/* ── 7. Headline numbers for the new metrics ──────────────────────────────── */

export function MetricStats({ points, goals }: { points: MetricPoint[]; goals: Goals }) {
  const stats = useMemo(() => {
    const sleep = points.filter((p) => p.metric === "sleep").map((p) => p.in.h ?? p.value);
    const distUnit = displayUnit("distance", goals);
    const dist = points.filter((p) => p.metric === "distance").map((p) => p.in[distUnit] ?? p.value);
    const target = goals.sleep_target ?? 8;

    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    return {
      avgSleep: avg(sleep),
      shortNights: sleep.filter((h) => h < target).length,
      nights: sleep.length,
      totalDistance: dist.reduce((a, b) => a + b, 0),
      avgDistance: avg(dist),
      distUnit,
      target,
    };
  }, [points, goals]);

  if (stats.nights === 0 && stats.totalDistance === 0) return null;

  return (
    <div className="grid-auto">
      {stats.avgSleep !== null && (
        <div className="stat">
          <div className="stat-label">Avg sleep</div>
          <div className="stat-value num">{stats.avgSleep.toFixed(1)}h</div>
          <div className="stat-sub">over {stats.nights} nights</div>
        </div>
      )}
      {stats.nights > 0 && (
        <div className="stat">
          <div className="stat-label">Short nights</div>
          <div className="stat-value num">{stats.shortNights}</div>
          <div className="stat-sub">of {stats.nights} under {stats.target}h</div>
        </div>
      )}
      {stats.totalDistance > 0 && (
        <div className="stat">
          <div className="stat-label">Distance</div>
          <div className="stat-value num">{Math.round(stats.totalDistance)}</div>
          <div className="stat-sub">{stats.distUnit} in range</div>
        </div>
      )}
      {stats.avgDistance !== null && (
        <div className="stat">
          <div className="stat-label">Avg walk</div>
          <div className="stat-value num">{stats.avgDistance.toFixed(1)}</div>
          <div className="stat-sub">{stats.distUnit} per logged day</div>
        </div>
      )}
    </div>
  );
}
