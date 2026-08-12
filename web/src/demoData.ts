// Synthetic data for demo mode.
//
// Two properties matter more than realism:
//
// 1. It is generated RELATIVE TO TODAY, every time the page loads. Day 0 is always today,
//    day 89 is always 89 days ago. A visitor in March and a visitor in November both see
//    "the last three months", and nobody has to remember to regenerate a fixture that
//    would otherwise quietly rot into a chart of ancient history.
//
// 2. It is deterministic per slot. Each day's content is derived from a seeded PRNG keyed
//    on how many days ago it is, so the app doesn't reshuffle itself on every re-render -
//    and the whole pattern simply slides forward one slot per day.
//
// It is also deliberately imperfect: days are missing, some entries have no micronutrient
// data, sodium and sugar run high. A demo where everything is complete and on target would
// hide exactly the parts of this UI that took the most care - the gaps, the partial-coverage
// disclosure, the limit bands.

import type { DayLog, DaySummary, FoodEntry, LogBatch, MetricKey, MetricPoint, NutrientKey, Nutrients } from "./types";
import { NUTRIENT_KEYS } from "./types";

export const DEMO_DAYS = 90;

/** Small, fast, seeded PRNG. Same seed in, same sequence out. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The date `daysAgo` days before today, in local time. */
export function dayOffset(daysAgo: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0); // noon: immune to DST shifting the date underneath us
  d.setDate(d.getDate() - daysAgo);
  return toDateString(d);
}

/** Build a full Nutrients object from macros plus whatever micros we know. Rest stay null. */
function nutrients(
  macros: { calories: number; protein_g: number; fat_g: number; carbs_g: number },
  micros: Partial<Record<NutrientKey, number>> = {},
): Nutrients {
  const out = Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, null])) as Nutrients;
  out.calories = macros.calories;
  out.protein_g = macros.protein_g;
  out.fat_g = macros.fat_g;
  out.carbs_g = macros.carbs_g;
  for (const [k, v] of Object.entries(micros)) out[k as NutrientKey] = v;
  return out;
}

interface FoodTemplate {
  name: string;
  serving: string;
  macros: { calories: number; protein_g: number; fat_g: number; carbs_g: number };
  micros?: Partial<Record<NutrientKey, number>>;
  meal: "breakfast" | "lunch" | "dinner" | "snack" | "drink";
}

