// enricher.ts
// Takes raw food text and produces full nutrient profiles in a single Claude call
//
// Strategy:
//   1. Send the raw text to Claude with a JSON schema it is *constrained* to satisfy
//   2. Claude returns each food item with name, quantity, unit, and whatever nutrients it knows
//   3. Anything Claude omits comes back as null (unknown) rather than 0 (contains none)
//
// Two things here are deliberate and load-bearing:
//
// - Structured outputs (output_config.format) instead of "please reply with JSON".
//   The old version asked for raw JSON in the prompt and scraped it back out with
//   /\{[\s\S]*\}/. That regex is greedy, so a response truncated mid-array still matched -
//   it grabbed through the last surviving brace and handed JSON.parse a malformed string,
//   throwing away the user's entire dictation with a 500. The API now guarantees the shape.
//
// - Omitted nutrient == unknown. The old prompt said "use 0 if truly unknown", so
//   "I don't know the potassium" and "this contains no potassium" were stored identically
//   and summed identically. Across the existing corpus that made 45.8% of micronutrient
//   fields read as hard zeros, which is why every RDA chart showed fake deficiencies.

import Anthropic from "@anthropic-ai/sdk";
import pino from "pino";
import {
  ParsedFood, FoodEntry, Nutrients, NutrientTotals, NutrientCoverage,
  NUTRIENT_KEYS, CORE_NUTRIENT_KEYS, EstimateMeta, GramsBasis,
} from "./types";
import { getLogger } from "./logger";
import { checkItem } from "./verify";
import {
  readPantry, selectCandidates, renderPantryTable, scaleReference, upsertItem, pantryKey,
  recordMiss, isRecentMiss, type Pantry,
} from "./pantry";
import {
  resolveOne, resolveAll, enrichMicronutrients, lastLookupFailureWasTransient,
  COMPOSITION_ONLY_KEYS,
} from "./resolver";
import { CostMeter } from "./cost";

// Everything below is read LAZILY, on first use, never at module scope.
//
// This is not a style preference. Module bodies run during the import phase, which is
// before the importing file's own top-level statements - so a `const MODEL = process.env...`
// here would evaluate before server.ts got around to loading .env, and would silently read
// the shell environment instead. That is exactly how a stale shell ANTHROPIC_API_KEY ended
// up shadowing the correct key in .env and 401-ing every request. See src/env.ts.

// Which Claude model to use - set CLAUDE_MODEL in .env to override.
// Opus 5 supports structured outputs (Sonnet 4.6 does not), which is what lets us
// delete the regex-scraping failure mode described above.
const model = () => process.env.CLAUDE_MODEL || "claude-opus-5";

// How hard Claude should think per request. Lower = faster and cheaper, higher = more accurate.
// "medium" is a good balance for portion reasoning; drop to "low" if latency bothers you.
const effort = () => (process.env.CLAUDE_EFFORT || "medium") as "low" | "medium" | "high" | "xhigh" | "max";

// Generous ceiling on generated tokens. This is NOT a timeout and NOT a spend cap -
// you are only billed for tokens actually produced, so a high value costs nothing
// unless the response genuinely needs the room. The old value of 4096 was a hard
// truncation cliff at ~12 food items, which a spoken "everything I ate today" hits easily.
const maxTokens = () => parseInt(process.env.CLAUDE_MAX_TOKENS || "32000");

// Whether to read published nutrition facts for branded items rather than recall them.
// Set VOICEBITE_GROUNDING=off to fall back to pure estimation - useful for measuring what
// grounding is actually buying, and as an escape hatch if the web tools misbehave.
const groundingEnabled = () => (process.env.VOICEBITE_GROUNDING || "on").toLowerCase() !== "off";

// Wall-clock ceiling for one POST /log, measured from the moment the parse call starts.
//
// This is a HARD INFRASTRUCTURE LIMIT, not a comfort setting. The Cloudflare Tunnel
// (~/.cloudflared/config.yml, no originRequest block) applies a ~100s origin timeout, and
// a 524 reaches the user as "Can't reach the server. Is the Pi online?" - a badly wrong
// message for a Pi that is working perfectly and merely reading a nutrition label.
//
// 80s leaves headroom for the response to serialize and travel back inside that window.
// To go higher you would have to add an `originRequest: { connectTimeout, ... }` block to
// the tunnel config - which restarts cloudflared and therefore every other service on this
// Pi, so it is not something to do casually.
const totalBudgetMs = () => parseInt(process.env.VOICEBITE_BUDGET_MS || "80000");

// Effort for a grounding lookup. Lower than the parse effort on purpose - see the note on
// ResolveOptions.effort. Overridable so the harness can sweep it.
const lookupEffort = () =>
  (process.env.CLAUDE_LOOKUP_EFFORT || "medium") as "low" | "medium" | "high" | "xhigh" | "max";

// Whether to run the composition pass that fills in the micronutrients no label prints.
// Set VOICEBITE_MICRO_PASS=off to measure what it is actually contributing.
const microPassEnabled = () => (process.env.VOICEBITE_MICRO_PASS || "on").toLowerCase() !== "off";

// Built on first use and cached, so we still get connection reuse across requests without
// reading the API key before .env has been loaded.
let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    // Requests are streamed because non-streaming calls with a large max_tokens risk
    // hitting the SDK's HTTP timeout before the response completes.
    _client = new Anthropic({ maxRetries: 3, timeout: 10 * 60 * 1000 });
  }
  return _client;
}

// A nutrients object where every field is unknown.
// This is the correct starting point for a Claude estimate - fields Claude doesn't
// mention stay unknown rather than silently becoming zero.
export function emptyNutrients(): Nutrients {
  return Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, null])) as Nutrients;
}

