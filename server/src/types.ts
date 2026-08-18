// All shared TypeScript types used across the app
// If you need to understand what data looks like at any point in the pipeline, look here

// Schema version stamped on every day log we write.
// v1 (unversioned) files are normalized to v2 on read - see store.ts normalizeDayLog()
export const SCHEMA_VERSION = 2;

// One food item as parsed from the user's raw text by Claude
// This is the "before enrichment" state - just what the user described
export interface ParsedFood {
  // Human-friendly name Claude extracted from the text (e.g. "scrambled eggs")
  name: string;
  // How much of it (e.g. 2, 0.5, 1)
  quantity: number;
  // Unit of the quantity (e.g. "large eggs", "oz", "cup", "slice", "serving")
  unit: string;
}

// The 29 nutrient field names, in one place.
// Everything else (empty objects, summing, validation, the Claude schema) derives from this,
// so adding a nutrient is a one-line change here.
export const NUTRIENT_KEYS = [
  // Macros
  "calories", "protein_g", "fat_g", "carbs_g",
  "fiber_g", "sugar_g", "saturated_fat_g",
  // Vitamins
  "vitamin_a_mcg", "vitamin_c_mg", "vitamin_d_mcg",
  "vitamin_e_mg", "vitamin_k_mcg", "vitamin_b12_mcg",
  "vitamin_b6_mg", "folate_mcg", "thiamin_mg",
  "riboflavin_mg", "niacin_mg",
  // Minerals
  "calcium_mg", "iron_mg", "magnesium_mg",
  "potassium_mg", "sodium_mg", "zinc_mg",
  "selenium_mcg", "phosphorus_mg",
  // Extras worth tracking
  "cholesterol_mg", "caffeine_mg", "alcohol_g",
] as const;

export type NutrientKey = (typeof NUTRIENT_KEYS)[number];

// The four macros we always require an estimate for - Claude can always ballpark these.
// Everything else is allowed to come back unknown.
export const CORE_NUTRIENT_KEYS: NutrientKey[] = ["calories", "protein_g", "fat_g", "carbs_g"];

// Full nutrient profile for one food item, per the serving described.
//
// null means UNKNOWN - Claude had no basis for an estimate.
// 0 means the food genuinely contains none of it.
// These are different, and conflating them is what made every micronutrient chart lie:
// summing "unknown" as zero biased every daily total downward by an unstable amount.
export type Nutrients = { [K in NutrientKey]: number | null };

// Daily totals are always concrete numbers - they're the sum of whatever was known.
// Read them alongside DayLog.daily_coverage to know how much of the day actually contributed.
export type NutrientTotals = { [K in NutrientKey]: number };

// How many entries contributed a known (non-null) value to each daily total.
// Lets the UI say "potassium: 1,240 mg (from 6 of 9 items)" instead of implying false precision.
export type NutrientCoverage = { [K in NutrientKey]: number };

// Where a food entry's nutrient data came from.
//
//   claude_estimate - Claude estimated it from its own knowledge
//   grounded        - Claude read published nutrition facts for this exact product
//   pantry          - scaled from a stored reference the user has already verified
//   manual          - the user typed the numbers in; no model was involved
//   water           - plain water bypass, the one case where 29 zeros are genuinely true
//
// "gpt_estimate" and "usda" are legacy sources from earlier versions of this app -
// 24 of the 226 historical entries carry them, so the union has to admit them.
//
// This distinction is load-bearing for measurement, not decoration: without it there is
// no way to ask "how accurate is the estimator" separately from "how accurate are the
// numbers on disk", because hand-typed values and model output look identical.
export type EntrySource =
  | "claude_estimate"
  | "grounded"
  | "pantry"
  | "manual"
  | "water"
  | "gpt_estimate"
  | "usda";

/** Where a gram figure came from. Only a real label makes energy density checkable. */
export type GramsBasis = "label_serving" | "typical_portion" | "guess" | "none";

/** How an item's numbers were arrived at, in increasing order of trust. */
export type EstimateBasis = "model_estimate" | "reference_database" | "published_label";

/**
 * Everything we know about HOW an entry's numbers were produced, as opposed to what they
 * are. Kept as one nested object rather than a dozen top-level fields for a specific
 * reason: `normalizeDayLog` rebuilds every entry from an explicit field whitelist, and it
 * runs on every DELETE and PUT. A new top-level field that nobody added to that list is
 * silently erased from the whole day the next time any entry in it is touched. One
 * whitelist entry for this object means anything added here survives automatically.
 */
export interface EstimateMeta {
  /** Brand, chain or manufacturer as it markets itself. */
  brand?: string;
  /** Total edible mass of the serving described, in grams. */
  grams?: number;
  grams_basis?: GramsBasis;
  basis?: EstimateBasis;
  /** How tightly the model would bet on the calorie figure. */
  confidence?: "high" | "medium" | "low";
  /** A conversion or judgement the user should check, in one sentence. */
  assumptions?: string;
  /** Set when the numbers were read off a published source. */
  source_url?: string;
  source_title?: string;
  /** Set when the numbers were scaled from a stored pantry reference. */
  pantry_key?: string;
  /** Arithmetic contradictions found by verify.ts at write time, if any. */
  violations?: string[];
}