// A believable diet: some cooking, a lot of takeout, too much soda. The micronutrient
// coverage is uneven on purpose - packaged items carry full labels, restaurant food doesn't.
const FOODS: FoodTemplate[] = [
  { name: "Scrambled eggs", serving: "2 large egg", meal: "breakfast",
    macros: { calories: 180, protein_g: 12, fat_g: 13, carbs_g: 2 },
    micros: { sodium_mg: 170, cholesterol_mg: 370, vitamin_a_mcg: 160, vitamin_d_mcg: 2, calcium_mg: 50, iron_mg: 1.8, selenium_mcg: 30, riboflavin_mg: 0.5 } },
  { name: "Sourdough toast with butter", serving: "2 slice", meal: "breakfast",
    macros: { calories: 240, protein_g: 7, fat_g: 10, carbs_g: 30 },
    micros: { sodium_mg: 380, fiber_g: 2, calcium_mg: 60, iron_mg: 2, thiamin_mg: 0.3 } },
  { name: "Banana", serving: "1 medium", meal: "snack",
    macros: { calories: 105, protein_g: 1.3, fat_g: 0.4, carbs_g: 27 },
    micros: { fiber_g: 3.1, sugar_g: 14, potassium_mg: 422, magnesium_mg: 32, vitamin_c_mg: 10, vitamin_b6_mg: 0.4, folate_mcg: 24 } },
  { name: "Greek yogurt with honey", serving: "1 cup", meal: "breakfast",
    macros: { calories: 220, protein_g: 20, fat_g: 5, carbs_g: 26 },
    micros: { sugar_g: 24, calcium_mg: 230, potassium_mg: 280, vitamin_b12_mcg: 1.3, riboflavin_mg: 0.5, phosphorus_mg: 270 } },
  { name: "Overnight oats", serving: "1 serving", meal: "breakfast",
    macros: { calories: 340, protein_g: 12, fat_g: 9, carbs_g: 55 },
    micros: { fiber_g: 8, sugar_g: 12, iron_mg: 3, magnesium_mg: 110, zinc_mg: 2.4, phosphorus_mg: 340 } },
  { name: "Chipotle chicken burrito bowl", serving: "1 serving", meal: "lunch",
    macros: { calories: 780, protein_g: 45, fat_g: 27, carbs_g: 84 },
    micros: { sodium_mg: 1600, fiber_g: 12 } },
  { name: "Turkey sandwich", serving: "1 sandwich", meal: "lunch",
    macros: { calories: 430, protein_g: 28, fat_g: 14, carbs_g: 45 },
    micros: { sodium_mg: 1180, fiber_g: 4, calcium_mg: 120 } },
  { name: "Caesar salad with grilled chicken", serving: "1 serving", meal: "lunch",
    macros: { calories: 520, protein_g: 38, fat_g: 32, carbs_g: 16 },
    micros: { sodium_mg: 1050, vitamin_a_mcg: 320, vitamin_k_mcg: 90, calcium_mg: 200 } },
  { name: "Raising Cane's 3 Finger Combo", serving: "1 serving", meal: "lunch",
    macros: { calories: 1160, protein_g: 46, fat_g: 62, carbs_g: 104 },
    micros: { sodium_mg: 2100 } },
  { name: "Leftover pad thai", serving: "1 serving", meal: "dinner",
    macros: { calories: 690, protein_g: 24, fat_g: 26, carbs_g: 88 },
    micros: { sodium_mg: 1450, sugar_g: 22 } },
  { name: "Salmon with rice and broccoli", serving: "1 serving", meal: "dinner",
    macros: { calories: 620, protein_g: 44, fat_g: 24, carbs_g: 56 },
    micros: { sodium_mg: 340, fiber_g: 5, potassium_mg: 980, vitamin_d_mcg: 14, vitamin_b12_mcg: 4.8, selenium_mcg: 48, magnesium_mg: 95, vitamin_c_mg: 80 } },
  { name: "Spaghetti bolognese", serving: "1 serving", meal: "dinner",
    macros: { calories: 720, protein_g: 34, fat_g: 26, carbs_g: 82 },
    micros: { sodium_mg: 890, fiber_g: 7, iron_mg: 5, zinc_mg: 6 } },
  { name: "Domino's medium pepperoni pizza", serving: "half a pizza", meal: "dinner",
    macros: { calories: 980, protein_g: 40, fat_g: 42, carbs_g: 108 },
    micros: { sodium_mg: 2300 } },
  { name: "Beef tacos", serving: "3 taco", meal: "dinner",
    macros: { calories: 610, protein_g: 30, fat_g: 31, carbs_g: 50 },
    micros: { sodium_mg: 1100, iron_mg: 4 } },
  { name: "Chicken stir fry", serving: "1 serving", meal: "dinner",
    macros: { calories: 540, protein_g: 40, fat_g: 18, carbs_g: 52 },
    micros: { sodium_mg: 1250, fiber_g: 6, vitamin_c_mg: 65, vitamin_a_mcg: 410, potassium_mg: 720 } },
  { name: "Celsius energy drink", serving: "12 fl oz", meal: "drink",
    macros: { calories: 10, protein_g: 0, fat_g: 0, carbs_g: 2 },
    micros: { caffeine_mg: 200, sodium_mg: 0, vitamin_c_mg: 60, vitamin_b12_mcg: 6, niacin_mg: 20, vitamin_b6_mg: 2 } },
  { name: "Iced oat latte", serving: "16 fl oz", meal: "drink",
    macros: { calories: 190, protein_g: 4, fat_g: 8, carbs_g: 26 },
    micros: { caffeine_mg: 150, sugar_g: 18, calcium_mg: 320 } },
  { name: "Mountain Dew", serving: "20 fl oz", meal: "drink",
    macros: { calories: 290, protein_g: 0, fat_g: 0, carbs_g: 77 },
    micros: { sugar_g: 77, sodium_mg: 105, caffeine_mg: 91 } },
  { name: "Black coffee", serving: "12 fl oz", meal: "drink",
    macros: { calories: 5, protein_g: 0.3, fat_g: 0, carbs_g: 0 },
    micros: { caffeine_mg: 140, sodium_mg: 5, potassium_mg: 116 } },
  { name: "Protein shake", serving: "1 scoop", meal: "drink",
    macros: { calories: 130, protein_g: 25, fat_g: 1.5, carbs_g: 4 },
    micros: { sodium_mg: 180, calcium_mg: 140, iron_mg: 1, potassium_mg: 210 } },
  { name: "Chomps beef stick", serving: "2 stick", meal: "snack",
    macros: { calories: 200, protein_g: 20, fat_g: 13, carbs_g: 0 },
    micros: { sodium_mg: 460, zinc_mg: 2.4, vitamin_b12_mcg: 1.4, iron_mg: 1.6 } },
  { name: "Trail mix", serving: "1/4 cup", meal: "snack",
    macros: { calories: 260, protein_g: 8, fat_g: 17, carbs_g: 22 },
    micros: { fiber_g: 4, magnesium_mg: 85, zinc_mg: 1.5, vitamin_e_mg: 5, phosphorus_mg: 210 } },
  { name: "Ben & Jerry's", serving: "1 cup", meal: "snack",
    macros: { calories: 560, protein_g: 9, fat_g: 32, carbs_g: 60 },
    micros: { sugar_g: 54, calcium_mg: 240, saturated_fat_g: 20 } },
  { name: "Tortilla chips and salsa", serving: "1 serving", meal: "snack",
    macros: { calories: 380, protein_g: 6, fat_g: 19, carbs_g: 46 },
    micros: { sodium_mg: 690, fiber_g: 5 } },
  { name: "Apple with peanut butter", serving: "1 serving", meal: "snack",
    macros: { calories: 280, protein_g: 8, fat_g: 16, carbs_g: 30 },
    micros: { fiber_g: 6, sugar_g: 20, potassium_mg: 420, magnesium_mg: 55, vitamin_e_mg: 3 } },
];

