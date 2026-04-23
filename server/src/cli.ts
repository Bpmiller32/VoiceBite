// cli.ts
// Interactive command-line interface for VoiceBite
// Run with: npm start -- --food "I ate 2 eggs and toast for breakfast..."
// Or:       npm start -- --file ~/notes/today.txt
// Edit:     npm start -- --date 2026-04-18
//
// Flags:
//   --food <text>        Food description to log
//   --file <path>        Read food text from a file instead of inline
//   --date <YYYY-MM-DD>  Log to a specific date (default: today)
//   --user <name>        Which user to log as (default: DEFAULT_USER in .env)
//   --yes                Skip all prompts and save immediately

// Load .env file - override: true means .env always wins over shell env vars
import dotenv from "dotenv";
dotenv.config({ override: true });
import fs from "fs";
import readline from "readline";
import { initLogger } from "./logger";
import { parseAndEnrich, estimateWithClaude, sumNutrients } from "./enricher";
import { appendEntries, readDayLog, writeDayLog, todayDateString } from "./store";
import { FoodEntry, ParsedFood, DayLog } from "./types";

// Initialize the logger in CLI mode (file only - stdout stays clean for interactive UI)
const logger = initLogger("cli");

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
    if (args[i] === "--food" && args[i + 1]) {
      text = args[++i];
    } else if (args[i] === "--file" && args[i + 1]) {
      file = args[++i]; // Grab the next arg as the file path
    } else if (args[i] === "--date" && args[i + 1]) {
      date = args[++i];
    } else if (args[i] === "--user" && args[i + 1]) {
      user = args[++i];
    } else if (args[i] === "--yes") {
      yes = true;
    } else if (!args[i].startsWith("--")) {
      // Warn about bare arguments - all args should use flags
      console.error(`Unknown argument: "${args[i]}". Did you mean --food "${args[i]}"?`);
      process.exit(1);
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

    // Show the source label - water gets a special label since it always has 0 calories
    const source = entry.source === "water" ? "💧 Water" : "Claude est.";

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

// Extract a ParsedFood from an existing FoodEntry so we can re-estimate it
// Parses the serving_description ("2 large egg") into quantity + unit
function parsedFoodFromEntry(entry: FoodEntry): ParsedFood {
  const desc = entry.serving_description;
  const match = desc.match(/^([\d.]+)\s+(.+)$/);
  if (match) {
    // Strip the parenthetical serving info from food_name to get the clean name
    const name = entry.food_name.replace(/\s*\(.*\)$/, "");
    return { name, quantity: parseFloat(match[1]), unit: match[2] };
  }
  return { name: entry.food_name, quantity: 1, unit: "serving" };
}

// Edit existing day log - lets user delete and/or re-estimate entries
// Returns the modified entries array, or null if the user cancelled
async function editExistingLog(existing: DayLog): Promise<FoodEntry[] | null> {
  let entries = [...existing.entries];

  console.log(`\nExisting entries for ${existing.date}:`);
  printPreviewTable(entries);

  // Step 1: Delete entries
  console.log("Items to delete? Enter numbers (e.g. '2 4') or press Enter to skip:");
  const deleteInput = await promptLine("> ");
  const deleteNums = deleteInput
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter(n => !isNaN(n) && n >= 1 && n <= entries.length);

  if (deleteNums.length > 0) {
    // Sort descending so removing by index doesn't shift later indices
    const deleteSet = new Set(deleteNums);
    const removed = entries.filter((_, i) => deleteSet.has(i + 1));
    entries = entries.filter((_, i) => !deleteSet.has(i + 1));
    for (const entry of removed) {
      console.log(`  ✕ Removed: ${entry.food_name}`);
    }
    logger.info({ deletedItems: deleteNums, deletedNames: removed.map(e => e.food_name) }, "cli: deleted entries from existing log");

    if (entries.length === 0) {
      console.log("\n  All entries removed.");
      const confirm = await promptLine("Save empty log? [Y/n] ");
      if (confirm.trim().toLowerCase() === "n") {
        console.log("Cancelled. No changes saved.");
        return null;
      }
      return entries;
    }

    // Re-print after deletions so numbers are fresh for the fix step
    console.log("\nAfter deletions:");
    printPreviewTable(entries);
  }

  // Step 2: Fix entries (re-estimate)
  if (entries.length > 0) {
    console.log("Items to fix? Enter numbers (e.g. '1 3') or press Enter to skip:");
    const fixInput = await promptLine("> ");
    const fixNums = fixInput
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter(n => !isNaN(n) && n >= 1 && n <= entries.length);

    if (fixNums.length > 0) {
      logger.info({ fixItems: fixNums }, "cli: fixing entries in existing log");
      for (const num of fixNums) {
        const idx = num - 1;
        const parsedFood = parsedFoodFromEntry(entries[idx]);
        const result = await repickEntry(num, parsedFood, entries[idx]);
        entries[idx] = result.entry;
      }

      console.log("\nAfter fixes:");
      printPreviewTable(entries);
    }
  }

  // Step 3: Confirm
  const answer = await promptLine("Save changes to existing log? [Y/n] ");
  if (answer.trim().toLowerCase() === "n") {
    console.log("Cancelled. No changes saved.");
    return null;
  }

  return entries;
}

// Interactive re-pick flow for a single entry
// Lets the user correct the food description, adjust the serving, or re-roll the estimate
// Returns the updated FoodEntry and (possibly modified) ParsedFood
async function repickEntry(
  itemNumber: number,
  parsedFood: ParsedFood,
  currentEntry: FoodEntry
): Promise<{ entry: FoodEntry; parsedFood: ParsedFood }> {
  console.log(`\nFix item #${itemNumber}: ${currentEntry.food_name}`);
  console.log("─".repeat(70));
  console.log(`  Current: ${Math.round(currentEntry.nutrients.calories)} cal | ${currentEntry.nutrients.protein_g}g P | ${currentEntry.nutrients.fat_g}g F | ${currentEntry.nutrients.carbs_g}g C`);
  console.log(`  [1] Edit food description (e.g. "chicken burrito bowl with guac and rice")`);
  console.log(`  [2] Change serving size (currently: ${parsedFood.quantity} ${parsedFood.unit})`);
  console.log(`  [3] Re-estimate with same description`);
  console.log(`  [0] Keep current entry`);

  const pickStr = await promptLine(`\nChoose (0-3): `);
  const pickNum = parseInt(pickStr.trim());

  // Edit the food description and re-estimate
  if (pickNum === 1) {
    const newName = await promptLine(`  New food description: `);
    if (!newName.trim()) {
      console.log("  No change, keeping current entry.");
      return { entry: currentEntry, parsedFood };
    }
    const updatedFood: ParsedFood = { ...parsedFood, name: newName.trim() };
    console.log("  Getting Claude estimate...");
    logger.info({ action: "repick_edit", itemNumber, oldName: parsedFood.name, newName: updatedFood.name }, "repick: editing food description");
    const nutrients = await estimateWithClaude(updatedFood);
    console.log(`  ✓ ${Math.round(nutrients.calories)} cal`);
    return {
      entry: {
        ...currentEntry,
        id: crypto.randomUUID(),
        food_name: `${updatedFood.name} (${updatedFood.quantity} ${updatedFood.unit})`,
        source: "claude_estimate",
        nutrients,
      },
      parsedFood: updatedFood,
    };
  }

  // Change the serving size and re-estimate
  if (pickNum === 2) {
    const newQtyStr = await promptLine(`  New quantity (currently ${parsedFood.quantity}): `);
    const newUnit = await promptLine(`  New unit (currently "${parsedFood.unit}", press Enter to keep): `);
    const newQty = parseFloat(newQtyStr.trim());
    if (isNaN(newQty) || newQty <= 0) {
      console.log("  Invalid quantity, keeping current entry.");
      return { entry: currentEntry, parsedFood };
    }
    const updatedFood: ParsedFood = {
      ...parsedFood,
      quantity: newQty,
      unit: newUnit.trim() || parsedFood.unit,
    };
    console.log("  Getting Claude estimate...");
    logger.info({ action: "repick_serving", itemNumber, food: parsedFood.name, oldQty: parsedFood.quantity, oldUnit: parsedFood.unit, newQty, newUnit: updatedFood.unit }, "repick: changing serving size");
    const nutrients = await estimateWithClaude(updatedFood);
    console.log(`  ✓ ${Math.round(nutrients.calories)} cal`);
    return {
      entry: {
        ...currentEntry,
        id: crypto.randomUUID(),
        food_name: `${updatedFood.name} (${updatedFood.quantity} ${updatedFood.unit})`,
        serving_description: `${updatedFood.quantity} ${updatedFood.unit}`,
        source: "claude_estimate",
        nutrients,
      },
      parsedFood: updatedFood,
    };
  }

  // Re-roll: fresh estimate with the same description
  if (pickNum === 3) {
    console.log("  Getting fresh Claude estimate...");
    logger.info({ action: "repick_reroll", itemNumber, food: parsedFood.name }, "repick: re-estimating");
    const nutrients = await estimateWithClaude(parsedFood);
    console.log(`  ✓ ${Math.round(nutrients.calories)} cal`);
    return {
      entry: {
        ...currentEntry,
        id: crypto.randomUUID(),
        source: "claude_estimate",
        nutrients,
      },
      parsedFood,
    };
  }

  console.log("  Keeping current entry.");
  return { entry: currentEntry, parsedFood };
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

  // No text provided - check if there's an existing log to edit, otherwise show usage
  if (!foodText || foodText.length === 0) {
    const existingForEdit = readDayLog(args.user, args.date);
    if (existingForEdit) {
      // No new food text, but existing log exists - offer to edit it
      console.log(`\n${existingForEdit.entries.length} entries for ${args.date} (${Math.round(existingForEdit.daily_totals.calories)} cal)`);
      const editAnswer = await promptLine("Edit existing entries? [Y/n] ");
      if (editAnswer.trim().toLowerCase() !== "n") {
        const edited = await editExistingLog(existingForEdit);
        if (edited !== null) {
          const dailyTotals = sumNutrients(edited);
          const editedLog: DayLog = { date: args.date, userId: args.user, entries: edited, daily_totals: dailyTotals };
          const editPath = writeDayLog(editedLog);
          console.log(`\n✓ Saved edited log to ${editPath}`);
          console.log(`  Day total: ${edited.length} entries, ${Math.round(dailyTotals.calories)} kcal`);
          logger.info({ filePath: editPath, entryCount: edited.length, totalCalories: Math.round(dailyTotals.calories) }, "cli: saved edited existing log (no new text)");
        }
      }
      process.exit(0);
    }

    console.log(`
VoiceBite - Log food from natural language text

Usage:
  npm start -- --food "2 eggs scrambled, toast with butter, chipotle burrito bowl"
  npm start -- --file ~/notes/today.txt
  npm start -- --date 2026-04-18 --food "6oz salmon for dinner"
  npm start -- --date 2026-04-18                          # edit existing day
  npm start -- --yes --food "everything I ate today..."

Flags:
  --food <text>        Food description to log
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
  console.log("Parsing and estimating nutrition with Claude...");

  logger.info({ user: args.user, date: args.date, inputLength: foodText.length, autoConfirm: args.yes }, "cli: starting food log");

  // Step 1+2 combined: Parse the text AND estimate nutrients in a single Claude call
  const result = await parseAndEnrich(foodText);
  const parsedFoods = result.parsedFoods;
  let entries: FoodEntry[] = result.entries;
  console.log(`Found ${entries.length} food items.`);

  logger.info({ entryCount: entries.length }, "cli: parsing complete");

  // Step 3: Show the preview table
  printPreviewTable(entries);

  // Step 4: Interactive review - skip if --yes was passed
  if (!args.yes) {
    // Ask if any entries need to be re-estimated
    console.log("Items to fix? Enter item numbers separated by spaces (e.g. '2 3')");
    const repickInput = await promptLine("or press Enter to confirm all: ");

    // Parse the numbers the user entered
    const repickNums = repickInput
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter(n => !isNaN(n) && n >= 1 && n <= entries.length);

    if (repickNums.length > 0) {
      logger.info({ repickItems: repickNums }, "cli: user requested re-picks");
    }

    // Walk through each requested re-pick and let the user choose
    for (const num of repickNums) {
      const idx = num - 1;
      const result = await repickEntry(num, parsedFoods[idx], entries[idx]);
      entries[idx] = result.entry;
      parsedFoods[idx] = result.parsedFood;
    }

    // If any entries were changed, show the updated table
    if (repickNums.length > 0) {
      console.log("\nUpdated preview:");
      printPreviewTable(entries);
    }

    // Final confirmation before saving
    const answer = await promptLine("Log these entries? [Y/n] ");
    if (answer.trim().toLowerCase() === "n") {
      console.log("Cancelled. Nothing was saved.");
      logger.info("cli: user cancelled");
      process.exit(0);
    }
  }

  // Step 5: Save to the day log file
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

  logger.info({ filePath, totalEntries: totalEntryCount, totalCalories, overwrite }, "cli: entries saved");
}

// Run main and catch any unhandled errors
main().catch(err => {
  logger.error({ err: err.message, stack: err.stack }, "cli: unhandled error");
  console.error("\nError:", err.message);
  process.exit(1);
});
