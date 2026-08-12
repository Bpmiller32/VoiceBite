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
  NUTRIENT_KEYS, CORE_NUTRIENT_KEYS,
} from "./types";
import { getLogger } from "./logger";

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
export function sanitizeNutrients(input: unknown): Nutrients {
  const out = emptyNutrients();
  if (!input || typeof input !== "object") return out;
  const raw = input as Record<string, unknown>;

  for (const key of NUTRIENT_KEYS) {
    const v = raw[key];
    // Absent or explicitly null means unknown - leave it as null.
    if (v === undefined || v === null || v === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    // NaN, Infinity and negative amounts are all nonsense for a nutrient. Treat as unknown.
    if (!Number.isFinite(n) || n < 0) continue;
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
    for (const key of NUTRIENT_KEYS) {
      const v = n[key];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      totals[key] += v;
      coverage[key] += 1;
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

const MACROS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: CORE_NUTRIENT_KEYS,
  properties: Object.fromEntries(
    CORE_NUTRIENT_KEYS.map((k) => [k, { type: "number", description: `${k} for the serving described.` }]),
  ),
};

// Fold the response's macros + micronutrient list back into a flat Nutrients object.
// Anything Claude left out of the list stays null, which is what "unknown" means here.
function nutrientsFromResponse(macros: unknown, micros: unknown): Nutrients {
  const flat: Record<string, unknown> = { ...(macros as Record<string, unknown> ?? {}) };
  if (Array.isArray(micros)) {
    for (const m of micros) {
      if (m && typeof m.key === "string") flat[m.key] = m.value;
    }
  }
  return sanitizeNutrients(flat);
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
          required: ["name", "quantity", "unit", "is_plain_water", "macros", "micronutrients"],
          properties: {
            name: { type: "string", description: "The food or drink, with brand/restaurant preserved." },
            quantity: { type: "number", description: "How much of it." },
            unit: { type: "string", description: "Unit for the quantity, e.g. 'large egg', 'fl oz', 'serving', 'ml'." },
            is_plain_water: {
              type: "boolean",
              description:
                "True only for plain drinking water. False for watermelon, water chestnuts, tonic water, coconut water, seltzer, flavored water, or anything else with calories.",
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

const SYSTEM_PROMPT = `You are a food logging and nutrition expert. The user gives you a natural language description of what they ate, and you break it into individual food items with nutrition estimates.

The input is often an automatic speech transcript. It may contain homophone errors, missing punctuation, and phonetically mangled brand names ("raising canes" -> "Raising Cane's", "L M N T" -> "LMNT"). Normalize brand and dish names to their canonical spelling before estimating.

Parsing rules:
- Split combined items: "eggs and toast" becomes two separate entries.
- Be specific with units: "large egg", "oz", "cup", "slice", "tbsp", "fl oz", "medium", "serving".
- For restaurant items where quantity is unclear, use quantity 1 and unit "serving".
- For drinks use "fl oz" where it makes sense (a standard glass of wine is 5 fl oz).
- For plain water use "ml", converting as needed (1 L = 1000 ml, 1 cup = 237 ml, 1 fl oz = 30 ml).
- Do not invent items the user did not mention. Do not add water unless they said so.
- Preserve brand and restaurant names ("Chipotle chicken al pastor burrito bowl").

Nutrition rules:
- Estimate for the ACTUAL serving described, not per 100g.
- Use your knowledge of typical restaurant portions, recipes, and branded products.
- calories, protein_g, fat_g and carbs_g are always required - give your best estimate.
- For every other nutrient: OMIT THE FIELD ENTIRELY if you do not have a reasonable basis for a number. Do not guess, and do not write 0 to mean "unknown". Write 0 only when the food genuinely contains none of that nutrient (a can of Coke really does have 0 g protein).
- This distinction matters: omitted values are recorded as unknown and excluded from daily totals, while a 0 is counted as a real measurement.`;

// Parse raw food text and estimate nutrients in a single Claude call.
// Accepts an optional parent logger for request ID correlation (server mode).
export async function parseAndEnrich(
  text: string,
  parentLogger?: pino.Logger,
): Promise<{ entries: FoodEntry[]; parsedFoods: ParsedFood[] }> {
  const log = parentLogger || getLogger();

  log.info(
    { model: model(), effort: effort(), inputLength: text.length, inputPreview: text.slice(0, 200) },
    "claude parseAndEnrich starting",
  );

  const startMs = Date.now();
  const message = await client().messages.stream({
    model: model(),
    max_tokens: maxTokens(),
    system: SYSTEM_PROMPT,
    output_config: {
      effort: effort(),
      format: { type: "json_schema", schema: RESPONSE_SCHEMA },
    },
    messages: [{ role: "user", content: `Parse and estimate this food log:\n\n${text}` }],
  } as any).finalMessage();
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

  // Safety classifiers can decline a request outright. That returns a normal 200 with an
  // empty body, so reading content[0] without checking would throw something unhelpful.
  if (message.stop_reason === "refusal") {
    throw new Error("Claude declined to process this text. Try rephrasing what you ate.");
  }
  // With a high max_tokens this should be unreachable, but silent truncation is exactly
  // the failure this rewrite exists to eliminate - so fail loudly rather than parse garbage.
  if (message.stop_reason === "max_tokens") {
    throw new Error("That was a lot at once and the response ran long. Try splitting it into two entries.");
  }

  const block = message.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("Claude returned no text content");
  }

  // Guaranteed schema-valid by output_config.format - no regex extraction needed.
  const parsed = JSON.parse(block.text) as {
    items: Array<{
      name: string; quantity: number; unit: string; is_plain_water: boolean;
      macros: unknown; micronutrients: unknown;
    }>;
  };

  const entries: FoodEntry[] = [];
  const parsedFoods: ParsedFood[] = [];
  const loggedAt = new Date().toISOString();

  for (const item of parsed.items ?? []) {
    const food: ParsedFood = {
      name: String(item.name ?? "").trim() || "unnamed item",
      quantity: Number.isFinite(item.quantity) ? item.quantity : 1,
      unit: String(item.unit ?? "serving").trim() || "serving",
    };
    parsedFoods.push(food);

    if (item.is_plain_water) {
      // Water is the one case where zeros are genuinely correct rather than unknown.
      const waterMl = toMilliliters(food.quantity, food.unit);
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
      });
    } else {
      const nutrients = nutrientsFromResponse(item.macros, item.micronutrients);
      log.info(
        { food: food.name, calories: nutrients.calories, quantity: food.quantity, unit: food.unit },
        "enriched food item",
      );
      entries.push({
        id: crypto.randomUUID(),
        food_name: `${food.name} (${food.quantity} ${food.unit})`,
        serving_description: `${food.quantity} ${food.unit}`,
        source: "claude_estimate",
        nutrients,
        logged_at: loggedAt,
        parsed: food,
      });
    }
  }

  log.info({ itemCount: entries.length }, "parseAndEnrich finished");
  return { entries, parsedFoods };
}

// Re-estimate a single food item. Used by the CLI re-pick flow and by POST /estimate,
// so the frontend can fix one bad item without re-dictating the whole day.
export async function estimateOne(food: ParsedFood, parentLogger?: pino.Logger): Promise<Nutrients> {
  const log = parentLogger || getLogger();

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
    system: SYSTEM_PROMPT,
    output_config: {
      effort: effort(),
      format: { type: "json_schema", schema: singleSchema },
    },
    messages: [{
      role: "user",
      content: `Estimate the nutrition for exactly this one item:\n${food.quantity} ${food.unit} of ${food.name}`,
    }],
  } as any).finalMessage();

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

  if (message.stop_reason === "refusal") throw new Error("Claude declined to estimate this item.");
  if (message.stop_reason === "max_tokens") throw new Error("Estimate response ran long. Try a simpler description.");

  const block = message.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("Claude returned no text content");

  const single = JSON.parse(block.text) as { macros: unknown; micronutrients: unknown };
  return nutrientsFromResponse(single.macros, single.micronutrients);
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
  // Guard the deci/centi prefixes so "dl" and "cl" don't read as litres.
  if ((u === "l" || u.includes("liter") || u.includes("litre")) &&
      !u.includes("dl") && !u.includes("cl") && !u.includes("ml")) return Math.round(quantity * 1000);
  if (u === "dl" || u.includes("deciliter") || u.includes("decilitre")) return Math.round(quantity * 100);
  if (u === "cl" || u.includes("centiliter") || u.includes("centilitre")) return Math.round(quantity * 10);
  if (u.includes("oz")) return Math.round(quantity * 29.574);
  if (u.includes("cup")) return Math.round(quantity * 236.588);
  if (u.includes("glass")) return Math.round(quantity * 240);
  if (u.includes("bottle")) return Math.round(quantity * 500);
  if (u.includes("can")) return Math.round(quantity * 355);
  if (u.includes("tbsp") || u.includes("tablespoon")) return Math.round(quantity * 14.787);
  if (u.includes("gallon")) return Math.round(quantity * 3785.41);

  log.warn({ unit, quantity }, "unknown water unit, recording volume as unknown");
  return null;
}