// A nutrients object where every field is a genuine zero. Only correct for plain water,
// which really does contain none of any of these.
export function zeroNutrients(): Nutrients {
  return Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, 0])) as Nutrients;
}

// Coerce arbitrary input into a valid Nutrients object.
//
// Everything that reaches disk goes through here. Without it, a single bad value
// poisons a whole day permanently: `Math.round((0 + undefined) * 100) / 100` is NaN,
// JSON.stringify writes NaN as null, and totals recompute from the same bad entry on
// every subsequent write, so the day never heals itself.
export function sanitizeNutrients(input: unknown, log?: pino.Logger): Nutrients {
  const out = emptyNutrients();
  if (!input || typeof input !== "object") return out;
  const raw = input as Record<string, unknown>;

  for (const key of NUTRIENT_KEYS) {
    const v = raw[key];
    // Absent or explicitly null means unknown - leave it as null.
    if (v === undefined || v === null || v === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    // NaN, Infinity and negative amounts are all nonsense for a nutrient. Treat as unknown.
    if (!Number.isFinite(n) || n < 0) {
      // Log it. Now that omission is the normal way to say "unknown", a laundered bad
      // value is indistinguishable from a deliberate omission, so a systematic problem
      // upstream would show up only as an unexplained dip in coverage.
      log?.warn({ key, value: v }, "rejected implausible nutrient value - recording as unknown");
      continue;
    }
    out[key] = n;
  }
  return out;
}

// Sum an array of entries into daily totals, plus a per-field count of how many
// entries actually contributed a known value.
//
// Nulls are skipped, not counted as zero. The coverage numbers are what let the UI
// say "potassium: 1,240 mg (from 6 of 9 items)" rather than implying the total is complete.
export function sumNutrients(entries: FoodEntry[]): {
  totals: NutrientTotals;
  coverage: NutrientCoverage;
} {
  const totals = Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, 0])) as NutrientTotals;
  const coverage = Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, 0])) as NutrientCoverage;

  for (const entry of entries) {
    const n = entry.nutrients || ({} as Nutrients);
    // Water's 29 zeros are structural, not measurements. They belong in `totals` - adding
    // zero is harmless and keeps the sum honest - but they must not raise `coverage`,
    // which the UI reads as "this many items were actually estimated for this nutrient".
    //
    // Without this, a day with two glasses of water and no other magnesium data renders
    // "Magnesium 0 mg - 2 of 9 items" as though two foods had been measured and found to
    // contain none, and the RDA chart averages it in as a genuine 0 mg day. That is
    // exactly the fake-deficiency failure the null-vs-zero contract exists to prevent,
    // reintroduced one level up. Measured on 2026-08-09: 11 nutrients had coverage 2
    // where both contributors were the water rows.
    const isWater = entry.source === "water";
    for (const key of NUTRIENT_KEYS) {
      const v = n[key];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      totals[key] += v;
      if (!isWater) coverage[key] += 1;
    }
  }

  // Round once at the end rather than inside the loop, so sub-cent values don't vanish
  // mid-accumulation (five doses of 0.004 mg should be 0.02, not 0).
  for (const key of NUTRIENT_KEYS) {
    totals[key] = Math.round(totals[key] * 100) / 100;
  }
  return { totals, coverage };
}

// Total hydration for a set of entries, in ml.
// This can't live in daily_totals because water isn't one of the 29 nutrients.
export function sumWaterMl(entries: FoodEntry[]): number {
  return entries.reduce(
    (sum, e) => sum + (Number.isFinite(e.water_ml as number) ? (e.water_ml as number) : 0),
    0,
  );
}

// The JSON schema Claude's response is constrained to satisfy.
//
// Only the four macros are required. Every micronutrient is optional, and omitting one
// is how Claude says "I don't know" - which is both more honest than guessing zero and
// noticeably cheaper, since the old prompt made every item carry all 29 fields whether
// Claude had a basis for them or not.
// The nutrients that aren't the four required macros.
const MICRO_NUTRIENT_KEYS = NUTRIENT_KEYS.filter((k) => !CORE_NUTRIENT_KEYS.includes(k));

// Macros as four required fields, micronutrients as a key/value list.
//
// The obvious shape - one optional property per nutrient - is rejected by the API:
// "Schemas contains too many optional parameters (25), limit: 24". Twenty-nine nutrients
// minus four required macros is exactly 25, one over.
//
// The list form sidesteps the limit entirely (it has NO optional properties at all) and
// happens to express the semantics better: a nutrient is present because Claude had a
// number for it, and absent because it did not. There is no field sitting there daring
// the model to put a zero in it.
const MICRO_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["key", "value"],
  properties: {
    key: { type: "string", enum: MICRO_NUTRIENT_KEYS },
    value: { type: "number", description: "Amount for the serving described, in the unit named by the key." },
  },
};

// Written out rather than generated. The generated version rendered as
// "calories for the serving described." and "carbs_g for the serving described." - the
// field name restated, carrying no information the model didn't already have. The one
// that matters is carbs: total carbohydrate INCLUDING fiber is the US label convention,
// and getting that wrong shifts every Atwater check by 4 kcal per gram of fiber.
const MACRO_DESCRIPTIONS: Record<string, string> = {
  calories: "Total energy for the serving described, in kcal.",
  protein_g: "Grams of protein for the serving described.",
  fat_g: "Grams of total fat for the serving described.",
  carbs_g: "Grams of total carbohydrate, INCLUDING fiber, for the serving described.",
};

const MACROS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: CORE_NUTRIENT_KEYS,
  properties: Object.fromEntries(
    CORE_NUTRIENT_KEYS.map((k) => [k, { type: "number", description: MACRO_DESCRIPTIONS[k] }]),
  ),
};

