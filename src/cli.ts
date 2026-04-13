// cli.ts
// Interactive command-line interface for VoiceBite
// Run with: npm start "I ate 2 eggs and toast for breakfast..."
// Or:       npm start -- --file ~/notes/today.txt
//
// Flags:
//   --file <path>        Read food text from a file instead of an inline argument
//   --date <YYYY-MM-DD>  Log to a specific date (default: today)
//   --user <name>        Which user to log as (default: DEFAULT_USER in .env)
//   --yes                Skip all prompts and save immediately

// Load .env file - override: true means .env always wins over shell env vars
import dotenv from "dotenv";
dotenv.config({ override: true });
import fs from "fs";
import readline from "readline";
import { parseFood } from "./parser";
import { enrichFoods, scaleNutrients, estimateWithClaude } from "./enricher";
import { sumNutrients } from "./enricher";
import { appendEntries, readDayLog, writeDayLog, todayDateString } from "./store";
import { FoodEntry, EnrichedResult, ParsedFood, DayLog } from "./types";

// Parse the command line arguments into a simple object
// We're doing this manually instead of using a library - the CLI is simple enough
function parseArgs(): { text: string | null; file: string | null; date: string; user: string; yes: boolean } {
  const args = process.argv.slice(2); // Drop "node" and the script path

  let text: string | null = null;
  let file: string | null = null;
  let date = todayDateString();
  let user = process.env.DEFAULT_USER || "default";
  let yes = false;

  // Walk through the args array looking for flags and their values
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) {
      file = args[++i]; // Grab the next arg as the file path
    } else if (args[i] === "--date" && args[i + 1]) {
      date = args[++i];
    } else if (args[i] === "--user" && args[i + 1]) {
      user = args[++i];
    } else if (args[i] === "--yes") {
      yes = true;
    } else if (!args[i].startsWith("--")) {
      // Any non-flag argument is treated as the food text
      text = args[i];
    }
  }

  return { text, file, date, user, yes };
}

