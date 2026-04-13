// enricher.ts
// Takes a list of parsed food items and produces full nutrient profiles for each one
//
// Strategy per food item:
//   1. Search USDA FoodData Central for the top 5 candidates
//   2. Ask Claude to pick the best match (or "none" if nothing fits well)
//   3. If Claude picks a match: scale its per-100g nutrients to the actual serving weight
//   4. If Claude says none match (common for branded restaurant items): Claude estimates directly
//
// Why this two-step approach: the USDA search often returns the wrong food or a loosely
// matched entry. For example, searching "Chipotle chicken burrito bowl" might return a
// generic "burrito bowl" that's 133 cal/100g - plausible per 100g, but a Chipotle bowl
// weighs ~450g so it should be ~600 cal. Claude catches these mismatches.

import Anthropic from "@anthropic-ai/sdk";
import { ParsedFood, FoodEntry, Nutrients, FDCCandidate, EnrichedResult } from "./types";

// Which Claude model to use - set CLAUDE_MODEL in .env to override
// Update this string when Anthropic releases newer models (no "latest" alias exists)
// Full list: https://docs.anthropic.com/en/docs/about-claude/models
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

// Base URL for the USDA FoodData Central API
const FDC_BASE_URL = "https://api.nal.usda.gov/fdc/v1";

// USDA nutrient IDs we care about - these are the official IDs in their database
// Full list at https://api.nal.usda.gov/fdc/v1/nutrients
const NUTRIENT_IDS: Record<string, number> = {
  calories: 1008,
  protein_g: 1003,
  fat_g: 1004,
  carbs_g: 1005,
  fiber_g: 1079,
  sugar_g: 2000,
  saturated_fat_g: 1258,
  vitamin_a_mcg: 1106,
  vitamin_c_mg: 1162,
  vitamin_d_mcg: 1114,
  vitamin_e_mg: 1109,
  vitamin_k_mcg: 1185,
  vitamin_b12_mcg: 1178,
  vitamin_b6_mg: 1175,
  folate_mcg: 1177,
  thiamin_mg: 1165,
  riboflavin_mg: 1166,
  niacin_mg: 1167,
  calcium_mg: 1087,
  iron_mg: 1089,
  magnesium_mg: 1090,
  potassium_mg: 1092,
  sodium_mg: 1093,
  zinc_mg: 1095,
  selenium_mcg: 1103,
  phosphorus_mg: 1091,
  cholesterol_mg: 1253,
  caffeine_mg: 1057,
  alcohol_g: 1018,
};

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

// Map a USDA foodNutrients array into our flat Nutrients object
// USDA returns an array like [{nutrientId: 1008, value: 52}, ...]
function mapNutrients(foodNutrients: any[]): Nutrients {
  const nutrients = emptyNutrients();
  if (!foodNutrients) return nutrients;

  for (const n of foodNutrients) {
    for (const [key, id] of Object.entries(NUTRIENT_IDS)) {
      if (n.nutrientId === id) {
        // Safe dynamic assignment - key is always a keyof Nutrients
        (nutrients as any)[key] = n.value ?? 0;
      }
    }
  }
  return nutrients;
}

// Search USDA FDC for a food, returns the top 5 candidates
// We use multiple dataTypes to cover both generic and branded foods
async function searchFDC(query: string): Promise<FDCCandidate[]> {
  const apiKey = process.env.USDA_FDC_API_KEY;
  if (!apiKey) throw new Error("USDA_FDC_API_KEY is not set in your .env file");

  // Request top 5 results including nutrient data inline
  const url = `${FDC_BASE_URL}/foods/search?query=${encodeURIComponent(query)}&dataType=Foundation,Branded,SR%20Legacy&pageSize=5&api_key=${apiKey}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`USDA FDC search failed: ${response.status}`);

  const data = await response.json() as any;
  if (!data.foods || data.foods.length === 0) return [];

  // Map each result into our FDCCandidate type
  return data.foods.map((food: any): FDCCandidate => ({
    fdcId: food.fdcId,
    description: food.description,
    dataType: food.dataType || "Unknown",
    nutrients: mapNutrients(food.foodNutrients || []),
  }));
}

// Ask Claude to evaluate USDA candidates and pick the best match
// Returns: the 0-based index of the best candidate, the serving weight in grams, or null if none fit
async function pickBestCandidate(
  food: ParsedFood,
  candidates: FDCCandidate[]
): Promise<{ pick: number | null; servingWeightGrams: number; reason: string }> {
  // Format candidates as a numbered list for Claude to evaluate
  const candidateList = candidates
    .map((c, i) => `[${i + 1}] FDC ${c.fdcId} (${c.dataType}): ${c.description}`)
    .join("\n");

  const prompt = `You are a nutrition expert evaluating food database matches.

The user logged: "${food.quantity} ${food.unit} of ${food.name}"

These are the top USDA FoodData Central search results:
${candidateList}

Respond with ONLY this JSON object, no other text:
{
  "pick": 1,
  "servingWeightGrams": 250,
  "reason": "Brief explanation"
}

Rules for pick:
- Use the 1-based number of the best match, or null if no candidate is a good match
- Set null if this is a branded restaurant item (Starbucks, Chipotle, McDonald's, etc.) - USDA won't have exact matches for these
- Set null if the best candidate's description doesn't closely match what the user described
- Set null if the calorie values would be implausible (e.g. a Coke with protein)

Rules for servingWeightGrams:
- Estimate the total weight in grams for the described serving quantity
- For "2 large eggs" → about 100g. For "1 Chipotle burrito bowl" → about 450g. For "16 fl oz latte" → about 480g
- USDA data is per 100g, so we divide by 100 and multiply by this value to get the actual serving nutrition`;

  // Create the client inside the function so it reads ANTHROPIC_API_KEY after dotenv has loaded
  const anthropic = new Anthropic();

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: "user", content: prompt }],
  });

  const block = message.content[0];
  if (block.type !== "text") throw new Error("Claude returned unexpected type");

  // Extract JSON from Claude's response
  const jsonMatch = block.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Could not parse Claude candidate pick: ${block.text}`);

  const result = JSON.parse(jsonMatch[0]);

  // Convert 1-based index to 0-based, or null if Claude said none
  return {
    pick: result.pick != null ? result.pick - 1 : null,
    servingWeightGrams: result.servingWeightGrams || 100,
    reason: result.reason || "",
  };
}