// Fold the response's macros + micronutrient list back into a flat Nutrients object.
// Anything Claude left out of the list stays null, which is what "unknown" means here.
function nutrientsFromResponse(macros: unknown, micros: unknown, log?: pino.Logger): Nutrients {
  const flat: Record<string, unknown> = { ...(macros as Record<string, unknown> ?? {}) };
  if (Array.isArray(micros)) {
    for (const m of micros) {
      if (!m || typeof m.key !== "string") continue;
      // A repeated key means the model expressed two different beliefs about one
      // nutrient. Last-write-wins silently discards one of them; that disagreement is
      // exactly the signal worth knowing about, so say so rather than swallowing it.
      if (Object.prototype.hasOwnProperty.call(flat, m.key) && flat[m.key] !== m.value) {
        log?.warn({ key: m.key, kept: m.value, discarded: flat[m.key] },
          "model returned the same nutrient twice with different values");
      }
      flat[m.key] = m.value;
    }
  }
  return sanitizeNutrients(flat, log);
}

/** One item exactly as the response schema defines it. Every field is present. */
interface ParsedItem {
  name: string;
  brand: string;
  quantity: number;
  unit: string;
  spoken_portion: string;
  grams: number;
  grams_basis: GramsBasis;
  stated_calories: number;
  water_ml: number;
  is_plain_water: boolean;
  route: "pantry" | "lookup" | "estimate";
  pantry_key: string;
  servings: number;
  confidence: "high" | "medium" | "low";
  assumptions: string;
  macros: unknown;
  micronutrients: unknown;
}

/** A finite number above zero, or undefined. The sentinel for every "not applicable" is 0. */
function positive(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Non-empty trimmed string, or undefined. The sentinel for "not applicable" is "". */
function text(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 ? s : undefined;
}

/**
 * Fold an item's provenance fields into the stored EstimateMeta.
 *
 * Sentinels are dropped rather than stored: `grams: 0` means "no basis", and writing it as
 * a real zero would be the same unknown-as-zero mistake the nutrient contract exists to
 * prevent - just one level up.
 */
function buildEstimateMeta(item: ParsedItem): EstimateMeta {
  const meta: EstimateMeta = { basis: "model_estimate" };
  const brand = text(item.brand);
  const grams = positive(item.grams);
  const assumptions = text(item.assumptions);

  if (brand) meta.brand = brand;
  if (grams) meta.grams = grams;
  // Only meaningful alongside an actual gram figure.
  if (grams && item.grams_basis) meta.grams_basis = item.grams_basis;
  if (item.confidence) meta.confidence = item.confidence;
  if (assumptions) meta.assumptions = assumptions;
  return meta;
}

/**
 * Turn a `route: "pantry"` item into stored-and-scaled nutrients.
 *
 * Returns null - falling back to the model's own estimate - whenever anything about the
 * match is not solid: no pantry, an unknown key, or a serving count that makes no sense.
 * A wrong pantry hit is worse than no pantry hit, because it silently substitutes a
 * different food's numbers while looking authoritative.
 */
function resolveFromPantry(
  item: ParsedItem,
  pantry: Pantry | null,
  log: pino.Logger,
): { nutrients: Nutrients; meta: EstimateMeta } | null {
  if (!pantry || item.route !== "pantry") return null;

  const key = typeof item.pantry_key === "string" ? item.pantry_key.trim() : "";
  const ref = key ? pantry.items[key] : undefined;
  if (!ref) {
    if (key) log.warn({ pantryKey: key, food: item.name }, "model cited a pantry key that does not exist");
    return null;
  }

  const servings = Number(item.servings);
  if (!Number.isFinite(servings) || servings <= 0) {
    log.warn({ pantryKey: key, servings: item.servings }, "pantry hit with an unusable serving count");
    return null;
  }

  const nutrients = scaleReference(ref, servings);
  const meta = buildEstimateMeta(item);
  meta.pantry_key = ref.key;
  meta.basis = ref.source_tier === "manufacturer" || ref.verified_by === "owner"
    ? "published_label"
    : "reference_database";
  if (ref.source_url) meta.source_url = ref.source_url;
  if (ref.source_title) meta.source_title = ref.source_title;
  // The stored grams are per serving, so the portion's mass scales with it.
  if (ref.serving_grams > 0) {
    meta.grams = Math.round(ref.serving_grams * servings * 10) / 10;
    meta.grams_basis = "label_serving";
  }
  // Values read off a label are not the model's guess, whatever it said about itself.
  meta.confidence = ref.verified_by === "owner" ? "high" : meta.confidence;

  log.info(
    { pantryKey: ref.key, servings, calories: nutrients.calories, verifiedBy: ref.verified_by },
    "resolved from pantry",
  );
  return { nutrients, meta };
}

function buildResponseSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          // EVERY field is required, with a documented sentinel for "not applicable".
          //
          // This is not stylistic. The API rejects a schema with more than 24 optional
          // parameters, and this object plus its children is already close to that budget
          // (see MICRO_ITEM_SCHEMA's note). Keeping the optional count at zero means new
          // fields can be added here indefinitely without ever hitting the limit.
          required: [
            "name", "brand", "quantity", "unit", "spoken_portion",
            "grams", "grams_basis", "stated_calories", "water_ml",
            "is_plain_water", "route", "pantry_key", "servings",
            "confidence", "assumptions",
            "macros", "micronutrients",
          ],
          properties: {
            name: { type: "string", description: "The food or drink, with brand/restaurant preserved." },
            brand: {
              type: "string",
              description: "Brand, chain or manufacturer exactly as it markets itself (\"Raising Cane's\", \"Fairlife\"). Empty string if genuinely generic, like a homemade sandwich.",
            },
            quantity: { type: "number", description: "How much of it. Must be greater than zero." },
            unit: { type: "string", description: "Unit for the quantity, e.g. 'large egg', 'fl oz', 'serving', 'ml'." },
            spoken_portion: {
              type: "string",
              description: "The portion exactly as the user said it - \"a slice\", \"half a bottle\", \"probably a third of that\", \"16 oz\". Empty string if they gave no portion at all.",
            },
            grams: {
              type: "number",
              description:
                "Total edible mass of the serving described, in grams (for liquids use ml; 1 ml of water is 1 g). Work this out BEFORE the nutrients: knowing the mass is what makes the nutrient numbers checkable. 0 only if you truly have no basis.",
            },
            grams_basis: {
              type: "string",
              enum: ["label_serving", "typical_portion", "guess", "none"],
              description:
                "Where the gram figure came from. 'label_serving' = the manufacturer's stated serving size. 'typical_portion' = a well-known standard portion. 'guess' = your own rough figure. 'none' = no basis at all. Say 'guess' honestly - this decides what gets double-checked, it is not a grade.",
            },
            stated_calories: {
              type: "number",
              description:
                "A calorie figure the USER said out loud, e.g. 400 for \"the 400 cal one\". 0 if they said none. This SELECTS which product variant they mean - it is not the answer to copy.",
            },
            water_ml: {
              type: "number",
              description:
                "Approximate water content of this item in ml. Full volume for water and near-water drinks, a realistic fraction for milk, juice, coffee or soda, and 0 for solid food unless it is notably watery (soup, watermelon). This is what the hydration total is built from, so a drink that is not plain water still belongs here.",
            },
            is_plain_water: {
              type: "boolean",
              description:
                "True only for plain drinking water. False for watermelon, water chestnuts, tonic water, coconut water, seltzer, flavored water, or anything else with calories.",
            },
            route: {
              type: "string",
              enum: ["pantry", "lookup", "estimate"],
              description:
                "How this item's numbers should be sourced. 'pantry' = it matches a row in YOUR FOOD LIBRARY below, if one was given. 'lookup' = a brand, chain or packaged product that publishes nutrition facts somewhere. 'estimate' = a homemade, composed or cafeteria dish nobody publishes numbers for.",
            },
            pantry_key: {
              type: "string",
              description:
                "When route is 'pantry', the exact key from the library table. Empty string otherwise.",
            },
            servings: {
              type: "number",
              description:
                "When route is 'pantry', how many of that library row's servings this portion is - 2 for two bars, 0.5 for half a bottle. The server multiplies the stored values by this. 0 when route is not 'pantry'.",
            },
            confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
              description:
                "How tightly you would bet on the CALORIE figure. 'high' = within about 10%, typically a packaged product you know. 'medium' = within about 25%. 'low' = wider than that, e.g. a homemade or cafeteria dish.",
            },
            assumptions: {
              type: "string",
              description:
                "Any conversion or judgement the user should check, in one short sentence - the portion mass you assumed, a unit conversion, a fraction you applied, a variant you picked. Empty string if there was nothing to assume.",
            },
            macros: MACROS_SCHEMA,
            micronutrients: {
              type: "array",
              description:
                "Only the nutrients you can actually estimate for this food. Leave one out entirely rather than guessing; an omitted nutrient is recorded as unknown. Include an entry with value 0 only when the food genuinely contains none of it.",
              items: MICRO_ITEM_SCHEMA,
            },
          },
        },
      },
    },
  };
}