// Prompt the user with a question and return their raw input as a string
// This is the single readline utility used for all user input in this file
function promptLine(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

// Print a simple text table of food entries to the terminal
// No external table library - just padEnd() to align columns
function printPreviewTable(entries: FoodEntry[]): void {
  const w = { name: 44, cals: 8, protein: 9, fat: 7, carbs: 7, source: 12 };

  // Header
  console.log("\n" + "─".repeat(93));
  console.log(
    "  #  " +
    "Food".padEnd(w.name) +
    "Cals".padEnd(w.cals) +
    "Protein".padEnd(w.protein) +
    "Fat".padEnd(w.fat) +
    "Carbs".padEnd(w.carbs) +
    "Source"
  );
  console.log("─".repeat(93));

  // One row per entry, with a number so user can reference it for re-picks
  entries.forEach((entry, i) => {
    const num = String(i + 1).padEnd(3); // Item number (1-indexed)

    const name = entry.food_name.length > w.name - 2
      ? entry.food_name.slice(0, w.name - 5) + "..."
      : entry.food_name;

    const source = entry.source === "gpt_estimate" ? "⚠ Claude est." : "USDA";

    console.log(
      "  " + num +
      name.padEnd(w.name) +
      String(Math.round(entry.nutrients.calories)).padEnd(w.cals) +
      `${entry.nutrients.protein_g}g`.padEnd(w.protein) +
      `${entry.nutrients.fat_g}g`.padEnd(w.fat) +
      `${entry.nutrients.carbs_g}g`.padEnd(w.carbs) +
      source
    );
  });

  // Totals row
  const t = {
    cals: entries.reduce((s, e) => s + e.nutrients.calories, 0),
    protein: entries.reduce((s, e) => s + e.nutrients.protein_g, 0),
    fat: entries.reduce((s, e) => s + e.nutrients.fat_g, 0),
    carbs: entries.reduce((s, e) => s + e.nutrients.carbs_g, 0),
  };

  console.log("─".repeat(93));
  console.log(
    "     " +
    "TOTAL".padEnd(w.name) +
    String(Math.round(t.cals)).padEnd(w.cals) +
    `${Math.round(t.protein * 10) / 10}g`.padEnd(w.protein) +
    `${Math.round(t.fat * 10) / 10}g`.padEnd(w.fat) +
    `${Math.round(t.carbs * 10) / 10}g`
  );
  console.log("─".repeat(93) + "\n");
}

// Interactive re-pick flow for a single entry
// Shows the user the USDA candidates and a Claude estimate option, lets them pick
// Returns the updated FoodEntry (or the same one if user kept current)
async function repickEntry(
  itemNumber: number,
  parsedFood: ParsedFood,
  result: EnrichedResult
): Promise<FoodEntry> {
  console.log(`\nAlternatives for item #${itemNumber}: ${result.entry.food_name}`);
  console.log("─".repeat(70));

  // Show the USDA candidates we found earlier
  if (result.candidates.length === 0) {
    console.log("  (No USDA candidates found for this food)");
  } else {
    result.candidates.forEach((c, i) => {
      // Show a brief calorie hint so the user can judge the match
      const calHint = c.nutrients.calories > 0 ? ` — ${c.nutrients.calories} cal/100g` : "";
      console.log(`  [${i + 1}] ${c.description} (${c.dataType}, FDC ${c.fdcId}${calHint})`);
    });
  }

  // Always offer a fresh Claude estimate option
  console.log(`  [${result.candidates.length + 1}] Get a fresh Claude estimate for this item`);
  console.log(`  [0] Keep current entry`);

  const pickStr = await promptLine(`\nChoose (0-${result.candidates.length + 1}): `);
  const pickNum = parseInt(pickStr.trim());

  // User pressed Enter or typed 0 → keep the current entry
  if (isNaN(pickNum) || pickNum === 0) {
    console.log("  Keeping current entry.");
    return result.entry;
  }

  // User picked a specific USDA candidate
  if (pickNum >= 1 && pickNum <= result.candidates.length) {
    const chosen = result.candidates[pickNum - 1];
    // Ask for serving weight so we can scale the per-100g USDA data correctly
    const gramsStr = await promptLine(
      `  Estimated serving weight in grams for "${parsedFood.quantity} ${parsedFood.unit}" (press Enter for 100g): `
    );
    const grams = parseInt(gramsStr.trim()) || 100;

    // Scale the USDA per-100g nutrients to this serving weight
    const scaled = scaleNutrients(chosen.nutrients, grams / 100);

    console.log(`  ✓ Updated to: ${chosen.description} (${grams}g serving, ${Math.round(scaled.calories)} cal)`);
    return {
      ...result.entry,
      id: crypto.randomUUID(), // New ID for the updated entry
      fdc_id: chosen.fdcId,
      fdc_description: chosen.description,
      source: "usda",
      nutrients: scaled,
    };
  }

  // User chose the Claude estimate option
  if (pickNum === result.candidates.length + 1) {
    console.log("  Getting Claude estimate...");
    const nutrients = await estimateWithClaude(parsedFood);
    console.log(`  ✓ Claude estimate: ${Math.round(nutrients.calories)} cal`);
    return {
      ...result.entry,
      id: crypto.randomUUID(),
      fdc_id: null,
      fdc_description: null,
      source: "gpt_estimate",
      nutrients,
    };
  }

  // Invalid input - keep current
  console.log("  Invalid choice, keeping current entry.");
  return result.entry;
}

// The main function - orchestrates the whole CLI flow
async function main(): Promise<void> {
  const args = parseArgs();

  // Figure out where the food text is coming from
  let foodText: string | null = null;

  if (args.file) {
    if (!fs.existsSync(args.file)) {
      console.error(`Error: File not found: ${args.file}`);
      process.exit(1);
    }
    foodText = fs.readFileSync(args.file, "utf-8").trim();
    console.log(`Reading food log from: ${args.file}`);
  } else if (args.text) {
    foodText = args.text;
  }

  // No text provided - print usage and exit
  if (!foodText || foodText.length === 0) {
    console.log(`
VoiceBite - Log food from natural language text

Usage:
  npm start "2 eggs scrambled, toast with butter, chipotle chicken burrito bowl, 6oz salmon"
  npm start -- --file ~/notes/today.txt
  npm start -- --file today.txt --date 2026-04-10
  npm start -- --yes "everything I ate today..."

Flags:
  --file <path>        Read food text from a file
  --date <YYYY-MM-DD>  Log to a specific date (default: today)
  --user <name>        User to log as (default: ${process.env.DEFAULT_USER || "default"})
  --yes                Skip all prompts and save immediately
`);
    process.exit(0);
  }

  // Check if there's already a food log for this date before doing any AI calls
  const existing = readDayLog(args.user, args.date);

  // Track whether we'll append to or overwrite the existing day log
  let overwrite = false;

  if (existing && !args.yes) {
    // Warn the user and ask what they want to do
    console.log(`\n⚠  You already have ${existing.entries.length} entries for ${args.date} (${Math.round(existing.daily_totals.calories)} cal)`);
    const answer = await promptLine("(A)ppend new entries or (O)verwrite the whole day? [A]: ");
    overwrite = answer.trim().toLowerCase() === "o";
    if (overwrite) {
      console.log("Will overwrite the existing day log after confirmation.");
    } else {
      console.log("Will append new entries to the existing log.");
    }
  }

  console.log(`\nLogging food for ${args.user} on ${args.date}`);
  console.log("Parsing food text with Claude...");

  // Step 1: Parse the free-form text into individual food items
  const parsedFoods: ParsedFood[] = await parseFood(foodText);
  console.log(`Found ${parsedFoods.length} food items. Looking up nutrition data...`);

  // Step 2: Enrich each item (USDA FDC + Claude smart matching)
  const results: EnrichedResult[] = await enrichFoods(parsedFoods);

  // Extract just the FoodEntry objects for display
  let entries: FoodEntry[] = results.map(r => r.entry);

  // Step 3: Show the preview table
  printPreviewTable(entries);

  // Step 4: Interactive review - skip if --yes was passed
  if (!args.yes) {
    // Ask if any entries need to be replaced with different options
    console.log("Items to fix? Enter item numbers separated by spaces (e.g. '2 3')");
    const repickInput = await promptLine("or press Enter to confirm all: ");

    // Parse the numbers the user entered
    const repickNums = repickInput
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter(n => !isNaN(n) && n >= 1 && n <= results.length);

    // Walk through each requested re-pick and let the user choose an alternative
    for (const num of repickNums) {
      const idx = num - 1;
      results[idx].entry = await repickEntry(num, parsedFoods[idx], results[idx]);
    }

    // If any entries were changed, show the updated table
    if (repickNums.length > 0) {
      entries = results.map(r => r.entry);
      console.log("\nUpdated preview:");
      printPreviewTable(entries);
    }

    // Final confirmation before saving
    const answer = await promptLine("Log these entries? [Y/n] ");
    if (answer.trim().toLowerCase() === "n") {
      console.log("Cancelled. Nothing was saved.");
      process.exit(0);
    }
  }

  // Step 5: Save to the day log file
  entries = results.map(r => r.entry);
  let filePath: string;
  let totalCalories: number;
  let totalEntryCount: number;

  if (overwrite) {
    // Overwrite mode: build a fresh day log with only the new entries
    const dailyTotals = sumNutrients(entries);
    const log: DayLog = { date: args.date, userId: args.user, entries, daily_totals: dailyTotals };
    filePath = writeDayLog(log);
    totalCalories = Math.round(dailyTotals.calories);
    totalEntryCount = entries.length;
    console.log(`\n✓ Overwrote ${filePath}`);
  } else {
    // Append mode: merge with any existing entries for the day
    const { log, filePath: fp } = appendEntries(args.user, args.date, entries);
    filePath = fp;
    totalCalories = Math.round(log.daily_totals.calories);
    totalEntryCount = log.entries.length;
    console.log(`\n✓ Logged ${entries.length} new entries to ${filePath}`);
  }

  console.log(`  Day total (${args.date}): ${totalEntryCount} entries, ${totalCalories} kcal`);
  const totals = sumNutrients(entries);
  console.log(`  New entries: Protein ${totals.protein_g}g  |  Fat ${totals.fat_g}g  |  Carbs ${totals.carbs_g}g\n`);
}

// Run main and catch any unhandled errors
main().catch(err => {
  console.error("\nError:", err.message);
  process.exit(1);
});
