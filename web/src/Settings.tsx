// Goals, and a window into the backend.
//
// Every reference line in every chart is drawn from the numbers on this page, which makes
// it more load-bearing than a settings screen usually is: a goal of 0 would pin a chart's
// reference line to the baseline and quietly make every day look like a triumph. So the
// form validates before it saves, and it never writes a partially-parsed object.
//
// Inputs are held as strings rather than numbers. With numeric state you cannot clear a
// field to retype it - it snaps to 0 or NaN under your cursor - which on a phone keypad is
// maddening. Strings in, validated numbers out at submit.

import { useState, useEffect } from "react";
import type { FormEvent } from "react";
import { api } from "./api";
import { getGoals, saveGoals, useGoals } from "./goals";
import { DEFAULT_GOALS } from "./types";
import type { Goals, WeightUnit } from "./types";
import { useAsync } from "./useAsync";

// Only the numeric goals. weight_unit is an enum and weight_target is optional, so
// neither belongs in the "parse a positive number out of a text field" machinery below.
type GoalKey = Exclude<keyof Goals, "weight_unit" | "distance_unit" | "weight_target" | "distance_target" | "sleep_target">;

interface FieldSpec {
  key: GoalKey;
  label: string;
  unit: string;
  /** Upper bound for typo-catching, not nutrition advice - 22000 kcal is a slipped keypress. */
  max: number;
}

const TARGETS: FieldSpec[] = [
  { key: "calories", label: "Calories", unit: "kcal", max: 10000 },
  { key: "protein_g", label: "Protein", unit: "g", max: 500 },
  { key: "carbs_g", label: "Carbs", unit: "g", max: 1200 },
  { key: "fat_g", label: "Fat", unit: "g", max: 500 },
  { key: "water_ml", label: "Water", unit: "ml", max: 10000 },
];

const WEIGHT_UNITS: WeightUnit[] = ["lb", "kg"];

const ALL_FIELDS = TARGETS;

type FormValues = Record<GoalKey, string>;

function toForm(goals: Goals): FormValues {
  const out = {} as FormValues;
  for (const field of ALL_FIELDS) out[field.key] = String(goals[field.key]);
  return out;
}

