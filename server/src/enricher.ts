// enricher.ts
// Takes raw food text and produces full nutrient profiles in a single Claude call
//
// Strategy:
//   1. Send the raw text to Claude with instructions to parse AND estimate nutrients together
//   2. Claude returns each food item with name, quantity, unit, and full nutrient profile
//   3. Water items are detected client-side and zeroed out (no need to waste tokens on water)
//
// This is one API call total for the whole pipeline (parse + enrich combined).
// The only separate call is estimateWithClaude(), used for re-picks in the CLI.

import Anthropic from "@anthropic-ai/sdk";
import pino from "pino";
import { ParsedFood, FoodEntry, Nutrients } from "./types";
import { getLogger } from "./logger";

// Which Claude model to use - set CLAUDE_MODEL in .env to override
// Update this string when Anthropic releases newer models (no "latest" alias exists)
// Full list: https://docs.anthropic.com/en/docs/about-claude/models
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

// Returns a zero-filled Nutrients object - useful as a starting point
function emptyNutrients(): Nutrients {
  return {
    calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0,
    fiber_g: 0, sugar_g: 0, saturated_fat_g: 0,
    vitamin_a_mcg: 0, vitamin_c_mg: 0, vitamin_d_mcg: 0,
    vitamin_e_mg: 0, vitamin_k_mcg: 0, vitamin_b12_mcg: 0,
    vitamin_b6_mg: 0, folate_mcg: 0, thiamin_mg: 0,
    riboflavin_mg: 0, niacin_mg: 0,
    calcium_mg: 0, iron_mg: 0, magnesium_mg: 0,
    potassium_mg: 0, sodium_mg: 0, zinc_mg: 0,
    selenium_mcg: 0, phosphorus_mg: 0,
    cholesterol_mg: 0, caffeine_mg: 0, alcohol_g: 0,
  };
}

// The combined prompt that parses raw text AND estimates nutrients in one shot
const PARSE_AND_ESTIMATE_PROMPT = `You are a food logging and nutrition expert. The user will give you a natural language description of everything they ate.

Your job is to:
1. Break the text into individual food items
2. Estimate the full nutritional content for each item's described serving

Rules for parsing:
- Split combined items: "eggs and toast" becomes two separate entries
- Be specific with units: use "large egg", "oz", "cup", "slice", "tbsp", "fl oz", "medium", "serving", etc.
- For restaurant items where quantity is unclear, use quantity: 1 and unit: "serving"
- For drinks, use "fl oz" when possible (e.g. a standard glass of wine = 5 fl oz)
- For WATER specifically: always use "ml" as the unit, converting as needed (1 L = 1000 ml, 1 cup = 237 ml, 1 fl oz = 30 ml)
- Do not include water unless explicitly mentioned
- Preserve brand/restaurant names in the item name (e.g. "Chipotle chicken al-pastor burrito bowl")

Rules for nutrition:
- Estimate for the ACTUAL serving described, not per 100g
- Use your knowledge of typical restaurant portions, recipes, and branded products
- All nutrient values must be numbers (use 0 if truly unknown)
- For plain water items, set all nutrients to 0

Respond with ONLY this JSON, no other text:
{"items": [
  {
    "name": "scrambled eggs", "quantity": 2, "unit": "large egg",
    "nutrients": {
      "calories": 0, "protein_g": 0, "fat_g": 0, "carbs_g": 0,
      "fiber_g": 0, "sugar_g": 0, "saturated_fat_g": 0,
      "vitamin_a_mcg": 0, "vitamin_c_mg": 0, "vitamin_d_mcg": 0,
      "vitamin_e_mg": 0, "vitamin_k_mcg": 0, "vitamin_b12_mcg": 0,
      "vitamin_b6_mg": 0, "folate_mcg": 0, "thiamin_mg": 0,
      "riboflavin_mg": 0, "niacin_mg": 0, "calcium_mg": 0,
      "iron_mg": 0, "magnesium_mg": 0, "potassium_mg": 0,
      "sodium_mg": 0, "zinc_mg": 0, "selenium_mcg": 0,
      "phosphorus_mg": 0, "cholesterol_mg": 0, "caffeine_mg": 0, "alcohol_g": 0
    }
  }
]}`;

