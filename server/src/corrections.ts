// corrections.ts
// An append-only record of every time the user disagreed with an estimate.
//
// This is the most valuable signal the app produces and it was being thrown away. Across
// the fourteen v2 batches, 32 entries were produced and 23 survived - a 28.1% discard
// rate. Two whole batches on 2026-08-12 were deleted outright. Every one of those was the
// user looking at a number and saying "no", and none of it was written down.
//
// It earns its place three ways:
//
// - A correction on a pantry-resolved item teaches the pantry permanently. The user fixes
//   a value once and it is pinned as verified_by: "owner", which no later automated lookup
//   may overwrite.
// - It is the only evaluation set that reflects THIS person's actual foods. A gold set
//   assembled from manufacturer pages tests the lookup; this tests the whole pipeline
//   against the one judge who matters.
// - It makes systematic drift visible. One bad estimate is noise; the same food corrected
//   downward four times is a pattern worth acting on.
//
// JSONL rather than a JSON array: appends are a single write with no read-modify-write, so
// a crash mid-write costs at most the last line rather than the whole history.

import fs from "fs";
import path from "path";
import { FoodEntry, Nutrients, NUTRIENT_KEYS, CORE_NUTRIENT_KEYS } from "./types";
import { userFilePath } from "./store";
import { getLogger } from "./logger";
import { readPantry, upsertItem } from "./pantry";

export type CorrectionAction = "edited_in_preview" | "dropped_in_preview" | "edited" | "deleted";

export interface Correction {
  ts: string;
  date: string;
  action: CorrectionAction;
  entry_id: string;
  food_name: string;
  /** What the user originally said, when it can be recovered. */
  transcript?: string;
  /** Set when the corrected entry came from the food library. */
  pantry_key?: string;
  /** Where the numbers came from before the user touched them. */
  source?: string;
  /** Only the macros that actually changed, old -> new. */
  changed?: Record<string, { from: number | null; to: number | null }>;
}

function correctionsPath(userId: string): string {
  return userFilePath(userId, "corrections.jsonl");
}

/** Macros only. A micronutrient the user never sees is not a judgement they made. */
const TRACKED = CORE_NUTRIENT_KEYS;

/** What changed between two nutrient sets, among the values the user can actually see. */
export function diffNutrients(before: Nutrients, after: Nutrients): Correction["changed"] {
  const changed: NonNullable<Correction["changed"]> = {};
  for (const key of TRACKED) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (from !== to) changed[key] = { from, to };
  }
  return Object.keys(changed).length > 0 ? changed : undefined;
}

/**
 * Append one correction. Never throws - losing the audit trail must not fail the write
 * the user actually asked for.
 */
export function recordCorrection(userId: string, correction: Correction): void {
  const log = getLogger();
  try {
    const filePath = correctionsPath(userId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(correction)}\n`, "utf-8");
    log.info(
      { action: correction.action, food: correction.food_name, changed: correction.changed },
      "recorded a correction",
    );
  } catch (err) {
    log.warn({ err, userId }, "could not record correction");
  }
}

/**
 * Teach the pantry from a correction.
 *
 * When the user edits an entry that came from the library, the number they typed is the
 * new truth for that food - divided back down to a single serving, and pinned so that no
 * later lookup can quietly disagree with them. This is what makes a correction stick
 * rather than having to be made again next week.
 *
 * Only fires on a pantry-resolved entry with an unambiguous serving count. Correcting a
 * one-off estimate records the correction but teaches nothing, which is right: there is no
 * reference to update.
 */
export function teachPantryFromCorrection(
  userId: string,
  entry: FoodEntry,
  corrected: Nutrients,
): boolean {
  const log = getLogger();
  const key = entry.estimate?.pantry_key;
  if (!key) return false;

  try {
    const pantry = readPantry(userId);
    const ref = pantry.items[key];
    if (!ref) return false;

    // Recover how many servings this entry represented, from the stored per-serving
    // calories. Anything ambiguous is skipped rather than guessed at.
    const perServingCal = ref.per_serving.calories;
    const entryCal = entry.nutrients.calories;
    if (!perServingCal || !entryCal || perServingCal <= 0) return false;
    const servings = entryCal / perServingCal;
    if (!Number.isFinite(servings) || servings <= 0) return false;

    const perServing = { ...ref.per_serving };
    let updated = 0;
    for (const nutrientKey of NUTRIENT_KEYS) {
      const value = corrected[nutrientKey];
      if (value === null || value === undefined) continue;
      const scaled = Math.round((value / servings) * 1000) / 1000;
      if (perServing[nutrientKey] !== scaled) {
        perServing[nutrientKey] = scaled;
        updated++;
      }
    }
    if (updated === 0) return false;

    upsertItem(userId, {
      ...ref,
      per_serving: perServing,
      source_tier: "user",
      source_title: ref.source_title || entry.food_name,
      // Frozen from here on. upsertItem refuses to let a model-sourced write overwrite it.
      verified_by: "owner",
      verified_at: new Date().toISOString(),
      log_count: 0,
    });
    log.info({ pantryKey: key, servings, updated }, "pinned a corrected value in the pantry");
    return true;
  } catch (err) {
    log.warn({ err, pantryKey: key }, "could not teach the pantry from this correction");
    return false;
  }
}

/**
 * Read the whole corrections history back, newest last.
 *
 * Currently unused - kept as the reader for the corrections.jsonl that recordCorrection
 * writes, reserved for the planned "review your corrections" flow and for wiring this
 * per-user corpus into the eval harness. Not referenced elsewhere yet.
 */
export function readCorrections(userId: string): Correction[] {
  const filePath = correctionsPath(userId);
  if (!fs.existsSync(filePath)) return [];
  try {
    return fs.readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line) as Correction; } catch { return null; }
      })
      .filter((c): c is Correction => c !== null);
  } catch (err) {
    getLogger().warn({ err, userId }, "could not read corrections");
    return [];
  }
}
