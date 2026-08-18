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

// Loads .env. Must be the first local import - see src/env.ts for why the ordering matters.
import "./env";
import fs from "fs";
import readline from "readline";
import { initLogger } from "./logger";
import { parseAndEnrich, estimateOne, sumNutrients } from "./enricher";
import { appendEntries, readDayLog, writeDayLog, buildDayLog, todayDateString, isValidDate } from "./store";
import { FoodEntry, ParsedFood, DayLog, LogBatch } from "./types";

// Initialize the logger in CLI mode (file only - stdout stays clean for interactive UI)
const logger = initLogger("cli");

// Format a possibly-unknown nutrient for display.
// null means Claude had no basis for a number, which is different from zero -
// showing "?" keeps that distinction visible instead of implying a measured 0.
function fmt(v: number | null | undefined, suffix = ""): string {
  if (v === null || v === undefined) return "?";
  return `${Math.round(v * 10) / 10}${suffix}`;
}

// Parse the command line arguments into a simple object
function parseArgs(): { text: string | null; file: string | null; date: string; user: string; yes: boolean } {
  const args = process.argv.slice(2);

  let text: string | null = null;
  let file: string | null = null;
  let date = todayDateString();
  let user = process.env.DEFAULT_USER || "default";
  let yes = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--food" && args[i + 1]) {
      text = args[++i];
    } else if (args[i] === "--file" && args[i + 1]) {
      file = args[++i];
    } else if (args[i] === "--date" && args[i + 1]) {
      date = args[++i];
    } else if (args[i] === "--user" && args[i + 1]) {
      user = args[++i];
    } else if (args[i] === "--yes") {
      yes = true;
    } else if (!args[i].startsWith("--")) {
      console.error(`Unknown argument: "${args[i]}". Did you mean --food "${args[i]}"?`);
      process.exit(1);
    }
  }

  // Catch a typo'd --date here rather than letting it create a junk day file
  // that then shows up in every date list and breaks the charts.
  if (!isValidDate(date)) {
    console.error(`Error: --date must be a real calendar date in YYYY-MM-DD form (got "${date}")`);
    process.exit(1);
  }

  return { text, file, date, user, yes };
}

// Prompt the user with a question and return their raw input as a string
function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Print a simple text table of food entries to the terminal
function printPreviewTable(entries: FoodEntry[]): void {
  const w = { name: 44, cals: 8, protein: 9, fat: 7, carbs: 7, source: 12 };

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

  entries.forEach((entry, i) => {
    const num = String(i + 1).padEnd(3);

    const name = entry.food_name.length > w.name - 2
      ? entry.food_name.slice(0, w.name - 5) + "..."
      : entry.food_name;

    // Legacy entries carry sources this app no longer produces; label them honestly
    // rather than passing 24 historical rows off as Claude estimates.
    const sourceLabel =
      entry.source === "water" ? "💧 Water"
      : entry.source === "usda" ? "USDA"
      : entry.source === "gpt_estimate" ? "GPT (old)"
      : "Claude est.";

    console.log(
      "  " + num +
      name.padEnd(w.name) +
      fmt(entry.nutrients.calories).padEnd(w.cals) +
      fmt(entry.nutrients.protein_g, "g").padEnd(w.protein) +
      fmt(entry.nutrients.fat_g, "g").padEnd(w.fat) +
      fmt(entry.nutrients.carbs_g, "g").padEnd(w.carbs) +
      sourceLabel
    );
  });

  const { totals } = sumNutrients(entries);

  console.log("─".repeat(93));
  console.log(
    "     " +
    "TOTAL".padEnd(w.name) +
    String(Math.round(totals.calories)).padEnd(w.cals) +
    `${totals.protein_g}g`.padEnd(w.protein) +
    `${totals.fat_g}g`.padEnd(w.fat) +
    `${totals.carbs_g}g`
  );
  console.log("─".repeat(93) + "\n");
}