const BREAKFAST = FOODS.filter((f) => f.meal === "breakfast");
const LUNCH = FOODS.filter((f) => f.meal === "lunch");
const DINNER = FOODS.filter((f) => f.meal === "dinner");
const SNACK = FOODS.filter((f) => f.meal === "snack");
const DRINK = FOODS.filter((f) => f.meal === "drink");

function pick<T>(arr: T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length)];
}

function entryFrom(t: FoodTemplate, rnd: () => number, dropMicros: boolean): FoodEntry {
  // Portions vary a bit, the way a real estimate would.
  const scale = 0.85 + rnd() * 0.3;
  const round = (n: number, dp = 0) => Math.round(n * scale * 10 ** dp) / 10 ** dp;

  const micros: Partial<Record<NutrientKey, number>> = {};
  if (!dropMicros && t.micros) {
    for (const [k, v] of Object.entries(t.micros)) micros[k as NutrientKey] = round(v as number, 1);
  }

  return {
    id: `demo-${Math.floor(rnd() * 1e9).toString(36)}`,
    food_name: `${t.name} (${t.serving})`,
    serving_description: t.serving,
    source: "claude_estimate",
    nutrients: nutrients(
      {
        calories: round(t.macros.calories),
        protein_g: round(t.macros.protein_g),
        fat_g: round(t.macros.fat_g),
        carbs_g: round(t.macros.carbs_g),
      },
      micros,
    ),
    parsed: { name: t.name, quantity: 1, unit: t.serving },
  };
}

function waterEntry(ml: number, rnd: () => number): FoodEntry {
  const zeros = Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, 0])) as Nutrients;
  return {
    id: `demo-w-${Math.floor(rnd() * 1e9).toString(36)}`,
    food_name: `water (${ml}ml)`,
    serving_description: `${ml} ml`,
    source: "water",
    nutrients: zeros,
    water_ml: ml,
  };
}