// A single food entry ready to be saved - parsed food + its nutrient data
export interface FoodEntry {
  // Unique ID for this entry (so you can delete/edit individual items later)
  id: string;
  // The human name as Claude understood it (e.g. "Scrambled eggs (2 large)")
  food_name: string;
  // How the serving was described (e.g. "2 large eggs", "1 bowl", "6 oz")
  serving_description: string;
  // Where the nutrient data came from
  source: EntrySource;
  // Full nutrient profile for this serving (null = unknown, 0 = contains none)
  nutrients: Nutrients;
  // Volume of water in milliliters - only set for water entries, used for hydration totals
  water_ml?: number;
  // Which batch (utterance) produced this entry - links back to DayLog.batches
  batch_id?: string;
  // When this entry was logged, ISO instant. Only set on entries written by schema v2+.
  logged_at?: string;
  // The structured parse that produced this entry, kept so re-estimating an entry
  // doesn't have to reverse-engineer quantity/unit out of the display string
  parsed?: ParsedFood;
  // How these numbers were produced. See EstimateMeta.
  estimate?: EstimateMeta;
  // Legacy provenance from the retired USDA FoodData Central lookup
  provenance?: { fdc_id?: number; fdc_description?: string };
}

// One submission - the raw text the user spoke or typed, and what it produced.
// Stored so the UI can show "you said X, we logged Y" and you can judge whether to re-record.
export interface LogBatch {
  batch_id: string;
  // ISO instant this batch was confirmed
  logged_at: string;
  // The exact text that was sent to Claude
  transcript: string;
  // How many entries this batch produced
  entry_count: number;
}

// The full contents of one daily food log file (e.g. data/users/billy/food/2026-04-12.json)
export interface DayLog {
  // Which schema generation wrote this file
  schema_version: number;
  // The date this log is for, YYYY-MM-DD format
  date: string;
  // The user this log belongs to
  userId: string;
  // All the individual food entries logged for this day
  entries: FoodEntry[];
  // Pre-computed daily totals so you don't have to sum manually when reading the file
  daily_totals: NutrientTotals;
  // How many entries contributed a known value to each total (see NutrientCoverage)
  daily_coverage: NutrientCoverage;
  // Total water for the day in ml - daily_totals can't carry this, it isn't a nutrient
  daily_water_ml: number;
  // The submissions that built this day, oldest first
  batches: LogBatch[];
}

// One day's worth of summary data, for range queries that power the history charts.
// Deliberately omits `entries` - a 90-day chart doesn't need 700 food items.
export interface DaySummary {
  date: string;
  entry_count: number;
  daily_totals: NutrientTotals;
  daily_coverage: NutrientCoverage;
  daily_water_ml: number;
}

// Daily targets. Every reference line on every chart is drawn from these.
//
// These live on the server rather than in the browser so the phone and the desktop draw
// the same lines from the same data. When they were in localStorage, logging on one device
// and reviewing on the other silently compared your intake against two different goals.
export interface Goals {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  // The two below are upper limits you want to stay under, not targets to reach.
  sodium_mg: number;
  sugar_g: number;
  water_ml: number;
  // Optional targets. Blank means "track it, don't aim at a number".
  weight_target?: number;
  distance_target?: number;
  sleep_target?: number;
  // Display units. Storage keeps whatever was entered; these are display only.
  weight_unit: WeightUnit;
  distance_unit: "mi" | "km";
}

// Numeric goals that share the same validation. weight_unit is handled separately
// because it is an enum, not a positive number.
export const GOAL_KEYS: Array<keyof Goals> = [
  "calories", "protein_g", "carbs_g", "fat_g", "sodium_mg", "sugar_g", "water_ml",
  "weight_target", "distance_target", "sleep_target",
];

/**
 * The goals that are allowed to have no value at all.
 *
 * "Track it, don't aim at a number" is a real state for weight, distance and sleep, so
 * these can be cleared by sending null. The rest are required: a calorie goal of nothing
 * makes every progress ring divide by zero, so blanking one means "leave it unchanged".
 */
export const OPTIONAL_GOAL_KEYS: Array<keyof Goals> = [
  "weight_target", "distance_target", "sleep_target",
];

// 2300 mg sodium and 36 g added sugar are the standard adult daily upper limits
// (FDA and AHA respectively); the rest are ordinary starting points to edit.
export const DEFAULT_GOALS: Goals = {
  calories: 2200,
  protein_g: 150,
  carbs_g: 220,
  fat_g: 70,
  sodium_mg: 2300,
  sugar_g: 36,
  water_ml: 3000,
  sleep_target: 8,
  distance_target: 3,
  weight_unit: "lb",
  distance_unit: "mi",
};

// ── Daily metrics ──────────────────────────────────────────────────────────
//
// Weight, distance walked, sleep - one scalar per day each, entered by hand.
//
// Generalised rather than three parallel implementations, because the list is obviously
// going to grow (steps, resting heart rate, whatever the watch shows next) and each new
// one should be a row in this table, not another file + endpoints + card + chart.
export type MetricKey = "weight" | "distance" | "sleep";