const RESPONSE_SCHEMA = buildResponseSchema();

// The prompt is split because its two halves have different audiences.
//
// parseAndEnrich needs both: it turns an utterance into items AND estimates them.
// estimateOne only needs the nutrition half - it is handed one already-parsed item and a
// schema with no is_plain_water field, so shipping it the water ml-conversion rules was
// instructing it about a field it cannot return.

const ROLE = `You are a food logging and nutrition expert. The user gives you a natural language description of what they ate, and you break it into individual food items with nutrition estimates.`;

const PARSING_RULES = `The input is often an automatic speech transcript. It may contain homophone errors, missing punctuation, and phonetically mangled brand names ("raising canes" -> "Raising Cane's", "L M N T" -> "LMNT"). Normalize brand and dish names to their canonical spelling before estimating.

Parsing rules:
- Split combined items: "eggs and toast" becomes two separate entries.
- Be specific with units: "large egg", "oz", "cup", "slice", "tbsp", "fl oz", "medium", "serving".
- For restaurant items where quantity is unclear, use quantity 1 and unit "serving".
- For drinks use "fl oz" where it makes sense (a standard glass of wine is 5 fl oz).
- For plain water use "ml", converting as needed (1 L = 1000 ml, 1 cup = 237 ml, 1 fl oz = 30 ml).
- Do not invent items the user did not mention. Do not add water unless they said so.
- Preserve brand and restaurant names ("Chipotle chicken al pastor burrito bowl").`;