/** Build one day. Returns null for days the demo user "didn't log". */
function buildDay(daysAgo: number, sleepHours: number | null): { entries: FoodEntry[]; batches: LogBatch[] } | null {
  const date = dayOffset(daysAgo);
  const rnd = mulberry32(daysAgo * 7919 + 13);

  // Roughly one day in seven unlogged, so the charts show real gaps rather than a solid
  // block - the "days with nothing logged are left blank" behaviour is worth demonstrating.
  if (rnd() < 0.14) return null;

  // Weekday matters: weekends run heavier. Uses the real weekday of this date, so the
  // by-day-of-week chart stays meaningful as the window rolls forward.
  const weekday = new Date(`${date}T12:00:00`).getDay();
  const isWeekend = weekday === 0 || weekday === 6;

  const entries: FoodEntry[] = [];
  // Entries missing micronutrients on ~30% of items, which is what makes the coverage
  // disclosure and the "Fill gaps" affordance visible in the demo.
  const sparse = () => rnd() < 0.3;

  if (rnd() > 0.15) entries.push(entryFrom(pick(BREAKFAST, rnd), rnd, sparse()));
  entries.push(entryFrom(pick(DRINK, rnd), rnd, sparse()));
  if (rnd() > 0.1) entries.push(entryFrom(pick(LUNCH, rnd), rnd, sparse()));
  entries.push(entryFrom(pick(DINNER, rnd), rnd, sparse()));

  // Short nights get an extra snack. Without this the food and metric generators are
  // independent, and "After a short night" reports pure noise as if it were a finding -
  // which in testing came out backwards (eating LESS after bad sleep) and read like a bug.
  // The demo should contain a relationship worth discovering, in the direction the
  // research actually points.
  // Threshold matches the default sleep goal, so the demo's cause lines up with the bucket
  // the chart splits on. At 7h the two disagreed for every 7-8h night and the effect washed
  // out to nothing.
  const shortNight = sleepHours !== null && sleepHours < 8;

  // Weekends used to add 1-3 snacks, which fought the sleep effect: weekends also sleep
  // longer, so the "rested" bucket was being handed the biggest days. Weekend variation now
  // comes mostly from bigger meals, leaving snacking as the short-night signal.
  const snacks = (isWeekend ? Math.floor(rnd() * 2) : Math.floor(rnd() * 2)) + (shortNight ? 2 : 0);
  for (let i = 0; i < snacks; i++) entries.push(entryFrom(pick(SNACK, rnd), rnd, sparse()));
  if (rnd() > 0.6) entries.push(entryFrom(pick(DRINK, rnd), rnd, sparse()));

  if (rnd() > 0.25) entries.push(waterEntry(Math.round((1 + rnd() * 2) * 500), rnd));

  const batch: LogBatch = {
    batch_id: `demo-b-${daysAgo}`,
    logged_at: `${date}T20:00:00.000Z`,
    transcript: transcriptFor(entries),
    entry_count: entries.length,
  };
  for (const e of entries) e.batch_id = batch.batch_id;

  return { entries, batches: [batch] };
}