// Parse raw food text and estimate nutrients in a single Claude call
// Returns both the FoodEntry array and the ParsedFood array (needed for CLI re-picks)
// Accepts an optional parent logger for request ID correlation (server mode)
export async function parseAndEnrich(
  text: string,
  parentLogger?: pino.Logger,
): Promise<{ entries: FoodEntry[]; parsedFoods: ParsedFood[] }> {
  const log = parentLogger || getLogger();
  const anthropic = new Anthropic();

  log.info({ inputLength: text.length, inputPreview: text.slice(0, 200) }, "claude parseAndEnrich starting");

  const startMs = Date.now();
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{ role: "user", content: `${PARSE_AND_ESTIMATE_PROMPT}\n\nParse and estimate this food log:\n\n${text}` }],
  });
  const latencyMs = Date.now() - startMs;

  const block = message.content[0];
  if (block.type !== "text") throw new Error("Claude returned unexpected type");

  log.info({
    claude: {
      method: "parseAndEnrich",
      model: MODEL,
      latencyMs,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      stopReason: message.stop_reason,
    },
  }, "claude parseAndEnrich completed");

  const jsonMatch = block.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    log.error({ rawResponse: block.text.slice(0, 500) }, "failed to extract JSON from Claude response");
    throw new Error(`Could not find JSON in Claude response: ${block.text}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed.items)) {
    log.error({ rawResponse: block.text.slice(0, 500) }, "Claude returned unexpected format");
    throw new Error(`Claude returned unexpected format: ${block.text}`);
  }

  const entries: FoodEntry[] = [];
  const parsedFoods: ParsedFood[] = [];

  for (const item of parsed.items) {
    const food: ParsedFood = { name: item.name, quantity: item.quantity, unit: item.unit };
    parsedFoods.push(food);

    // Water special case: zero out nutrients, track volume in ml
    if (isPlainWater(food)) {
      const waterMl = toMilliliters(food.quantity, food.unit);
      log.info({ food: food.name, waterMl }, "detected plain water");
      entries.push({
        id: crypto.randomUUID(),
        food_name: `water (${waterMl}ml)`,
        serving_description: `${food.quantity} ${food.unit}`,
        source: "water",
        water_ml: waterMl,
        nutrients: emptyNutrients(),
      });
    } else {
      const nutrients: Nutrients = { ...emptyNutrients(), ...item.nutrients };
      log.info({ food: food.name, calories: nutrients.calories, quantity: food.quantity, unit: food.unit }, "enriched food item");
      entries.push({
        id: crypto.randomUUID(),
        food_name: `${food.name} (${food.quantity} ${food.unit})`,
        serving_description: `${food.quantity} ${food.unit}`,
        source: "claude_estimate",
        nutrients,
      });
    }
  }

  log.info({ itemCount: entries.length }, "parseAndEnrich finished");
  return { entries, parsedFoods };
}

// Ask Claude to estimate the full nutrient profile for a single food item
// Used by the CLI re-pick flow when the user wants a fresh estimate for one entry
export async function estimateWithClaude(food: ParsedFood, parentLogger?: pino.Logger): Promise<Nutrients> {
  const log = parentLogger || getLogger();
  const anthropic = new Anthropic();

  const prompt = `You are a nutrition expert. Estimate the nutritional content for:
${food.quantity} ${food.unit} of ${food.name}

Use your knowledge of typical restaurant portions, recipes, and branded products.
Respond with ONLY this JSON object, no other text. All values must be numbers (use 0 if truly unknown):
{
  "calories": 0, "protein_g": 0, "fat_g": 0, "carbs_g": 0,
  "fiber_g": 0, "sugar_g": 0, "saturated_fat_g": 0,
  "vitamin_a_mcg": 0, "vitamin_c_mg": 0, "vitamin_d_mcg": 0,
  "vitamin_e_mg": 0, "vitamin_k_mcg": 0, "vitamin_b12_mcg": 0,
  "vitamin_b6_mg": 0, "folate_mcg": 0, "thiamin_mg": 0,
  "riboflavin_mg": 0, "niacin_mg": 0, "calcium_mg": 0,
  "iron_mg": 0, "magnesium_mg": 0, "potassium_mg": 0,
  "sodium_mg": 0, "zinc_mg": 0, "selenium_mcg": 0,
  "phosphorus_mg": 0, "cholesterol_mg": 0, "caffeine_mg": 0, "alcohol_g": 0
}`;

  log.info({ food: food.name, quantity: food.quantity, unit: food.unit }, "claude estimateWithClaude starting");

  const startMs = Date.now();
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });
  const latencyMs = Date.now() - startMs;

  const block = message.content[0];
  if (block.type !== "text") throw new Error("Claude returned unexpected type");

  log.info({
    claude: {
      method: "estimateWithClaude",
      model: MODEL,
      latencyMs,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      stopReason: message.stop_reason,
      food: food.name,
    },
  }, "claude estimateWithClaude completed");

  const jsonMatch = block.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    log.error({ food: food.name, rawResponse: block.text.slice(0, 500) }, "failed to parse Claude nutrition estimate");
    throw new Error(`Could not parse Claude nutrition estimate: ${block.text}`);
  }

  return { ...emptyNutrients(), ...JSON.parse(jsonMatch[0]) };
}

// Detect if a parsed food item is plain water (should bypass Claude entirely)
// We match on "water" in the name but exclude caloric water-based drinks
function isPlainWater(food: ParsedFood): boolean {
  const name = food.name.toLowerCase();
  if (!name.includes("water")) return false;
  if (name.includes("coconut water")) return false;
  if (name.includes("vitamin water")) return false;
  if (name.includes("flavored water")) return false;
  if (name.includes("juice")) return false;
  return true;
}

// Convert a water quantity + unit into milliliters
// Prompt instructs Claude to use ml for water, but this handles other units as fallback
function toMilliliters(quantity: number, unit: string): number {
  const log = getLogger();
  const u = unit.toLowerCase();
  if (u === "ml" || u.includes("milliliter")) return Math.round(quantity);
  if (u === "l" || u.includes("liter") && !u.includes("fl")) return Math.round(quantity * 1000);
  if (u.includes("fl oz") || u.includes("fluid oz")) return Math.round(quantity * 29.574);
  if (u.includes("oz") && !u.includes("fl")) return Math.round(quantity * 29.574);
  if (u.includes("cup")) return Math.round(quantity * 236.588);
  if (u.includes("tbsp") || u.includes("tablespoon")) return Math.round(quantity * 14.787);
  log.warn({ unit, quantity }, "unknown water unit, storing quantity as-is");
  return Math.round(quantity);
}

// Sum up all nutrient values across an array of entries to get daily totals
export function sumNutrients(entries: FoodEntry[]): Nutrients {
  const totals = emptyNutrients();
  for (const entry of entries) {
    for (const key of Object.keys(totals) as Array<keyof Nutrients>) {
      totals[key] = Math.round((totals[key] + entry.nutrients[key]) * 100) / 100;
    }
  }
  return totals;
}