const NUTRITION_RULES = `Nutrition rules:
- Work out the portion MASS first, then the nutrients. Decide how many grams (or ml) the described serving is, then derive the nutrients from that mass and the food's composition. Estimating calories directly from a name, without ever settling on a mass, is where large errors come from.
- Estimate for the ACTUAL serving described, not per 100g.
- Use your knowledge of typical restaurant portions, recipes, and branded products.
- calories, protein_g, fat_g and carbs_g are always required - give your best estimate.
- 4*protein_g + 4*carbs_g + 9*fat_g + 7*alcohol_g must land within about 10% of calories. Fiber may be counted anywhere from 0 to 4 kcal/g, so a high-fiber food sits at the low end of that range. If your numbers do not satisfy this, one of them is wrong - fix that one, and say which in "assumptions". Do not adjust a number you are confident about to make the arithmetic work.
- For every other nutrient: OMIT THE FIELD ENTIRELY if you do not have a reasonable basis for a number. Do not guess, and do not write 0 to mean "unknown". Write 0 only when the food genuinely contains none of that nutrient (a can of Coke really does have 0 g protein).
- This distinction matters: omitted values are recorded as unknown and excluded from daily totals, while a 0 is counted as a real measurement.

When the user states a number, it outranks your estimate:
- A stated CALORIE figure ("the 400 cal one", "about 150 calories each") identifies which product variant they mean. Work out which variant that is and take ALL of its numbers together. Never keep the user's calorie figure while inventing macros beside it that contradict it.
- A stated NUTRIENT amount ("42 grams of protein", "26 g protein") is a fact about the product, NOT a portion size. It never goes in quantity or unit. "A Fairlife shake, 26 grams of protein" is one bottle whose protein is 26 g - it is not 26 grams of shake.

Speech patterns this transcript will contain, and what to do with each:
- Self-correction ("from Subway, or no, Starbucks"): take the last-stated version and ignore the abandoned one.
- Partial consumption ("I didn't finish it, maybe half", "probably a third of that"): apply the fraction to the quantity and record what you applied in "assumptions".
- A fuzzy count ("four or five TicTacs"): take the midpoint.
- A meal marker ("for breakfast", "on the plane"): it tells you the setting and the likely portion, but is not itself a food. Never log it as an item.`;

const PARSE_SYSTEM_PROMPT = [ROLE, PARSING_RULES, NUTRITION_RULES].join("\n\n");
const ESTIMATE_SYSTEM_PROMPT = [ROLE, NUTRITION_RULES].join("\n\n");

/**
 * Pull the structured JSON payload out of a finished message.
 *
 * Reads the LAST text block, not the first. With `output_config.format` and nothing else
 * enabled there is exactly one block and the distinction is invisible - but the moment
 * server tools or `thinking.display: "summarized"` are switched on, the first block is
 * narration or a summary and `JSON.parse` throws on every single call. That is a hard
 * break rather than a degradation, and it would land the day the grounded resolver ships.
 *
 * Checking stop_reason first matters for the same reason: a refusal returns a normal 200
 * with an empty content array, so indexing into it produces a confusing TypeError instead
 * of the actual explanation.
 */
