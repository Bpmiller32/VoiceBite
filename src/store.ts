// store.ts
// Reads and writes daily food log JSON files to disk
// Each day gets its own file at: {DATA_DIR}/users/{userId}/food/{YYYY-MM-DD}.json
// This is the only file that touches the filesystem

import fs from "fs";
import path from "path";
import { DayLog, FoodEntry } from "./types";
import { sumNutrients } from "./enricher";
import { getLogger } from "./logger";

// Get the base data directory from the environment, default to ./data
function getDataDir(): string {
  return process.env.DATA_DIR || "./data";
}

// Build the full path to a user's daily food file
// Example: ./data/users/billy/food/2026-04-12.json
function getDayFilePath(userId: string, date: string): string {
  return path.join(getDataDir(), "users", userId, "food", `${date}.json`);
}

// Read today's food log for a user - returns null if the file doesn't exist yet
export function readDayLog(userId: string, date: string): DayLog | null {
  const log = getLogger();
  const filePath = getDayFilePath(userId, date);

  // File doesn't exist yet - no food logged for this day
  if (!fs.existsSync(filePath)) {
    log.debug({ userId, date, filePath }, "day log not found");
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const dayLog = JSON.parse(raw) as DayLog;
    log.debug({ userId, date, entryCount: dayLog.entries.length, filePath }, "read day log");
    return dayLog;
  } catch (err) {
    log.error({ err, userId, date, filePath }, "failed to read day log");
    throw err;
  }
}

// Write (or overwrite) the day log file for a user
// Creates the directory structure if it doesn't exist yet
export function writeDayLog(dayLog: DayLog): string {
  const log = getLogger();
  const filePath = getDayFilePath(dayLog.userId, dayLog.date);

  try {
    // Make sure the directory exists - creates all nested folders as needed
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Write the JSON file with 2-space indentation so it's human-readable
    fs.writeFileSync(filePath, JSON.stringify(dayLog, null, 2), "utf-8");

    log.info({
      userId: dayLog.userId,
      date: dayLog.date,
      entryCount: dayLog.entries.length,
      totalCalories: Math.round(dayLog.daily_totals.calories),
      filePath,
    }, "wrote day log");

    return filePath;
  } catch (err) {
    log.error({ err, userId: dayLog.userId, date: dayLog.date, filePath }, "failed to write day log");
    throw err;
  }
}

// Append new entries to an existing day log, or create a new one if none exists
// Recalculates daily_totals after appending
export function appendEntries(userId: string, date: string, newEntries: FoodEntry[]): { log: DayLog; filePath: string } {
  const logger = getLogger();

  // Load the existing log if there is one, otherwise start fresh
  const existing = readDayLog(userId, date);

  // Combine existing entries with the new ones
  const allEntries = existing ? [...existing.entries, ...newEntries] : newEntries;

  // Build the updated log object
  const dayLog: DayLog = {
    date,
    userId,
    entries: allEntries,
    // Recalculate totals from scratch so they're always accurate
    daily_totals: sumNutrients(allEntries),
  };

  const filePath = writeDayLog(dayLog);

  logger.info({
    userId,
    date,
    newEntries: newEntries.length,
    totalEntries: allEntries.length,
    totalCalories: Math.round(dayLog.daily_totals.calories),
  }, "appended entries to day log");

  return { log: dayLog, filePath };
}

// Return today's date as a YYYY-MM-DD string in local time
export function todayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  // getMonth() is 0-indexed so we add 1, then pad to 2 digits
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