// Scale nutrient values by a multiplier - exported so cli.ts can use it for manual re-picks
export function scaleNutrients(nutrients: Nutrients, multiplier: number): Nutrients {
  const scaled = {} as Nutrients;
  for (const key of Object.keys(nutrients) as Array<keyof Nutrients>) {
    scaled[key] = Math.round(nutrients[key] * multiplier * 100) / 100;
  }
  return scaled;
}

// Ask Claude to estimate the full nutrient profile for a food it knows about
// Exported so cli.ts can call it directly for the "fresh Claude estimate" re-pick option
// Used when USDA doesn't have a good match (e.g. restaurant meals, specialty items)
export async function estimateWithClaude(food: ParsedFood): Promise<Nutrients> {
  // Create the client inside the function so it reads ANTHROPIC_API_KEY after dotenv has loaded
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

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });

  const block = message.content[0];
  if (block.type !== "text") throw new Error("Claude returned unexpected type");

  const jsonMatch = block.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Could not parse Claude nutrition estimate: ${block.text}`);

  // Merge Claude's response with empty defaults so any missing keys become 0
  return { ...emptyNutrients(), ...JSON.parse(jsonMatch[0]) };
}

// Enrich a single food item - exported so the CLI can call it for individual re-picks
// Returns the final entry and the raw USDA candidates (for interactive re-selection)
export async function enrichOneFood(food: ParsedFood): Promise<EnrichedResult> {
  // Step 1: Get top 5 USDA candidates
  const candidates = await searchFDC(food.name);

  let entry: FoodEntry;

  if (candidates.length === 0) {
    // No USDA results at all - go straight to Claude estimation
    console.log(`  ⚠ "${food.name}" not found in USDA, using Claude estimate`);
    const nutrients = await estimateWithClaude(food);
    entry = {
      id: crypto.randomUUID(),
      food_name: `${food.name} (${food.quantity} ${food.unit})`,
      fdc_id: null,
      fdc_description: null,
      serving_description: `${food.quantity} ${food.unit}`,
      source: "gpt_estimate",
      nutrients,
    };
  } else {
    // Step 2: Ask Claude to pick the best candidate
    const { pick, servingWeightGrams, reason } = await pickBestCandidate(food, candidates);

    if (pick !== null) {
      // Step 3: Use the USDA data, scaled to the actual serving weight
      // USDA Foundation/SR Legacy data is per 100g, so we scale by servingWeightGrams/100
      const chosen = candidates[pick];
      const multiplier = servingWeightGrams / 100;
      entry = {
        id: crypto.randomUUID(),
        food_name: `${food.name} (${food.quantity} ${food.unit})`,
        fdc_id: chosen.fdcId,
        fdc_description: chosen.description,
        serving_description: `${food.quantity} ${food.unit}`,
        source: "usda",
        nutrients: scaleNutrients(chosen.nutrients, multiplier),
      };
      console.log(`  ✓ "${food.name}" → USDA: ${chosen.description} (${servingWeightGrams}g serving)`);
    } else {
      // Step 4: No good USDA match - Claude estimates (restaurant item, etc.)
      console.log(`  ⚠ "${food.name}" - no USDA match, using Claude estimate`);
      const nutrients = await estimateWithClaude(food);
      entry = {
        id: crypto.randomUUID(),
        food_name: `${food.name} (${food.quantity} ${food.unit})`,
        fdc_id: null,
        fdc_description: null,
        serving_description: `${food.quantity} ${food.unit}`,
        source: "gpt_estimate",
        nutrients,
      };
    }
  }

  return { entry, candidates };
}

// Main function: enrich all parsed food items
// Returns each item with its final entry + USDA candidates for interactive re-pick in the CLI
export async function enrichFoods(parsedFoods: ParsedFood[]): Promise<EnrichedResult[]> {
  const results: EnrichedResult[] = [];
  for (const food of parsedFoods) {
    const result = await enrichOneFood(food);
    results.push(result);
  }
  return results;
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