function extractPayload<T>(message: Anthropic.Message, what: string): T {
  if (message.stop_reason === "refusal") {
    throw new Error("Claude declined to process this text. Try rephrasing what you ate.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("That was a lot at once and the response ran long. Try splitting it into two entries.");
  }

  const textBlocks = message.content.filter(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  const block = textBlocks[textBlocks.length - 1];
  if (!block) throw new Error(`Claude returned no text content for ${what}`);

  try {
    return JSON.parse(block.text) as T;
  } catch (err) {
    // Guaranteed schema-valid by output_config.format, so this should be unreachable -
    // but if the guarantee ever fails, the raw text is the only way to find out why.
    throw new Error(
      `Could not read the ${what} response as JSON: ${(err as Error).message}. ` +
      `Response began: ${block.text.slice(0, 200)}`,
    );
  }
}

// Parse raw food text and estimate nutrients in a single Claude call.
// Accepts an optional parent logger for request ID correlation (server mode).
export interface ParseOptions {
  logger?: pino.Logger;
  /** Whose food library to offer. Omit for the demo endpoint, which has no user. */
  userId?: string;
  /**
   * Accumulates what this log costs across every model call it makes.
   *
   * Passed in rather than returned separately so the caller owns the lifetime - two logs
   * can be in flight at once, and their spend must not merge into one figure.
   */
  meter?: CostMeter;
}

export async function parseAndEnrich(
  text: string,
  opts: ParseOptions = {},
): Promise<{ entries: FoodEntry[]; parsedFoods: ParsedFood[] }> {
  const log = opts.logger || getLogger();

  // Candidate selection is deterministic and local - a Map lookup and token overlap, not
  // a model call - so offering the library costs nothing but prompt tokens.
  const pantry = opts.userId ? readPantry(opts.userId) : null;
  const candidates = pantry ? selectCandidates(pantry, text) : [];
  const pantryTable = renderPantryTable(candidates);

  log.info(
    {
      model: model(), effort: effort(), inputLength: text.length,
      inputPreview: text.slice(0, 200), pantryCandidates: candidates.length,
    },
    "claude parseAndEnrich starting",
  );

  const startMs = Date.now();
  const message = await client().messages.stream({
    model: model(),
    max_tokens: maxTokens(),
    // The library goes in the SYSTEM block, after the stable rules, so the rules half of
    // the prefix stays byte-identical across calls and remains cacheable on its own.
    system: pantryTable ? `${PARSE_SYSTEM_PROMPT}\n\n${pantryTable}` : PARSE_SYSTEM_PROMPT,
    output_config: {
      effort: effort(),
      format: { type: "json_schema", schema: RESPONSE_SCHEMA },
    },
    messages: [{ role: "user", content: `Parse and estimate this food log:\n\n${text}` }],
  }).finalMessage();
  const latencyMs = Date.now() - startMs;

  log.info({
    claude: {
      method: "parseAndEnrich",
      model: model(),
      latencyMs,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      stopReason: message.stop_reason,
    },
  }, "claude parseAndEnrich completed");

  opts.meter?.record("parseAndEnrich", model(), {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  });

  const parsed = extractPayload<{ items: ParsedItem[] }>(message, "food log");

  const entries: FoodEntry[] = [];
  const parsedFoods: ParsedFood[] = [];
  const loggedAt = new Date().toISOString();

  for (const item of parsed.items ?? []) {
    const food: ParsedFood = {
      name: String(item.name ?? "").trim() || "unnamed item",
      // `> 0`, not just isFinite: Number.isFinite(0) is true, and a zero or negative
      // quantity produces "0 tender" in the serving description and, worse, the prompt
      // "0 tender of chicken fingers" if that entry is ever re-estimated.
      quantity: Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1,
      unit: String(item.unit ?? "serving").trim() || "serving",
    };
    parsedFoods.push(food);

    // The schema lets the model return is_plain_water alongside a calorie count, which is
    // a contradiction it should never produce - but if it does, trusting the flag throws
    // the entire calorie and sugar contribution away silently. The prompt names the exact
    // traps (tonic water, coconut water, seltzer); this is the code that catches them.
    const declaredCalories = Number((item.macros as Record<string, unknown> | undefined)?.calories);
    const misflagged =
      item.is_plain_water && Number.isFinite(declaredCalories) && declaredCalories > 5;
    if (misflagged) {
      log.warn(
        { food: food.name, declaredCalories },
        "item flagged as plain water but carries calories - treating it as food",
      );
    }

    if (item.is_plain_water && !misflagged) {
      // Water is the one case where zeros are genuinely correct rather than unknown.
      //
      // The deterministic conversion is preferred over the model's own water_ml: the user
      // stated an explicit volume, and arithmetic on a stated volume beats an estimate of
      // it. Fall back to the model only when the unit is one we refuse to guess at.
      const waterMl = toMilliliters(food.quantity, food.unit) ?? positive(item.water_ml);
      log.info({ food: food.name, waterMl }, "detected plain water");
      entries.push({
        id: crypto.randomUUID(),
        food_name: `water (${waterMl ?? "?"}ml)`,
        serving_description: `${food.quantity} ${food.unit}`,
        source: "water",
        water_ml: waterMl ?? undefined,
        nutrients: zeroNutrients(),
        logged_at: loggedAt,
        parsed: food,
        estimate: buildEstimateMeta(item),
      });
    } else {
      // A pantry hit replaces the model's numbers with stored ones scaled by the server.
      // This is the whole point of the library: the model identifies WHICH food and HOW
      // MUCH, and arithmetic - not recall - produces the nutrients. Two properties follow
      // for free: the same food logged twice gets identical numbers, and a scaled
      // self-consistent label stays self-consistent.
      const resolved = resolveFromPantry(item, pantry, log);
      const nutrients = resolved?.nutrients ?? nutrientsFromResponse(item.macros, item.micronutrients, log);
      const meta = resolved?.meta ?? buildEstimateMeta(item);

      // Check the arithmetic before this ever reaches the preview. A contradiction is
      // recorded on the entry rather than rejected: the user is about to review this
      // screen anyway, and refusing to show them a number is worse than showing it with
      // a note. Violations are what the preview surfaces and what the harness counts.
      const violations = checkItem({
        name: food.name,
        nutrients,
        grams: meta.grams,
        grams_basis: meta.grams_basis,
      });
      if (violations.length > 0) {
        meta.violations = violations.map((v) => v.message);
        log.warn({ food: food.name, violations: meta.violations }, "estimate contradicts itself");
      }

      log.info(
        {
          food: food.name, calories: nutrients.calories, quantity: food.quantity, unit: food.unit,
          grams: meta.grams, gramsBasis: meta.grams_basis, confidence: meta.confidence,
        },
        "enriched food item",
      );
      entries.push({
        id: crypto.randomUUID(),
        food_name: `${food.name} (${food.quantity} ${food.unit})`,
        serving_description: `${food.quantity} ${food.unit}`,
        source: resolved ? "pantry" : "claude_estimate",
        nutrients,
        // Water content of a non-water item - the reason hydration used to read 0 ml on a
        // day with 1.4 L of milk, juice and coconut water in it.
        water_ml: positive(item.water_ml),
        logged_at: loggedAt,
        parsed: food,
        estimate: meta,
      });
    }
  }

  // ── Grounding pass ───────────────────────────────────────────────────────
  //
  // Everything the model routed to "lookup" gets its numbers read off a published source
  // instead of recalled. Bounded by a wall-clock deadline computed from time ALREADY
  // SPENT, not a fixed constant: the parse call itself now takes 10-40s depending on item
  // count, and a fixed budget would blow past the client's timeout on exactly the long
  // dictations that need grounding most.
  if (groundingEnabled()) {
    const lookups = entries
      .map((entry, i) => ({ entry, item: parsed.items[i] }))
      .filter(({ entry, item }) => {
        if (entry.source !== "claude_estimate" || item?.route !== "lookup") return false;

        // NOTE: there is deliberately no calorie threshold here.
        //
        // An earlier version skipped anything under 40 kcal as "not worth the lookup
        // cost". That was the wrong axis entirely for this user, who drinks low-calorie
        // things on purpose while dieting and tracks caffeine, magnesium and sodium far
        // more closely than the calories on those items. A zero-calorie electrolyte
        // sachet or a magnesium gummy is ALL micronutrient - it is the case where a
        // published label matters most, and it was the exact case being skipped.
        //
        // Cost is controlled by the two mechanisms that do not distort what gets tracked:
        // the pantry (a food is looked up once, ever) and the miss cache (a food that
        // genuinely publishes nothing is not re-searched).

        // A food we already failed to find recently is not worth re-searching. Two of
        // four measured lookups returned nothing and still cost $0.44 and $0.55 - and
        // without this they were re-paid in full on every subsequent logging.
        if (pantry && isRecentMiss(pantry, pantryKey(item.brand ?? "", item.name))) {
          log.info({ food: item.name }, "recently searched without success - skipping");
          return false;
        }
        return true;
      });

    if (lookups.length > 0) {
      const deadlineAt = startMs + totalBudgetMs();
      const remaining = Math.round((deadlineAt - Date.now()) / 1000);
      log.info({ lookups: lookups.length, remainingSeconds: remaining }, "grounding pass starting");

      await resolveAll(lookups, async ({ entry, item }) => {
        const resolved = await resolveOne(
          client(),
          {
            name: item.name, brand: item.brand ?? "",
            spokenPortion: item.spoken_portion ?? "", transcript: text,
          },
          { deadlineAt, logger: log, model: model(), effort: lookupEffort(), meter: opts.meter },
        );
        if (!resolved) {
          // Remember only a DEFINITIVE miss - a search that ran and found nothing.
          //
          // A timeout is a fact about today's network, not about the product. Red Bull hit
          // the 80s budget at 71s and was blacklisted for a fortnight as though it had no
          // published nutrition data, which is absurd for one of the most documented
          // products in existence.
          if (opts.userId && !lastLookupFailureWasTransient()) {
            try { recordMiss(opts.userId, pantryKey(item.brand ?? "", item.name)); } catch { /* never fail a log over the cache */ }
          }
          return;
        }

        // Replace in place. The entry keeps its id, name and serving description - only
        // the numbers and their provenance change.
        entry.nutrients = resolved.nutrients;
        entry.source = "grounded";
        entry.estimate = { ...entry.estimate, ...resolved.meta };

        // Ground once, cache forever. Without this the same slow lookup is paid again for
        // the same food tomorrow, and the "same product, five different answers" problem
        // survives grounding entirely - each logging would be an independent search.
        // Stored per SERVING, so any future portion is a multiply.
        if (opts.userId) {
          try {
            const r = resolved.record;
            const key = pantryKey(item.brand ?? "", r.display_name || item.name);
            const written = upsertItem(opts.userId, {
              key,
              display_name: r.display_name || item.name,
              aliases: [item.name, r.source_title].filter(Boolean),
              serving_label: r.serving_label || "1 serving",
              serving_grams: r.serving_grams > 0 ? r.serving_grams : 0,
              servings_per_container: r.servings_per_container > 0 ? r.servings_per_container : 0,
              // The source's own per-serving figures, so any future portion is a multiply.
              per_serving: resolved.perServing,
              source_url: r.source_url,
              source_title: r.source_title,
              source_tier: r.source_tier === "none" ? "none" : r.source_tier,
              verified_by: "claude",
              verified_at: new Date().toISOString(),
              log_count: 1,
            });
            log.info({ pantryKey: key, written: written.written, reason: written.reason },
              "saved grounded reference to the pantry");
          } catch (err) {
            // Never fail a log because the cache write failed.
            log.warn({ err, food: item.name }, "could not save reference to the pantry");
          }
        }

        const violations = checkItem({
          name: entry.food_name, nutrients: entry.nutrients,
          grams: resolved.meta.grams, grams_basis: resolved.meta.grams_basis,
        });
        entry.estimate.violations = violations.length ? violations.map((v) => v.message) : undefined;
      });
    }
  }

  // ── Micronutrient pass ───────────────────────────────────────────────────
  //
  // Runs last, on items that still have thin micronutrient data. See the note in
  // resolver.ts: labels print four micronutrients, so grounding cannot fill the eleven
  // that only composition can supply. This is the only step that can lift coverage above
  // the ~40% ceiling, and it only ever adds - a label value is never overwritten.
  if (microPassEnabled()) {
    const deadlineAt = startMs + totalBudgetMs();
    const thin = entries.filter(
      (e) => e.source !== "water" && countKnownCompositionNutrients(e.nutrients) < MICRO_TARGET,
    );
    if (thin.length > 0 && Date.now() < deadlineAt - 5_000) {
      log.info({ items: thin.length }, "micronutrient pass starting");
      await resolveAll(thin, async (entry) => {
        entry.nutrients = await enrichMicronutrients(
          client(),
          { name: entry.food_name, grams: entry.estimate?.grams, nutrients: entry.nutrients },
          { deadlineAt, logger: log, model: model(), effort: lookupEffort(), meter: opts.meter },
        );
      });
    }
  }

  log.info(
    {
      itemCount: entries.length,
      grounded: entries.filter((e) => e.source === "grounded").length,
      fromPantry: entries.filter((e) => e.source === "pantry").length,
      totalMs: Date.now() - startMs,
    },
    "parseAndEnrich finished",
  );
  return { entries, parsedFoods };
}

/**
 * How many of the nutrients the composition pass can ACTUALLY supply are already known.
 *
 * Counting all 25 non-macro nutrients was wrong, and Red Bull is the proof: a complete
 * label carries fiber, sugar, saturated fat, sodium, cholesterol, calcium, iron,
 * potassium and vitamin D, which reaches the old threshold of 12 on label data alone -
 * so the pass was skipped as "already covered" while nine of the fourteen nutrients only
 * it can provide sat empty. Red Bull had 5 of these 14 and got nothing.
 *
 * A magnesium gummy is the same failure from the other end: near-zero calories, one
 * nutrient that matters, and the pass is exactly what should fill the rest in.
 */
function countKnownCompositionNutrients(n: Nutrients): number {
  return COMPOSITION_ONLY_KEYS.filter((k) => n[k] !== null).length;
}

/**
 * Run the composition pass unless these are nearly complete.
 *
 * Set high on purpose - 10 of 14 - because the pass only ever ADDS to nulls and never
 * overwrites a known value, so running it on an item that turns out to be well covered
 * costs one small call and changes nothing.
 */
const MICRO_TARGET = 10;

// Re-estimate a single food item. Used by the CLI re-pick flow and by POST /estimate,
// so the frontend can fix one bad item without re-dictating the whole day.
export interface EstimateOneOptions {
  /**
   * The utterance this item came from, if it can be recovered.
   *
   * This matters more than it looks. Re-estimate is the correction button, and it was the
   * one path that threw away ground truth: an entry whose transcript said "a 940 cal
   * pepperoni pizza from the boeing cafeteria" re-estimated from the bare string
   * "1 serving of Pepperoni pizza (Boeing cafeteria)", discarding the calorie count the
   * user had stated out loud. Dose-carrying units are worse - "Vitamin D3 gummy
   * supplement (2000 mg)" round-trips into "2000 mg of Vitamin D3 gummy supplement",
   * which is two kilograms of gummies.
   */
  transcript?: string;
  logger?: pino.Logger;
}

export async function estimateOne(food: ParsedFood, opts: EstimateOneOptions = {}): Promise<Nutrients> {
  const log = opts.logger || getLogger();

  // Same macros + micronutrient-list shape as the batch schema, and for the same reason:
  // one optional property per nutrient exceeds the API's 24-optional-parameter limit.
  const singleSchema = {
    type: "object",
    additionalProperties: false,
    required: ["macros", "micronutrients"],
    properties: {
      macros: MACROS_SCHEMA,
      micronutrients: {
        type: "array",
        description: "Only nutrients you can actually estimate. Omit the rest rather than guessing.",
        items: MICRO_ITEM_SCHEMA,
      },
    },
  };

  log.info({ food: food.name, quantity: food.quantity, unit: food.unit, model: model() },
    "claude estimateOne starting");

  const startMs = Date.now();
  const message = await client().messages.stream({
    model: model(),
    // Generous headroom: the old 512 left only ~200 tokens of slack on real responses.
    max_tokens: 8000,
    system: ESTIMATE_SYSTEM_PROMPT,
    output_config: {
      effort: effort(),
      format: { type: "json_schema", schema: singleSchema },
    },
    messages: [{
      role: "user",
      content: [
        // The transcript goes FIRST and is framed as the authority. The parsed
        // quantity/unit beneath it may itself be the thing that was wrong - that is
        // usually why a re-estimate is being asked for at all.
        opts.transcript
          ? `The user originally described this meal as:\n"${opts.transcript}"\n\n` +
            `Re-estimate the nutrition for one item from it: ${food.quantity} ${food.unit} of ${food.name}\n` +
            `Where the description above disagrees with that quantity and unit, trust the description - ` +
            `a number the user stated out loud is a fact, and may have been misread as a portion size.`
          : `Estimate the nutrition for exactly this one item:\n${food.quantity} ${food.unit} of ${food.name}`,
      ].join(""),
    }],
  }).finalMessage();

  log.info({
    claude: {
      method: "estimateOne",
      model: model(),
      latencyMs: Date.now() - startMs,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      stopReason: message.stop_reason,
      food: food.name,
    },
  }, "claude estimateOne completed");

  const single = extractPayload<{ macros: unknown; micronutrients: unknown }>(message, "estimate");
  return nutrientsFromResponse(single.macros, single.micronutrients, log);
}

// Convert a water quantity + unit into milliliters.
// Returns null for units we don't recognize rather than passing the raw quantity through -
// silently recording "2 bottles" as 2 ml is worse than recording nothing.
export function toMilliliters(quantity: number, unit: string): number | null {
  const log = getLogger();
  const u = unit.toLowerCase().trim();

  if (!Number.isFinite(quantity) || quantity < 0) return null;
  if (u === "ml" || u.includes("milliliter") || u.includes("millilitre")) return Math.round(quantity);
  // Check fluid ounces before the bare-litre test, so "fl oz" never matches "l".
  if (u.includes("fl oz") || u.includes("fluid oz") || u.includes("fl. oz")) return Math.round(quantity * 29.574);

  // Explicit units are tested before container words, so "2 l bottle" is two litres and
  // not one bottle. The old order tested `u === "l"` (fails on "2 l bottle") and
  // `u.includes("liter")` (also fails), then fell through to `includes("bottle")` and
  // returned 500 ml - a 4x undercount, silently, from a function whose whole purpose is
  // to refuse rather than guess. `\bl\b` catches the bare unit wherever it sits.
  // The dl/cl guard stays: those must not be read as litres.
  if ((/\bl\b/.test(u) || u.includes("liter") || u.includes("litre")) &&
      !u.includes("dl") && !u.includes("cl") && !u.includes("ml") &&
      !u.includes("deciliter") && !u.includes("centiliter")) return Math.round(quantity * 1000);
  if (u === "dl" || u.includes("deciliter") || u.includes("decilitre")) return Math.round(quantity * 100);
  if (u === "cl" || u.includes("centiliter") || u.includes("centilitre")) return Math.round(quantity * 10);
  if (u.includes("oz")) return Math.round(quantity * 29.574);
  if (u.includes("cup")) return Math.round(quantity * 236.588);
  if (u.includes("gallon")) return Math.round(quantity * 3785.41);
  if (u.includes("tbsp") || u.includes("tablespoon")) return Math.round(quantity * 14.787);

  // Container words are a last resort: a "bottle" is anywhere from 250 ml to 2 L, so
  // these are assumptions, not conversions. Say so in the log - a wrong hydration number
  // that arrived silently is indistinguishable from a right one.
  const assumed =
    u.includes("glass") ? 240 :
    u.includes("bottle") ? 500 :
    u.includes("can") ? 355 : null;
  if (assumed !== null) {
    log.warn({ unit, quantity, assumedMlPerUnit: assumed },
      "ambiguous water container unit - assuming a default volume");
    return Math.round(quantity * assumed);
  }

  log.warn({ unit, quantity }, "unknown water unit, recording volume as unknown");
  return null;
}
