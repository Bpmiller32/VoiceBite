// Weight, distance walked, sleep - entered by hand, one row each.
//
// Lives on Today rather than its own screen because these are things you record in the
// same ten seconds you check the day, not a place you navigate to. Driven entirely by the
// METRICS table, so adding a fourth metric adds a row here for free.
//
// Each row is its own component that owns its own draft, busy, saved and error state.
// That is the point, not an implementation detail: when the card held one shared `busy`,
// saving weight disabled the distance and sleep inputs too, and an error under one row
// appeared under all of them - so three independent things behaved like one batch. Making
// each row a component means independence is structural rather than something you have to
// remember to preserve every time the card is edited.

import { useEffect, useRef, useState } from "react";
import { api, ApiError, toDateString } from "./api";
import { useGoals } from "./goals";
import { METRIC_KEYS, METRICS, displayUnit, metricValue } from "./types";
import type { Goals, MetricKey, MetricPoint } from "./types";

export default function MetricsCard({ date, onChange }: { date: string; onChange?: () => void }) {
  const goals = useGoals();
  // You can plan food for a day that hasn't happened. You cannot weigh yourself, walk, or
  // sleep in it - so the whole card stands down rather than offering inputs that would 400.
  const isFuture = date > toDateString();

  const [readings, setReadings] = useState<Partial<Record<MetricKey, MetricPoint>>>({});
  const [loaded, setLoaded] = useState(false);

  // A response for a day you've already navigated away from must not land in the fields.
  const dateRef = useRef(date);
  dateRef.current = date;

  useEffect(() => {
    if (isFuture) return;
    const forDate = date;
    setLoaded(false);
    api.metrics(forDate, forDate).then(
      (res) => {
        if (dateRef.current !== forDate) return;
        const next: Partial<Record<MetricKey, MetricPoint>> = {};
        for (const m of res.metrics) next[m.metric] = m;
        setReadings(next);
        setLoaded(true);
      },
      () => {
        if (dateRef.current !== forDate) return;
        setReadings({});
        setLoaded(true);
      },
    );
    // Deliberately NOT keyed on `goals`: a goals update (a unit change, a new target)
    // must not re-run this and blow away whatever the user is mid-way through typing.
  }, [date, isFuture]);

  if (isFuture) {
    return (
      <div className="card">
        <div className="card-header"><div className="card-title">Daily numbers</div></div>
        <div className="card-body">
          <p className="small muted">
            You can plan this day's food, but weight, distance and sleep have to wait until
            the day actually happens.
          </p>
        </div>
      </div>
    );
  }

  const recorded = METRIC_KEYS.filter((k) => readings[k]).length;

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">Daily numbers</div>
        <span className="small muted">
          {loaded ? `${recorded} of ${METRIC_KEYS.length} recorded` : "…"}
        </span>
      </div>
      <div className="card-body stack-sm">
        {METRIC_KEYS.map((key) => (
          <MetricRow
            // Remount on date change so a row can never carry another day's draft, and on
            // load so the field picks up whatever came back from the server.
            key={`${date}:${key}:${loaded}`}
            metric={key}
            date={date}
            goals={goals}
            initial={readings[key] ?? null}
            onSaved={(point) => {
              setReadings((prev) => ({ ...prev, [key]: point }));
              onChange?.();
            }}
            onCleared={() => {
              setReadings((prev) => { const next = { ...prev }; delete next[key]; return next; });
              onChange?.();
            }}
          />
        ))}
      </div>
    </div>
  );
}

function MetricRow({
  metric, date, goals, initial, onSaved, onCleared,
}: {
  metric: MetricKey;
  date: string;
  goals: Goals;
  initial: MetricPoint | null;
  onSaved: (point: MetricPoint) => void;
  onCleared: () => void;
}) {
  const def = METRICS[metric];
  const unit = displayUnit(metric, goals);
  const target = def.goalKey ? (goals[def.goalKey] as number | undefined) : undefined;

  const [reading, setReading] = useState<MetricPoint | null>(initial);
  const [draft, setDraft] = useState(initial ? String(metricValue(initial, goals)) : "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dateRef = useRef(date);
  dateRef.current = date;

  async function save() {
    const forDate = date;
    const raw = draft.trim();
    const n = Number(raw);
    if (!raw || !Number.isFinite(n) || n <= 0) {
      setError("Needs a number greater than zero.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.putMetric(forDate, metric, n, unit);
      if (dateRef.current !== forDate) return;
      setReading(res.metric);
      setSaved(true);
      onSaved(res.metric);
    } catch (err) {
      if (dateRef.current !== forDate) return;
      setError(err instanceof ApiError ? err.message : "Couldn't save that.");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    const forDate = date;
    setBusy(true);
    setError(null);
    try {
      await api.deleteMetric(forDate, metric);
      if (dateRef.current !== forDate) return;
      setReading(null);
      setDraft("");
      setSaved(false);
      onCleared();
    } catch (err) {
      if (dateRef.current !== forDate) return;
      setError(err instanceof ApiError ? err.message : "Couldn't remove that.");
    } finally {
      setBusy(false);
    }
  }

  const current = reading ? metricValue(reading, goals) : null;

  // Only say something about the target when there is both a target and a reading.
  let note: string | null = null;
  if (target !== undefined && current !== null) {
    const delta = Math.round((current - target) * 10) / 10;
    if (delta === 0) note = `exactly your ${target} ${unit} goal`;
    else if (def.better === "higher") {
      note = delta > 0 ? `${delta} ${unit} past your ${target} ${unit} goal` : `${Math.abs(delta)} ${unit} short of ${target}`;
    } else {
      note = delta > 0 ? `${delta} ${unit} above your ${target} ${unit} goal` : `${Math.abs(delta)} ${unit} below ${target}`;
    }
  }

  // Disable only THIS row while it is saving. A sibling row mid-request is none of its
  // business - the server takes each metric independently and handles them concurrently.
  return (
    <div className="stack-sm" style={{ gap: 4 }}>
      <div className="row-wrap">
        <label className="field" style={{ flex: "1 1 120px" }}>
          <span className="label">{def.short}</span>
          <input
            className="input num"
            type="number"
            inputMode="decimal"
            step={def.decimals >= 2 ? "0.01" : "0.1"}
            min="0"
            placeholder={def.hint}
            value={draft}
            disabled={busy}
            aria-label={`${def.label} in ${unit}`}
            onChange={(e) => { setDraft(e.target.value); setSaved(false); setError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } }}
          />
        </label>
        <span className="muted" style={{ alignSelf: "end", paddingBottom: 10 }}>{unit}</span>
        <div className="spacer" />
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void save()}>
          {busy ? "…" : reading ? "Update" : "Save"}
        </button>
        {reading && (
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void clear()}>
            Clear
          </button>
        )}
      </div>

      {(saved || note) && (
        <div className="small muted">
          {saved && <span className="badge">saved</span>}
          {saved && note ? " · " : ""}
          {note}
        </div>
      )}

      {/* Scoped to this row - an error saving sleep has nothing to say about weight. */}
      {error && <div className="banner banner-error" role="alert">{error}</div>}
    </div>
  );
}
