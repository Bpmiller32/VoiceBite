// verify.ts
// Deterministic arithmetic checks on a nutrient estimate. No model call, no network.
//
// These catch a specific, common failure: the model returns four macros and a calorie
// count that cannot all be true at once. 4*protein + 4*carbs + 9*fat + 7*alcohol is
// physics, not opinion, and 35.3% of the existing corpus (79 of 224 non-water entries)
// misses it by more than 5%.
//
// Two things this file is deliberately careful about:
//
// - Atwater is checked as a BAND, not a point. Fiber is counted anywhere from 0 to
//   4 kcal/g depending on which labelling convention the source used, so a fiber-heavy
//   food legitimately sits below the naive 4/4/9 sum. Checking against a point would
//   fire on every high-fiber food and train you to ignore the warning.
//
// - Density is only checked when the gram figure came from a real label. When the model
//   supplies both the mass and the nutrients, it can satisfy any density band by adjusting
//   the mass it invented - the check would be self-referential and prove nothing.

import { Nutrients, GramsBasis } from "./types";

export type ViolationCode = "atwater" | "physical_floor" | "density";

export interface Violation {
  code: ViolationCode;
  /** "reject" means these numbers cannot all be true. "warn" means they are implausible. */
  severity: "reject" | "warn";
  message: string;
}

export interface CheckableItem {
  name: string;
  nutrients: Nutrients;
  grams?: number;
  grams_basis?: GramsBasis;
}

/** Nothing edible exceeds this. Pure fat is 8.84 kcal/g; oil is the ceiling case. */
export const MAX_KCAL_PER_G = 9.0;

/**
 * Below this many calories, relative tolerances are meaningless - a 10 kcal drink
 * rounded to the nearest gram of carbohydrate is off by 40% and is perfectly fine.
 * Measured: with this floor, 0 of the 45 sub-100-kcal entries in the corpus fire.
 */
const MIN_KCAL_FOR_RELATIVE_CHECK = 20;

const num = (v: number | null | undefined): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

/**
 * Check one item. Returns an empty array when everything is consistent.
 *
 * Never throws, and never rejects on missing data - an item with no fat figure is
 * incomplete, not wrong, and `null` means unknown everywhere else in this codebase.
 */
export function checkItem(item: CheckableItem): Violation[] {
  const out: Violation[] = [];
  const n = item.nutrients ?? ({} as Nutrients);

  const cal = num(n.calories);
  const p = num(n.protein_g);
  const c = num(n.carbs_g);
  const f = num(n.fat_g);
  const alc = num(n.alcohol_g);

  if (cal <= 0) return out;

  // ── 1. Atwater ceiling ───────────────────────────────────────────────────
  //
  // Deliberately ONE-SIDED, and this took a real product to get right.
  //
  // Claiming MORE energy than the macros can supply is a genuine contradiction: there is
  // no ingredient that adds calories without appearing in protein, fat, carbohydrate or
  // alcohol. Claiming LESS is routine and legitimate - fiber is counted at 0-4 kcal/g
  // depending on convention, and sugar alcohols and allulose are excluded from calories
  // entirely while still being reported inside total carbohydrate.
  //
  // The Legendary Foods protein pastry, one of this user's most-logged foods, is exactly
  // that case: its published 180 kcal sits ~35 kcal below the naive 4/4/9 floor because
  // of allulose. A symmetric band flagged the manufacturer's own label as impossible.
  //
  // Worse, a symmetric band was not scale-invariant: the flat 20 kcal tolerance dominated
  // at small portions, so half a pastry passed while a whole one failed. Same food, same
  // ratios, different verdict. A check that depends on portion size is not a check.
  //
  // The bottom is covered by the physical floor below, which uses only protein and fat -
  // the two that have no such discount.
  const ceiling = 4 * p + 4 * c + 9 * f + 7 * alc;
  const tol = Math.max(0.1 * cal, MIN_KCAL_FOR_RELATIVE_CHECK);

  if (cal > ceiling + tol) {
    out.push({
      code: "atwater",
      severity: "reject",
      message:
        `${item.name}: ${cal} kcal, but protein ${p} g, carbs ${c} g and fat ${f} g can only ` +
        `supply ${ceiling.toFixed(0)} kcal. Energy has to come from somewhere.`,
    });
  }

  // ── 2. Physical floor ────────────────────────────────────────────────────
  // Carbohydrate energy is excluded on purpose: fiber and sugar-alcohol discounts only
  // ever REDUCE the energy carbs contribute, so carbs cannot push the floor up. Protein
  // and fat have no such discount, so their energy is owed unconditionally.
  //
  // Uses the SPECIFIC Atwater factors (fat 8.84, alcohol 6.93), not the rounded general
  // ones (9 and 7). The difference matters at the floor: a tablespoon of olive oil is
  // 14 g of fat labelled 120 kcal, which 9 kcal/g calls impossible (126 > 120) and 8.84
  // correctly accepts (123.8). Fat-dominant foods are exactly where the floor bites, so
  // the rounded factor produces false positives on precisely the items it should pass.
  // The 5% tolerance absorbs label rounding on small servings.
  const floor = 4 * p + 8.84 * f + 6.93 * alc;
  if (floor > cal * 1.05) {
    out.push({
      code: "physical_floor",
      severity: "reject",
      message:
        `${item.name}: ${p} g protein and ${f} g fat alone come to ${floor.toFixed(0)} kcal, ` +
        `more than the ${cal} kcal recorded. No labelling convention permits this.`,
    });
  }

  // ── 3. Energy density ────────────────────────────────────────────────────
  // Gated on a real label serving. See the header note on self-reference.
  if (item.grams_basis === "label_serving" && typeof item.grams === "number" && item.grams > 0) {
    const density = cal / item.grams;
    if (density > MAX_KCAL_PER_G) {
      out.push({
        code: "density",
        severity: "reject",
        message:
          `${item.name}: ${cal} kcal in ${item.grams} g is ${density.toFixed(2)} kcal/g. ` +
          `Pure fat is 8.84 kcal/g, so this serving size or calorie figure is wrong.`,
      });
    }
  }

  return out;
}

/**
 * The Atwater residual as a signed fraction of stored calories, using the nearest edge
 * of the band. 0 means inside the band. Used by the eval harness to track the
 * distribution over time rather than just counting violations.
 */
export function atwaterResidual(n: Nutrients): number | null {
  const cal = num(n.calories);
  // Same floor as the violation check, and for the same reason. A 2 kcal black coffee
  // whose carbs round to 0 g is "40% off" and is entirely correct; without this the
  // residual distribution is dominated by rounding noise on trivial drinks and tells
  // you nothing about the food that actually makes up your day.
  if (cal < MIN_KCAL_FOR_RELATIVE_CHECK) return null;
  const p = num(n.protein_g), c = num(n.carbs_g), f = num(n.fat_g);
  const alc = num(n.alcohol_g), fiber = num(n.fiber_g);

  const ceiling = 4 * p + 4 * c + 9 * f + 7 * alc;
  // Over the ceiling is the only direction that is unambiguously wrong. Under it, report
  // the distance from the fiber-discounted floor so the metric still moves when estimates
  // improve - but never treat "under" as a violation. See checkItem for why.
  if (cal > ceiling) return (cal - ceiling) / cal;
  const floor = 4 * p + 4 * Math.max(0, c - fiber) + 9 * f + 7 * alc;
  if (cal >= floor) return 0;
  return (floor - cal) / cal;
}
