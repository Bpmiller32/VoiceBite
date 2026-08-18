// Mirrors the server's types.ts. Keep the two in sync when the schema changes.
//
// The one thing to internalize: a nutrient value of `null` means UNKNOWN - Claude had
// no basis for an estimate - while `0` means the food genuinely contains none.
// Never render a null as 0, and never sum it as 0. Show "—" or "unknown" instead.

export const NUTRIENT_KEYS = [
  "calories", "protein_g", "fat_g", "carbs_g",
  "fiber_g", "sugar_g", "saturated_fat_g",
  "vitamin_a_mcg", "vitamin_c_mg", "vitamin_d_mcg",
  "vitamin_e_mg", "vitamin_k_mcg", "vitamin_b12_mcg",
  "vitamin_b6_mg", "folate_mcg", "thiamin_mg",
  "riboflavin_mg", "niacin_mg",
  "calcium_mg", "iron_mg", "magnesium_mg",
  "potassium_mg", "sodium_mg", "zinc_mg",
  "selenium_mcg", "phosphorus_mg",
  "cholesterol_mg", "caffeine_mg", "alcohol_g",
] as const;

export type NutrientKey = (typeof NUTRIENT_KEYS)[number];

/** Per-entry nutrients. null = unknown, 0 = contains none. */
export type Nutrients = { [K in NutrientKey]: number | null };
/** Daily sums. Always concrete - they're the sum of whatever was known. */
export type NutrientTotals = { [K in NutrientKey]: number };
/** How many entries contributed a known value to each total. */
export type NutrientCoverage = { [K in NutrientKey]: number };

export type EntrySource =
  | "claude_estimate"
  | "grounded"
  | "pantry"
  | "manual"
  | "water"
  | "gpt_estimate"
  | "usda";

export interface ParsedFood {
  name: string;
  quantity: number;
  unit: string;
}

export interface FoodEntry {
  id: string;
  food_name: string;
  serving_description: string;
  source: EntrySource;
  nutrients: Nutrients;
  water_ml?: number;
  batch_id?: string;
  logged_at?: string;
  parsed?: ParsedFood;
  /**
   * How these numbers were produced, as opposed to what they are.
   *
   * This is what turns the confirm screen from a list of numbers into something you can
   * actually judge: whether a figure was read off a manufacturer's label, copied from a
   * third-party database, scaled from something you verified earlier, or reasoned out -
   * and what the model assumed to get there.
   */
  estimate?: EstimateMeta;
  provenance?: { fdc_id?: number; fdc_description?: string };
}

export type GramsBasis = "label_serving" | "typical_portion" | "guess" | "none";
export type EstimateBasis = "model_estimate" | "reference_database" | "published_label";

export interface EstimateMeta {
  brand?: string;
  grams?: number;
  grams_basis?: GramsBasis;
  basis?: EstimateBasis;
  confidence?: "high" | "medium" | "low";
  /** A conversion or judgement worth checking, in one sentence. */
  assumptions?: string;
  source_url?: string;
  source_title?: string;
  pantry_key?: string;
  /** Arithmetic contradictions found at write time. */
  violations?: string[];
}

/** One submission: the raw text and what it produced. Powers "you said X, we logged Y". */
export interface LogBatch {
  batch_id: string;
  logged_at: string;
  transcript: string;
  entry_count: number;
}

export interface DayLog {
  schema_version: number;
  date: string;
  userId: string;
  entries: FoodEntry[];
  daily_totals: NutrientTotals;
  daily_coverage: NutrientCoverage;
  daily_water_ml: number;
  batches: LogBatch[];
}

/** One day in a range query. No `entries` - a 90-day chart doesn't need 700 food items. */
export interface DaySummary {
  date: string;
  entry_count: number;
  daily_totals: NutrientTotals;
  daily_coverage: NutrientCoverage;
  daily_water_ml: number;
}

export interface LogPreview {
  sessionId: string;
  date: string;
  transcript: string;
  entries: FoodEntry[];
  summary: {
    totalCalories: number;
    totalProtein_g: number;
    totalFat_g: number;
    totalCarbs_g: number;
  };
  existingEntries: number;
  existingCalories: number;
  /** What this log cost in Anthropic API spend. Absent on older server builds. */
  cost?: LogCostSummary;
}

export interface LogCostSummary {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  calls: Array<{ method: string; usd: number; inputTokens: number; outputTokens: number; webSearches: number }>;
}

export interface ConfirmResult {
  success: boolean;
  message: string;
  log: DayLog;
}

export type WeightUnit = "lb" | "kg";
export type MetricKey = "weight" | "distance" | "sleep";

export const METRIC_KEYS: MetricKey[] = ["weight", "distance", "sleep"];

export interface MetricDef {
  label: string;
  short: string;
  units: string[];
  max: Record<string, number>;
  decimals: number;
  better: "higher" | "lower";
  goalKey?: "weight_target" | "distance_target" | "sleep_target";
  unitKey?: "weight_unit" | "distance_unit";
  hint: string;
}

/** Mirrors the server's METRICS. Adding a metric is a row here and a row there. */
export const METRICS: Record<MetricKey, MetricDef> = {
  weight: {
    label: "Weight", short: "Weight", units: ["lb", "kg"], max: { lb: 1000, kg: 454 },
    decimals: 1, better: "lower", goalKey: "weight_target", unitKey: "weight_unit", hint: "181.4",
  },
  distance: {
    label: "Distance walked", short: "Distance", units: ["mi", "km"], max: { mi: 200, km: 320 },
    decimals: 2, better: "higher", goalKey: "distance_target", unitKey: "distance_unit", hint: "3.4",
  },
  sleep: {
    label: "Sleep", short: "Sleep", units: ["h"], max: { h: 24 },
    decimals: 1, better: "higher", goalKey: "sleep_target", hint: "7.5",
  },
};

