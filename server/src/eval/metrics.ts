// eval/metrics.ts
// The four accuracy metrics, as pure functions over a set of day logs.
//
// Three of the four need no ground truth at all - they measure whether the estimator
// contradicts itself, which it can do without anyone knowing the right answer. That
// matters because ground truth is expensive and these can run on every corpus, today.
//
// The fourth (gold-set error) needs eval/gold.json and is skipped when it is absent.

import { DayLog, FoodEntry, Nutrients, NUTRIENT_KEYS, CORE_NUTRIENT_KEYS, NutrientKey } from "../types";
import { atwaterResidual, checkItem } from "../verify";
import { foodKey } from "../store";

// ── shared helpers ─────────────────────────────────────────────────────────

/** Food only. Water entries carry 29 structural zeros and would swamp every statistic. */
export function foodEntries(days: DayLog[]): FoodEntry[] {
  return days.flatMap((d) => d.entries).filter((e) => e.source !== "water");
}

/**
 * Group key for "is this the same food". Mirrors store.ts foodKey so the harness and
 * the /foods endpoint agree on what counts as a repeat, then adds the portion, because
 * two loggings of different sizes are not evidence of disagreement.
 */
export function repeatKey(e: FoodEntry): string {
  const base = (e.parsed?.name ?? e.food_name)
    .toLowerCase()
    .replace(/\s*\([^()]*\)\s*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const portion = e.parsed
    ? `${e.parsed.quantity} ${e.parsed.unit}`.toLowerCase().trim()
    : e.serving_description.toLowerCase().trim();
  return `${base} @ ${portion}`;
}

function quantiles(xs: number[], qs: number[]): number[] {
  if (xs.length === 0) return qs.map(() => 0);
  const s = [...xs].sort((a, b) => a - b);
  return qs.map((q) => s[Math.min(s.length - 1, Math.floor(q * s.length))]);
}

// ── 1. Atwater residual ────────────────────────────────────────────────────

export interface AtwaterMetric {
  entries: number;
  p50: number;
  p90: number;
  over5pct: number;
  over10pct: number;
  over20pct: number;
  impossible: number;
  worst: Array<{ name: string; calories: number; residualPct: number }>;
}

export function atwaterMetric(days: DayLog[]): AtwaterMetric {
  const entries = foodEntries(days);
  const rows: Array<{ name: string; calories: number; residual: number }> = [];
  let impossible = 0;

  for (const e of entries) {
    const r = atwaterResidual(e.nutrients);
    if (r === null) continue;
    rows.push({ name: e.food_name, calories: e.nutrients.calories ?? 0, residual: Math.abs(r) });
    if (checkItem({ name: e.food_name, nutrients: e.nutrients }).some((v) => v.code === "physical_floor")) {
      impossible++;
    }
  }

  const abs = rows.map((r) => r.residual);
  const [p50, p90] = quantiles(abs, [0.5, 0.9]);

  return {
    entries: rows.length,
    p50: round(p50 * 100, 2),
    p90: round(p90 * 100, 2),
    over5pct: abs.filter((r) => r > 0.05).length,
    over10pct: abs.filter((r) => r > 0.1).length,
    over20pct: abs.filter((r) => r > 0.2).length,
    impossible,
    worst: rows
      .sort((a, b) => b.residual - a.residual)
      .slice(0, 8)
      .map((r) => ({ name: r.name, calories: r.calories, residualPct: round(r.residual * 100, 1) })),
  };
}

// ── 2. Self-agreement across repeat loggings ───────────────────────────────

export interface RepeatGroup {
  key: string;
  count: number;
  /** max/min for each nutrient the group disagrees on. 1.0 means perfect agreement. */
  spreads: Partial<Record<NutrientKey, number>>;
  calorieValues: number[];
}

export interface SelfAgreementMetric {
  groups: number;
  /** Groups that agree on every nutrient they both report. */
  stableGroups: number;
  /** Groups that disagree on at least one nutrient - including fiber or cholesterol only. */
  unstableGroups: number;
  /** Groups that disagree specifically on calories. The headline the user feels. */
  calorieUnstableGroups: number;
  /** Share of all food entries that sit in a group that disagrees with itself. */
  unstableEntryShare: number;
  worstCalorieSpread: number;
  worst: RepeatGroup[];
}

export function selfAgreementMetric(days: DayLog[]): SelfAgreementMetric {
  const byKey = new Map<string, FoodEntry[]>();
  for (const e of foodEntries(days)) {
    const k = repeatKey(e);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(e);
  }

  const groups: RepeatGroup[] = [];
  let unstableEntries = 0;
  let totalEntriesInGroups = 0;

  for (const [key, es] of byKey) {
    if (es.length < 2) continue;
    totalEntriesInGroups += es.length;

    const spreads: Partial<Record<NutrientKey, number>> = {};
    let unstable = false;
    for (const k of NUTRIENT_KEYS) {
      const vals = es.map((e) => e.nutrients[k]).filter((v): v is number => typeof v === "number" && v > 0);
      if (vals.length < 2) continue;
      const spread = Math.max(...vals) / Math.min(...vals);
      if (spread > 1.001) {
        spreads[k] = round(spread, 3);
        unstable = true;
      }
    }
    if (unstable) unstableEntries += es.length;

    groups.push({
      key,
      count: es.length,
      spreads,
      calorieValues: es.map((e) => e.nutrients.calories ?? 0),
    });
  }

  const unstableGroups = groups.filter((g) => Object.keys(g.spreads).length > 0);

  return {
    groups: groups.length,
    stableGroups: groups.length - unstableGroups.length,
    unstableGroups: unstableGroups.length,
    calorieUnstableGroups: groups.filter((g) => (g.spreads.calories ?? 1) > 1.001).length,
    unstableEntryShare: totalEntriesInGroups ? round(unstableEntries / totalEntriesInGroups, 3) : 0,
    worstCalorieSpread: round(Math.max(1, ...unstableGroups.map((g) => g.spreads.calories ?? 1)), 3),
    worst: unstableGroups
      .sort((a, b) => (b.spreads.calories ?? 1) - (a.spreads.calories ?? 1))
      .slice(0, 10),
  };
}

// ── 3. Micronutrient coverage ──────────────────────────────────────────────

export interface CoverageMetric {
  entries: number;
  /** Share of entries carrying a non-null value, per nutrient. */
  byNutrient: Record<string, number>;
  /** Mean coverage across the non-macro nutrients - the headline number. */
  microMean: number;
  /**
   * Share of non-null values that are exactly 0. A high number here on legacy data is
   * the "unknown stored as zero" regime; on new data it should be small and real.
   */
  hardZeroShare: number;
}

export function coverageMetric(days: DayLog[]): CoverageMetric {
  const entries = foodEntries(days);
  const byNutrient: Record<string, number> = {};
  let known = 0;
  let zeros = 0;

  for (const k of NUTRIENT_KEYS) {
    const withValue = entries.filter((e) => typeof e.nutrients[k] === "number").length;
    byNutrient[k] = entries.length ? round(withValue / entries.length, 3) : 0;
  }
  for (const e of entries) {
    for (const k of NUTRIENT_KEYS) {
      const v = e.nutrients[k];
      if (typeof v === "number") {
        known++;
        if (v === 0) zeros++;
      }
    }
  }

  const micros = NUTRIENT_KEYS.filter((k) => !CORE_NUTRIENT_KEYS.includes(k));
  const microMean = micros.reduce((s, k) => s + byNutrient[k], 0) / micros.length;

  return {
    entries: entries.length,
    byNutrient,
    microMean: round(microMean, 3),
    hardZeroShare: known ? round(zeros / known, 3) : 0,
  };
}

// ── 4. Gold-set error ──────────────────────────────────────────────────────

export interface GoldItem {
  /**
   * How this gold row finds its entries. `backfill --gold` writes store.ts foodKey(food_name)
   * here; a hand-authored row may instead put a plain substring to match against food_name.
   * goldMetric tries foodKey equality first, then repeatKey, then a substring fallback.
   */
  match: string;
  display_name: string;
  /** Published values for the portion described by `match`. Omit what the source doesn't state. */
  expected: Partial<Nutrients>;
  source_url: string;
}

export interface GoldMetric {
  covered: number;
  byNutrient: Record<string, { mape: number; n: number }>;
  worst: Array<{ name: string; nutrient: string; expected: number; got: number; errPct: number }>;
}

// NOTE on what this metric does and doesn't tell you: an entry that was logged from the
// pantry carries numbers that came from the same published label the gold `expected` values
// were copied from, so it scores near-zero error by construction. The gold metric is
// therefore most meaningful for entries the pipeline estimated or grounded fresh; a mix
// weighted toward pantry hits will read more accurate than the estimator actually is.
export function goldMetric(days: DayLog[], gold: GoldItem[]): GoldMetric {
  const entries = foodEntries(days);
  const errs: Record<string, number[]> = {};
  const worst: GoldMetric["worst"] = [];
  let covered = 0;

  for (const g of gold) {
    // foodKey equality is the primary match: `backfill --gold` writes foodKey(food_name) into
    // `match`, and that key flattens punctuation ("Chick-fil-A" -> "chick fil a"), so the old
    // repeatKey/substring paths silently dropped every branded name with an apostrophe or
    // hyphen - i.e. exactly the chain foods grounding exists to handle. repeatKey and the
    // substring fallback remain for hand-authored rows.
    const target = g.match.toLowerCase();
    const matched = entries.filter(
      (e) => foodKey(e.food_name) === g.match ||
        repeatKey(e) === g.match ||
        e.food_name.toLowerCase().includes(target),
    );
    if (matched.length === 0) continue;
    covered += matched.length;

    for (const [nutrient, expectedRaw] of Object.entries(g.expected)) {
      const expected = expectedRaw as number;
      if (typeof expected !== "number" || expected <= 0) continue;
      for (const e of matched) {
        const got = e.nutrients[nutrient as NutrientKey];
        if (typeof got !== "number") continue;
        const err = Math.abs(got - expected) / expected;
        (errs[nutrient] ??= []).push(err);
        worst.push({
          name: e.food_name,
          nutrient,
          expected,
          got,
          errPct: round(err * 100, 1),
        });
      }
    }
  }

  const byNutrient: GoldMetric["byNutrient"] = {};
  for (const [k, xs] of Object.entries(errs)) {
    byNutrient[k] = { mape: round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100, 1), n: xs.length };
  }

  return {
    covered,
    byNutrient,
    worst: worst.sort((a, b) => b.errPct - a.errPct).slice(0, 12),
  };
}

// ── report shape ───────────────────────────────────────────────────────────

export interface EvalReport {
  tag: string;
  measuredAt: string;
  /** The slice measured. Recorded because a whole-corpus number mixes pipeline eras. */
  from: string | null;
  to: string | null;
  days: number;
  atwater: AtwaterMetric;
  selfAgreement: SelfAgreementMetric;
  coverage: CoverageMetric;
  gold: GoldMetric | null;
}

export function buildReport(
  tag: string,
  days: DayLog[],
  gold: GoldItem[] | null,
  range: { from?: string; to?: string } = {},
): EvalReport {
  return {
    tag,
    measuredAt: new Date().toISOString(),
    from: range.from ?? null,
    to: range.to ?? null,
    days: days.length,
    atwater: atwaterMetric(days),
    selfAgreement: selfAgreementMetric(days),
    coverage: coverageMetric(days),
    gold: gold && gold.length ? goldMetric(days, gold) : null,
  };
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