// Recover the structured parse for an entry so it can be re-estimated.
//
// Entries written by schema v2 carry `parsed` directly. For older ones we fall back to
// splitting serving_description, and deliberately keep any parenthetical qualifier in the
// name: the old regex stripped "(full bag)" from "Jack Link's Beef Jerky (full bag)",
// so re-estimating silently re-priced it as a standard 1 oz serving.
function parsedFoodFromEntry(entry: FoodEntry): ParsedFood {
  if (entry.parsed) return entry.parsed;

  const match = entry.serving_description.match(/^([\d.]+)\s+(.+)$/);
  // Strip only the trailing serving parenthetical that food_name is built with,
  // e.g. "... (3 stick)" - not descriptive ones like "(full bag)".
  const name = entry.food_name.replace(/\s*\([\d.]+\s+[^()]*\)$/, "").trim() || entry.food_name;

  if (match) {
    return { name, quantity: parseFloat(match[1]), unit: match[2] };
  }
  return { name, quantity: 1, unit: "serving" };
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
    .filter((n) => !isNaN(n) && n >= 1 && n <= entries.length);

  if (deleteNums.length > 0) {
    const deleteSet = new Set(deleteNums);
    const removed = entries.filter((_, i) => deleteSet.has(i + 1));
    entries = entries.filter((_, i) => !deleteSet.has(i + 1));
    for (const entry of removed) {
      console.log(`  ✕ Removed: ${entry.food_name}`);
    }
    logger.info({ deletedItems: deleteNums, deletedNames: removed.map((e) => e.food_name) },
      "cli: deleted entries from existing log");

    if (entries.length === 0) {
      console.log("\n  All entries removed.");
      const confirm = await promptLine("Save empty log? [Y/n] ");
      if (confirm.trim().toLowerCase() === "n") {
        console.log("Cancelled. No changes saved.");
        return null;
      }
      return entries;
    }

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
      .filter((n) => !isNaN(n) && n >= 1 && n <= entries.length);

    if (fixNums.length > 0) {
      logger.info({ fixItems: fixNums }, "cli: fixing entries in existing log");
      for (const num of fixNums) {
        const idx = num - 1;
        const parsedFood = parsedFoodFromEntry(entries[idx]);
        // entry.batch_id -> batches[].transcript recovers what was originally said, so a
        // re-estimate is not working from the display string we generated.
        const batchId = entries[idx].batch_id;
        const transcript = batchId
          ? existing.batches.find((b) => b.batch_id === batchId)?.transcript
          : undefined;
        const result = await repickEntry(num, parsedFood, entries[idx], transcript);
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
async function repickEntry(
  itemNumber: number,
  parsedFood: ParsedFood,
  currentEntry: FoodEntry,
  // The text this whole batch was parsed from. Passed down so a re-estimate sees what the
  // user actually said, not just the display string we built from it.
  transcript?: string,
): Promise<{ entry: FoodEntry; parsedFood: ParsedFood }> {
  const n = currentEntry.nutrients;
  console.log(`\nFix item #${itemNumber}: ${currentEntry.food_name}`);
  console.log("─".repeat(70));
  console.log(`  Current: ${fmt(n.calories)} cal | ${fmt(n.protein_g)}g P | ${fmt(n.fat_g)}g F | ${fmt(n.carbs_g)}g C`);
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
    logger.info({ action: "repick_edit", itemNumber, oldName: parsedFood.name, newName: updatedFood.name },
      "repick: editing food description");
    const nutrients = await estimateOne(updatedFood, { transcript });
    console.log(`  ✓ ${fmt(nutrients.calories)} cal`);
    return {
      entry: {
        ...currentEntry,
        id: crypto.randomUUID(),
        food_name: `${updatedFood.name} (${updatedFood.quantity} ${updatedFood.unit})`,
        source: "claude_estimate",
        nutrients,
        parsed: updatedFood,
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
    logger.info({ action: "repick_serving", itemNumber, food: parsedFood.name, newQty, newUnit: updatedFood.unit },
      "repick: changing serving size");
    const nutrients = await estimateOne(updatedFood, { transcript });
    console.log(`  ✓ ${fmt(nutrients.calories)} cal`);
    return {
      entry: {
        ...currentEntry,
        id: crypto.randomUUID(),
        food_name: `${updatedFood.name} (${updatedFood.quantity} ${updatedFood.unit})`,
        serving_description: `${updatedFood.quantity} ${updatedFood.unit}`,
        source: "claude_estimate",
        nutrients,
        parsed: updatedFood,
      },
      parsedFood: updatedFood,
    };
  }

  // Re-roll: fresh estimate with the same description
  if (pickNum === 3) {
    console.log("  Getting fresh Claude estimate...");
    logger.info({ action: "repick_reroll", itemNumber, food: parsedFood.name }, "repick: re-estimating");
    const nutrients = await estimateOne(parsedFood, { transcript });
    console.log(`  ✓ ${fmt(nutrients.calories)} cal`);
    return {
      entry: {
        ...currentEntry,
        id: crypto.randomUUID(),
        source: "claude_estimate",
        nutrients,
        parsed: parsedFood,
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
      console.log(`\n${existingForEdit.entries.length} entries for ${args.date} (${Math.round(existingForEdit.daily_totals.calories)} cal)`);
      const editAnswer = await promptLine("Edit existing entries? [Y/n] ");
      if (editAnswer.trim().toLowerCase() !== "n") {
        const edited = await editExistingLog(existingForEdit);
        if (edited !== null) {
          const editedLog = buildDayLog(args.user, args.date, edited, existingForEdit.batches);
          const editPath = writeDayLog(editedLog);
          console.log(`\n✓ Saved edited log to ${editPath}`);
          console.log(`  Day total: ${edited.length} entries, ${Math.round(editedLog.daily_totals.calories)} kcal`);
          logger.info({ filePath: editPath, entryCount: edited.length, totalCalories: Math.round(editedLog.daily_totals.calories) },
            "cli: saved edited existing log (no new text)");
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

  let overwrite = false;

  if (existing && !args.yes) {
    console.log(`\n⚠  You already have ${existing.entries.length} entries for ${args.date} (${Math.round(existing.daily_totals.calories)} cal)`);
    const answer = await promptLine("(A)ppend new entries or (O)verwrite the whole day? [A]: ");
    overwrite = answer.trim().toLowerCase() === "o";
    console.log(overwrite ? "Will overwrite the existing day log after confirmation." : "Will append new entries to the existing log.");
  }

  console.log(`\nLogging food for ${args.user} on ${args.date}`);
  console.log("Parsing and estimating nutrition with Claude...");

  logger.info({ user: args.user, date: args.date, inputLength: foodText.length, autoConfirm: args.yes },
    "cli: starting food log");

  const result = await parseAndEnrich(foodText, { userId: args.user });
  const parsedFoods = result.parsedFoods;
  let entries: FoodEntry[] = result.entries;

  // A parse that found nothing should say so, not save an empty log and report success.
  if (entries.length === 0) {
    console.log("\nI couldn't pick out any food from that. Nothing was saved.");
    logger.info("cli: parse returned zero items");
    process.exit(0);
  }

  console.log(`Found ${entries.length} food items.`);
  logger.info({ entryCount: entries.length }, "cli: parsing complete");

  printPreviewTable(entries);

  if (!args.yes) {
    console.log("Items to fix? Enter item numbers separated by spaces (e.g. '2 3')");
    const repickInput = await promptLine("or press Enter to confirm all: ");

    const repickNums = repickInput
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((n) => !isNaN(n) && n >= 1 && n <= entries.length);

    if (repickNums.length > 0) {
      logger.info({ repickItems: repickNums }, "cli: user requested re-picks");
    }

    for (const num of repickNums) {
      const idx = num - 1;
      const r = await repickEntry(num, parsedFoods[idx], entries[idx], foodText);
      entries[idx] = r.entry;
      parsedFoods[idx] = r.parsedFood;
    }

    if (repickNums.length > 0) {
      console.log("\nUpdated preview:");
      printPreviewTable(entries);
    }

    const answer = await promptLine("Log these entries? [Y/n] ");
    if (answer.trim().toLowerCase() === "n") {
      console.log("Cancelled. Nothing was saved.");
      logger.info("cli: user cancelled");
      process.exit(0);
    }
  }

  // Keep the raw text alongside the entries it produced, so the web UI can show
  // "you said X, we logged Y" for anything logged from the terminal too.
  const batch: LogBatch = {
    batch_id: crypto.randomUUID(),
    logged_at: new Date().toISOString(),
    transcript: foodText,
    entry_count: entries.length,
  };
  entries = entries.map((e) => ({ ...e, batch_id: batch.batch_id }));

  let filePath: string;
  let log: DayLog;

  if (overwrite) {
    log = buildDayLog(args.user, args.date, entries, [batch]);
    filePath = writeDayLog(log);
    console.log(`\n✓ Overwrote ${filePath}`);
  } else {
    ({ log, filePath } = appendEntries(args.user, args.date, entries, batch));
    console.log(`\n✓ Logged ${entries.length} new entries to ${filePath}`);
  }

  console.log(`  Day total (${args.date}): ${log.entries.length} entries, ${Math.round(log.daily_totals.calories)} kcal`);
  const { totals } = sumNutrients(entries);
  console.log(`  New entries: Protein ${totals.protein_g}g  |  Fat ${totals.fat_g}g  |  Carbs ${totals.carbs_g}g\n`);

  logger.info({ filePath, totalEntries: log.entries.length, totalCalories: Math.round(log.daily_totals.calories), overwrite },
    "cli: entries saved");
}

// Run main and catch any unhandled errors
main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, "cli: unhandled error");
  console.error("\nError:", err.message);
  process.exit(1);
});