export const METRIC_KEYS: MetricKey[] = ["weight", "distance", "sleep"];

export interface MetricDef {
  label: string;
  /** Units the value may be entered in. First is the default. */
  units: string[];
  /** Plausibility ceiling per unit - catches a slipped decimal, not health advice. */
  max: Record<string, number>;
  decimals: number;
  /** Which way is "good", for colouring a chart against its target. */
  better: "higher" | "lower";
  /** Optional goal field in Goals, if this metric has a target. */
  goalKey?: "weight_target" | "distance_target" | "sleep_target";
  /** Optional unit-preference field in Goals. Metrics with one unit don't need one. */
  unitKey?: "weight_unit" | "distance_unit";
  hint: string;
}

export const METRICS: Record<MetricKey, MetricDef> = {
  weight: {
    label: "Weight", units: ["lb", "kg"], max: { lb: 1000, kg: 454 }, decimals: 1,
    better: "lower", goalKey: "weight_target", unitKey: "weight_unit",
    hint: "e.g. 181.4",
  },
  distance: {
    label: "Distance walked", units: ["mi", "km"], max: { mi: 200, km: 320 }, decimals: 2,
    better: "higher", goalKey: "distance_target", unitKey: "distance_unit",
    hint: "e.g. 3.4",
  },
  sleep: {
    // Hours only. Nobody enters sleep in minutes, and offering both invites "7" meaning
    // seven minutes.
    label: "Sleep", units: ["h"], max: { h: 24 }, decimals: 1,
    better: "higher", goalKey: "sleep_target",
    hint: "e.g. 7.5",
  },
};

// One reading. Stored exactly as entered, with its unit, rather than converted to a
// canonical unit on the way in - a round trip through kg and back would quietly turn 180.4 lb
// into 180.38. The server computes both representations on read so the client never converts.
export interface MetricReading {
  value: number;
  unit: string;
  logged_at: string;
}

/** Everything recorded for one date. Any subset of the metrics may be present. */
export type DayMetrics = Partial<Record<MetricKey, MetricReading>>;

/** A reading as served to clients: the original, plus every unit precomputed. */
export interface MetricPoint extends MetricReading {
  date: string;
  metric: MetricKey;
  /** value converted into each supported unit, so the client never converts. */
  in: Record<string, number>;
}

export type WeightUnit = "lb" | "kg";

export const LB_PER_KG_CONST = 2.2046226218;
export const KM_PER_MI = 1.609344;

/** Convert a reading into every unit its metric supports. */
export function convertMetric(metric: MetricKey, value: number, unit: string): Record<string, number> {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  if (metric === "weight") {
    const kg = unit === "kg" ? value : value / LB_PER_KG_CONST;
    return { kg: round(kg), lb: round(kg * LB_PER_KG_CONST) };
  }
  if (metric === "distance") {
    const km = unit === "km" ? value : value * KM_PER_MI;
    return { km: round(km), mi: round(km / KM_PER_MI) };
  }
  return { h: round(value) };
}


// A pending log session - created after parsing/enriching, waiting for user confirmation
// Lives in memory only, never written to disk
export interface PendingSession {
  // Unique session ID sent back to the client so they can confirm later
  sessionId: string;
  // The user this session belongs to
  userId: string;
  // The date these entries will be logged to
  date: string;
  // The enriched entries ready to save once confirmed
  entries: FoodEntry[];
  // The raw text that produced these entries
  transcript: string;
  // Whether confirming should replace the whole day rather than append to it
  overwrite: boolean;
  // When this session was created - used to expire stale sessions
  createdAt: Date;
}

// What the HTTP server sends back after POST /log (before confirmation)
export interface LogPreviewResponse {
  // The session ID the client must send back to confirm
  sessionId: string;
  // The date entries will be logged to
  date: string;
  // The text we parsed, echoed back so the UI can show "you said ..."
  transcript: string;
  // The entries the user is about to confirm
  entries: FoodEntry[];
  // Total calories and key macros as a quick summary
  summary: {
    totalCalories: number;
    totalProtein_g: number;
    totalFat_g: number;
    totalCarbs_g: number;
  };
  // What's already logged for this day, so the UI can warn before appending
  existingEntries: number;
  existingCalories: number;
  /**
   * What this log cost in Anthropic API spend, in USD.
   *
   * Reported per log rather than only in aggregate because the range is wide and the
   * reason is invisible: a food already in your library is a single parse call, while a
   * new branded item adds a published-label lookup that can cost twenty times as much.
   * Seeing the figure attached to the log that caused it is what makes that legible.
   */
  cost?: LogCostSummary;
}

export interface LogCostSummary {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  /** Per-call breakdown, so an expensive log can be explained rather than just reported. */
  calls: Array<{ method: string; usd: number; inputTokens: number; outputTokens: number; webSearches: number }>;
}

// What the HTTP server sends back after POST /confirm/:sessionId
export interface ConfirmResponse {
  success: boolean;
  message: string;
  // The day log as it stands after saving, so the client doesn't need a follow-up GET
  log: DayLog;
}