export default function Settings() {
  const stored = useGoals();
  const [form, setForm] = useState<FormValues>(() => toForm(getGoals()));
  const [errors, setErrors] = useState<Partial<Record<GoalKey, string>>>({});
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [weightError, setWeightError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // Weight lives beside the numeric goals but doesn't share their validation: the target
  // is optional (blank means "just track it, don't aim at a number") and the unit is a choice.
  const [weightTarget, setWeightTarget] = useState<string>(() => {
    const t = getGoals().weight_target;
    return t === undefined ? "" : String(t);
  });
  const [weightUnit, setWeightUnit] = useState<WeightUnit>(() => getGoals().weight_unit);
  const [distanceUnit, setDistanceUnit] = useState<"mi" | "km">(() => getGoals().distance_unit);
  const num = (v: number | undefined) => (v === undefined ? "" : String(v));
  const [sleepTarget, setSleepTarget] = useState<string>(() => num(getGoals().sleep_target));
  const [distanceTarget, setDistanceTarget] = useState<string>(() => num(getGoals().distance_target));

  // Goals arrive asynchronously from the server. If they land while the form is untouched,
  // adopt them; if the user has started typing, leave their edits alone rather than
  // yanking values out from under them mid-keystroke.
  useEffect(() => {
    if (!dirty) {
      setForm(toForm(stored));
      setWeightTarget(stored.weight_target === undefined ? "" : String(stored.weight_target));
      setWeightUnit(stored.weight_unit);
      setDistanceUnit(stored.distance_unit);
      setSleepTarget(num(stored.sleep_target));
      setDistanceTarget(num(stored.distance_target));
    }
  }, [stored, dirty]);

  const health = useAsync(() => api.health(), []);

  function update(key: GoalKey, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setSaveError(null);
    // Any edit invalidates the previous confirmation - a stale "Saved" next to changed
    // numbers is worse than no confirmation at all.
    setSaved(false);
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;

    const next = { weight_unit: weightUnit, distance_unit: distanceUnit } as Goals;
    const found: Partial<Record<GoalKey, string>> = {};

    for (const field of ALL_FIELDS) {
      const raw = form[field.key].trim();
      const value = Number(raw);

      // Number("") is 0, so the empty check has to come first or a blank field silently
      // becomes a zero goal.
      if (raw === "" || !Number.isFinite(value)) {
        found[field.key] = "needs a number";
      } else if (value <= 0) {
        found[field.key] = "must be greater than zero";
      } else if (value > field.max) {
        found[field.key] = `looks like a typo (max ${field.max.toLocaleString()} ${field.unit})`;
      } else {
        next[field.key] = Math.round(value * 10) / 10;
      }
    }

    // A blank weight target is valid and means "no goal weight" - only a non-blank
    // value that isn't a sensible number is an error.
    let weightProblem: string | null = null;
    const rawTarget = weightTarget.trim();
    if (rawTarget !== "") {
      const t = Number(rawTarget);
      const maxWeight = weightUnit === "kg" ? 454 : 1000;
      if (!Number.isFinite(t) || t <= 0) {
        weightProblem = "needs a number, or leave it blank";
      } else if (t > maxWeight) {
        weightProblem = `looks like a typo (max ${maxWeight} ${weightUnit})`;
      } else {
        next.weight_target = Math.round(t * 10) / 10;
      }
    }
    // Both optional: blank means "no target", any other non-number is an error.
    for (const [raw, key, max] of [[sleepTarget, "sleep_target", 24], [distanceTarget, "distance_target", 200]] as const) {
      const t = raw.trim();
      if (t === "") continue;
      const n = Number(t);
      if (!Number.isFinite(n) || n <= 0 || n > max) {
        weightProblem = weightProblem ?? `${key === "sleep_target" ? "Sleep" : "Distance"} goal needs a number up to ${max}, or leave it blank`;
      } else {
        (next as any)[key] = Math.round(n * 100) / 100;
      }
    }
    setWeightError(weightProblem);

    setErrors(found);
    if (Object.keys(found).length > 0 || weightProblem) {
      setSaved(false);
      return;
    }

    // Goals live on the server now, so saving can fail. Report it rather than showing
    // "Saved" over values the Pi never accepted.
    setSaving(true);
    setSaveError(null);
    try {
      const confirmed = await saveGoals(next);
      // Re-seed from what actually landed, so the fields show exactly what the charts will
      // use - "2,200" or " 2200 " becomes 2200 on screen.
      setForm(toForm(confirmed));
      setDirty(false);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save your goals");
      setSaved(false);
    } finally {
      setSaving(false);
    }
  }

  function restoreDefaults() {
    setForm(toForm(DEFAULT_GOALS));
    setErrors({});
    setSaved(false);
    setSaveError(null);
    // Marks the form dirty on purpose: these are proposed values, not stored ones, and
    // nothing is persisted until Save. Without this a server refresh would wipe them.
    setDirty(true);
  }

  const invalid = ALL_FIELDS.filter((field) => errors[field.key]);

  return (
    <div className="stack">
      <form className="card" onSubmit={handleSubmit} noValidate>
        <div className="card-header">
          <span className="card-title">Daily goals</span>
          <span className="card-subtitle">Every reference line in the charts comes from here</span>
        </div>

        <div className="card-body stack">
          {invalid.length > 0 && (
            <div className="banner banner-error" role="alert">
              <div className="stack-sm">
                <strong>Nothing was saved.</strong>
                <span className="small">
                  {invalid.map((field) => `${field.label} ${errors[field.key]}`).join(" · ")}
                </span>
              </div>
            </div>
          )}

          {saved && (
            <div className="banner banner-info" role="status">
              <span aria-hidden="true">✓</span>
              <span>Saved to the Pi. Every device uses these numbers now.</span>
            </div>
          )}

          {saveError && (
            <div className="banner banner-error" role="alert">
              <span aria-hidden="true">⚠</span>
              <span>{saveError} — your previous goals are still in effect.</span>
            </div>
          )}

          <div className="stack-sm">
            <span className="h3">Targets</span>
            <span className="small muted">Numbers you are aiming to reach.</span>
          </div>

          <div className="grid-3">
            {TARGETS.map((field) => (
              <GoalField
                key={field.key}
                field={field}
                value={form[field.key]}
                error={errors[field.key]}
                onChange={update}
              />
            ))}
          </div>

          <div className="stack-sm">
            <span className="h3">Daily numbers</span>
            <span className="small muted">
              Weight, distance walked and sleep. Leave a goal blank to track it without
              aiming at a number. Changing a unit only changes how values are shown — past
              readings keep the unit they were entered in, so nothing gets re-rounded.
            </span>
          </div>

          <div className="grid-2">
            <label className="field">
              <span className="label">Goal weight</span>
              <input
                className="input num"
                type="number"
                inputMode="decimal"
                step="0.1"
                min="0"
                placeholder="optional"
                value={weightTarget}
                onChange={(e) => { setWeightTarget(e.target.value); setDirty(true); setSaved(false); }}
                aria-invalid={weightError ? true : undefined}
              />
              <span className="small muted">{weightError ?? weightUnit}</span>
            </label>

            <label className="field">
              <span className="label">Show weights in</span>
              <select
                className="select"
                value={weightUnit}
                onChange={(e) => { setWeightUnit(e.target.value as WeightUnit); setDirty(true); setSaved(false); }}
              >
                {WEIGHT_UNITS.map((u) => (
                  <option key={u} value={u}>{u === "lb" ? "Pounds (lb)" : "Kilograms (kg)"}</option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="label">Sleep goal</span>
              <input
                className="input num" type="number" inputMode="decimal" step="0.5" min="0" max="24"
                placeholder="optional"
                value={sleepTarget}
                onChange={(e) => { setSleepTarget(e.target.value); setDirty(true); setSaved(false); }}
              />
              <span className="small muted">hours</span>
            </label>

            <label className="field">
              <span className="label">Distance goal</span>
              <input
                className="input num" type="number" inputMode="decimal" step="0.1" min="0"
                placeholder="optional"
                value={distanceTarget}
                onChange={(e) => { setDistanceTarget(e.target.value); setDirty(true); setSaved(false); }}
              />
              <span className="small muted">{distanceUnit} per day</span>
            </label>

            <label className="field">
              <span className="label">Show distance in</span>
              <select
                className="select"
                value={distanceUnit}
                onChange={(e) => { setDistanceUnit(e.target.value as "mi" | "km"); setDirty(true); setSaved(false); }}
              >
                <option value="mi">Miles (mi)</option>
                <option value="km">Kilometres (km)</option>
              </select>
            </label>
          </div>

          <div className="row-wrap">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Saving…" : "Save goals"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={restoreDefaults} disabled={saving}>
              Restore defaults
            </button>
          </div>

          <p className="small muted">
            Goals are stored on the Pi, so your phone and your desktop draw the same
            reference lines. A copy is cached in this browser so the charts still render
            with your real targets if the Pi is unreachable.
          </p>
        </div>
      </form>

      <section className="card">
        <div className="card-header">
          <span className="card-title">Backend</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={health.reload}
            disabled={health.status === "loading"}
          >
            {health.status === "loading" ? <span className="spinner" /> : "Recheck"}
          </button>
        </div>

        <div className="card-body stack-sm">
          {health.status === "error" && (
            <div className="banner banner-error" role="alert">
              <span>{health.error}</span>
            </div>
          )}

          {health.status === "success" && (
            <>
              <HealthRow label="Status" value={health.data.ok ? "healthy" : "degraded"} />
              <HealthRow label="Model" value={health.data.model} />
              <HealthRow label="Schema version" value={String(health.data.schemaVersion)} />
              <HealthRow label="Uptime" value={formatUptime(health.data.uptimeSeconds)} />
            </>
          )}

          {(health.status === "idle" || health.status === "loading") && (
            // One placeholder per row below, so the card does not resize when it lands.
            <>
              <div className="skeleton" />
              <div className="skeleton" />
              <div className="skeleton" />
              <div className="skeleton" />
            </>
          )}

          <p className="small muted">
            Worth a glance when an estimate looks wrong — a changed model or a schema
            version ahead of this app explains more than the food does. A short uptime
            means the server restarted recently.
          </p>
        </div>
      </section>
    </div>
  );
}

function GoalField({
  field,
  value,
  error,
  onChange,
}: {
  field: FieldSpec;
  value: string;
  error?: string;
  onChange: (key: GoalKey, value: string) => void;
}) {
  return (
    <label className="field">
      <span className="label">
        {field.label} <span className="muted">({field.unit})</span>
      </span>
      <input
        className="input num"
        type="number"
        // inputMode on top of type=number: iOS Safari gives the decimal keypad, which has
        // the digits big enough to hit one-handed.
        inputMode="decimal"
        step="any"
        min={0}
        max={field.max}
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(field.key, event.target.value)}
      />
      <span className="small muted">
        {error ? `↑ ${error}` : `1 – ${field.max.toLocaleString()}`}
      </span>
    </label>
  );
}

function HealthRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row-between">
      <span className="small muted">{label}</span>
      <span className="mono num truncate">{value}</span>
    </div>
  );
}

/** Coarse on purpose - "3d 4h" answers "did it restart?" and nobody needs the seconds. */
function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
}