/** A reading. The server sends every unit precomputed so the client never converts. */
export interface MetricPoint {
  date: string;
  metric: MetricKey;
  value: number;
  unit: string;
  logged_at: string;
  in: Record<string, number>;
}

/** The unit a metric should be displayed in, per the user's goals. */
export function displayUnit(metric: MetricKey, goals: Goals): string {
  const def = METRICS[metric];
  if (!def.unitKey) return def.units[0];
  return (goals[def.unitKey] as string) ?? def.units[0];
}

/** A reading's value in the unit we're displaying. */
export function metricValue(p: MetricPoint, goals: Goals): number {
  return p.in[displayUnit(p.metric, goals)] ?? p.value;
}

/** Targets the charts draw reference lines against. Stored on the Pi; see goals.ts. */
export interface Goals {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  sodium_mg: number;
  sugar_g: number;
  water_ml: number;
  /** Optional targets. Blank means "track it, don't aim at a number". */
  // Optional targets: "track it, don't aim at a number".
  //
  // `null` is meaningful on the way OUT - it is how the client says "clear this goal", as
  // distinct from omitting the field, which means "leave it unchanged". The server only
  // ever sends a number or omits the key, so readers should use `?? fallback`, which
  // handles both.
  weight_target?: number | null;
  distance_target?: number | null;
  sleep_target?: number | null;
  /** Display units. Storage keeps whatever was entered. */
  weight_unit: WeightUnit;
  distance_unit: "mi" | "km";
}

export const DEFAULT_GOALS: Goals = {
  calories: 2200,
  protein_g: 150,
  carbs_g: 220,
  fat_g: 70,
  // The two thresholds below are the standard daily upper limits rather than targets:
  // 2300 mg sodium and 36 g added sugar (FDA / AHA for adult men).
  sodium_mg: 2300,
  sugar_g: 36,
  water_ml: 3000,
  sleep_target: 8,
  distance_target: 3,
  weight_unit: "lb",
  distance_unit: "mi",
};

/** Display metadata for each nutrient - label, unit, and how many decimals to show. */
export const NUTRIENT_META: Record<NutrientKey, { label: string; unit: string; decimals: number }> = {
  calories: { label: "Calories", unit: "kcal", decimals: 0 },
  protein_g: { label: "Protein", unit: "g", decimals: 0 },
  fat_g: { label: "Fat", unit: "g", decimals: 0 },
  carbs_g: { label: "Carbs", unit: "g", decimals: 0 },
  fiber_g: { label: "Fiber", unit: "g", decimals: 0 },
  sugar_g: { label: "Sugar", unit: "g", decimals: 0 },
  saturated_fat_g: { label: "Saturated fat", unit: "g", decimals: 1 },
  vitamin_a_mcg: { label: "Vitamin A", unit: "mcg", decimals: 0 },
  vitamin_c_mg: { label: "Vitamin C", unit: "mg", decimals: 0 },
  vitamin_d_mcg: { label: "Vitamin D", unit: "mcg", decimals: 1 },
  vitamin_e_mg: { label: "Vitamin E", unit: "mg", decimals: 1 },
  vitamin_k_mcg: { label: "Vitamin K", unit: "mcg", decimals: 0 },
  vitamin_b12_mcg: { label: "Vitamin B12", unit: "mcg", decimals: 1 },
  vitamin_b6_mg: { label: "Vitamin B6", unit: "mg", decimals: 1 },
  folate_mcg: { label: "Folate", unit: "mcg", decimals: 0 },
  thiamin_mg: { label: "Thiamin", unit: "mg", decimals: 2 },
  riboflavin_mg: { label: "Riboflavin", unit: "mg", decimals: 2 },
  niacin_mg: { label: "Niacin", unit: "mg", decimals: 1 },
  calcium_mg: { label: "Calcium", unit: "mg", decimals: 0 },
  iron_mg: { label: "Iron", unit: "mg", decimals: 1 },
  magnesium_mg: { label: "Magnesium", unit: "mg", decimals: 0 },
  potassium_mg: { label: "Potassium", unit: "mg", decimals: 0 },
  sodium_mg: { label: "Sodium", unit: "mg", decimals: 0 },
  zinc_mg: { label: "Zinc", unit: "mg", decimals: 1 },
  selenium_mcg: { label: "Selenium", unit: "mcg", decimals: 0 },
  phosphorus_mg: { label: "Phosphorus", unit: "mg", decimals: 0 },
  cholesterol_mg: { label: "Cholesterol", unit: "mg", decimals: 0 },
  caffeine_mg: { label: "Caffeine", unit: "mg", decimals: 0 },
  alcohol_g: { label: "Alcohol", unit: "g", decimals: 1 },
};

/** Reference daily intakes, used to show micronutrients as a share of a day's needs. */
export const RDA: Partial<Record<NutrientKey, number>> = {
  fiber_g: 38, vitamin_a_mcg: 900, vitamin_c_mg: 90, vitamin_d_mcg: 20,
  vitamin_e_mg: 15, vitamin_k_mcg: 120, vitamin_b12_mcg: 2.4, vitamin_b6_mg: 1.7,
  folate_mcg: 400, thiamin_mg: 1.2, riboflavin_mg: 1.3, niacin_mg: 16,
  calcium_mg: 1000, iron_mg: 8, magnesium_mg: 420, potassium_mg: 3400,
  zinc_mg: 11, selenium_mcg: 55, phosphorus_mg: 700,
};

/** Format a possibly-unknown value. Renders null as an em dash, never as 0. */
export function fmt(value: number | null | undefined, key?: NutrientKey): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const decimals = key ? NUTRIENT_META[key].decimals : 0;
  return value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