/** A plausible thing the user would have said to produce these entries. */
function transcriptFor(entries: FoodEntry[]): string {
  const names = entries
    .filter((e) => e.source !== "water")
    .map((e) => e.food_name.replace(/\s*\([^)]*\)\s*$/, "").toLowerCase());
  if (names.length === 0) return "just water today";
  if (names.length === 1) return `today I had ${names[0]}`;
  return `today I had ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Weight, distance and sleep across the window.
 *
 * Correlated on purpose rather than three independent noise generators: heavier walking
 * days trend with slightly better sleep, and the weight line drifts down over the window.
 * Independent randomness would make every cross-metric chart a cloud of nothing, which
 * would demo the charts but not the point of having them.
 */
function buildMetrics(): MetricPoint[] {
  const out: MetricPoint[] = [];
  const startLb = 189;

  const push = (date: string, metric: MetricKey, value: number, unit: string, units: Record<string, number>) => {
    out.push({ date, metric, value, unit, logged_at: `${date}T07:30:00.000Z`, in: units });
  };

  for (let daysAgo = DEMO_DAYS - 1; daysAgo >= 0; daysAgo--) {
    const date = dayOffset(daysAgo);
    const rnd = mulberry32(daysAgo * 104729 + 7);
    const weekday = new Date(`${date}T12:00:00`).getDay();
    const isWeekend = weekday === 0 || weekday === 6;
    const progress = (DEMO_DAYS - 1 - daysAgo) / (DEMO_DAYS - 1);

    // Weight: about every other day, drifting down ~6 lb with day-to-day noise. The noise
    // is what makes the 7-day average line earn its place instead of looking redundant.
    if (rnd() > 0.45) {
      const lb = Math.round((startLb - progress * 6.2 + (rnd() - 0.5) * 2.4) * 10) / 10;
      push(date, "weight", lb, "lb", { lb, kg: Math.round((lb / 2.2046226218) * 100) / 100 });
    }

    // Sleep: most nights, worse on weeknights, occasionally short.
    if (rnd() > 0.12) {
      const base = isWeekend ? 8.1 : 6.9;
      const h = Math.round(Math.min(10, Math.max(3.5, base + (rnd() - 0.45) * 2.6)) * 10) / 10;
      push(date, "sleep", h, "h", { h });
      // Distance: correlated with sleep - more walking after a decent night, and more at
      // weekends. This is what gives the cross-metric charts something real to show.
      if (rnd() > 0.18) {
        const boost = h >= 7 ? 1.2 : 0.6;
        const mi = Math.round(Math.max(0.3, (isWeekend ? 3.4 : 2.2) * boost + (rnd() - 0.5) * 2.2) * 100) / 100;
        push(date, "distance", mi, "mi", { mi, km: Math.round(mi * 1.609344 * 1000) / 1000 });
      }
    }
  }
  return out;
}

export interface DemoDataset {
  days: Map<string, { entries: FoodEntry[]; batches: LogBatch[] }>;
  metrics: MetricPoint[];
}

/** Generate the whole demo world, anchored on today. Called once per page load. */
export function generateDemoData(): DemoDataset {
  // Metrics first: the food generator reads the night's sleep so that "After a short
  // night" has a real relationship to find rather than reporting noise as a finding.
  const metrics = buildMetrics();
  const sleepByDate = new Map(
    metrics.filter((m) => m.metric === "sleep").map((m) => [m.date, m.in.h ?? m.value]),
  );

  const days = new Map<string, { entries: FoodEntry[]; batches: LogBatch[] }>();
  for (let daysAgo = DEMO_DAYS - 1; daysAgo >= 0; daysAgo--) {
    const date = dayOffset(daysAgo);
    const built = buildDay(daysAgo, sleepByDate.get(date) ?? null);
    if (built) days.set(date, built);
  }
  return { days, metrics };
}

/* ── Derived shapes, matching what the server would return ─────────────────── */

export function sumDay(entries: FoodEntry[]) {
  const totals = Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, 0])) as Record<NutrientKey, number>;
  const coverage = Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, 0])) as Record<NutrientKey, number>;
  for (const e of entries) {
    for (const k of NUTRIENT_KEYS) {
      const v = e.nutrients?.[k];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      totals[k] += v;
      coverage[k] += 1;
    }
  }
  for (const k of NUTRIENT_KEYS) totals[k] = Math.round(totals[k] * 100) / 100;
  const water = entries.reduce((s, e) => s + (e.water_ml ?? 0), 0);
  return { totals, coverage, water };
}

export function toDayLog(date: string, d: { entries: FoodEntry[]; batches: LogBatch[] }): DayLog {
  const { totals, coverage, water } = sumDay(d.entries);
  return {
    schema_version: 2,
    date,
    userId: "demo",
    entries: d.entries,
    daily_totals: totals,
    daily_coverage: coverage,
    daily_water_ml: water,
    batches: d.batches,
  };
}

export function toSummary(date: string, d: { entries: FoodEntry[] }): DaySummary {
  const { totals, coverage, water } = sumDay(d.entries);
  return { date, entry_count: d.entries.length, daily_totals: totals, daily_coverage: coverage, daily_water_ml: water };
}
