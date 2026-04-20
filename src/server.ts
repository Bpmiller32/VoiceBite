// server.ts
// Express HTTP server that exposes VoiceBite over the network
// Designed to run on your Raspberry Pi and be called from iPhone Shortcuts via Tailscale
//
// Endpoints:
//   POST /log             - parse text, enrich with nutrients, return a preview for confirmation
//   POST /confirm/:id     - confirm a pending session, write the JSON file to disk
//   GET  /log/:userId/:date - read back a saved day log (useful for debugging or display)

// Load .env file - override: true means .env always wins over shell env vars
import dotenv from "dotenv";
dotenv.config({ override: true });
import express from "express";
import { initLogger } from "./logger";
import { parseAndEnrich } from "./enricher";
import { appendEntries, readDayLog, todayDateString } from "./store";
import { createSession, getSession, deleteSession, purgeExpiredSessions } from "./sessions";
import { FoodEntry, LogPreviewResponse, ConfirmResponse } from "./types";

// Initialize the logger in server mode (JSON to file + stdout)
const logger = initLogger("server");

const app = express();

// Parse incoming JSON request bodies
app.use(express.json());

// Request ID middleware - generates a unique ID per request for log correlation
app.use((req, res, next) => {
  const requestId = crypto.randomUUID();
  (req as any).requestId = requestId;
  (req as any).log = logger.child({ requestId, method: req.method, path: req.url });
  (req as any).log.info("request received");
  const startMs = Date.now();
  res.on("finish", () => {
    (req as any).log.info({ statusCode: res.statusCode, latencyMs: Date.now() - startMs }, "request completed");
  });
  next();
});

// The default user to fall back to if no userId is provided in the request
const DEFAULT_USER = process.env.DEFAULT_USER || "default";

// Purge expired sessions every 5 minutes to prevent memory leaks
setInterval(purgeExpiredSessions, 5 * 60 * 1000);

// POST /log
// Body: { text: string, userId?: string, date?: string, overwrite?: boolean }
// Parses the food text, enriches it with nutrients, and returns a preview to confirm
// Nothing is written to disk yet - the client must call /confirm/:sessionId to save
// If overwrite is true, existing entries for that day will be replaced (default: append)
app.post("/log", async (req, res) => {
  const reqLog = (req as any).log;
  const { text, userId, date, overwrite } = req.body;

  // Make sure we got some food text to work with
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    reqLog.warn("empty text field in request body");
    res.status(400).json({ error: "Request body must include a non-empty 'text' field" });
    return;
  }

  const user = userId || DEFAULT_USER;
  const logDate = date || todayDateString();

  try {
    reqLog.info({ userId: user, date: logDate }, "parsing and estimating nutrition");

    // Single Claude call: parse the text AND estimate nutrients together
    const { entries } = await parseAndEnrich(text, reqLog);
    reqLog.info({ userId: user, entryCount: entries.length }, "parsed and enriched entries");

    // Check if there's already a log for this day - include that info in the response
    const existingLog = readDayLog(user, logDate);
    const existingCount = existingLog ? existingLog.entries.length : 0;
    const existingCalories = existingLog ? Math.round(existingLog.daily_totals.calories) : 0;

    // Store the entries in a pending session - not saved to disk yet
    const sessionId = createSession(user, logDate, entries);

    // Build the summary totals for the preview
    const totalCalories = entries.reduce((sum: number, e: FoodEntry) => sum + e.nutrients.calories, 0);
    const totalProtein = entries.reduce((sum: number, e: FoodEntry) => sum + e.nutrients.protein_g, 0);
    const totalFat = entries.reduce((sum: number, e: FoodEntry) => sum + e.nutrients.fat_g, 0);
    const totalCarbs = entries.reduce((sum: number, e: FoodEntry) => sum + e.nutrients.carbs_g, 0);

    // Return the preview - client shows this to the user before confirming
    const preview: LogPreviewResponse & { existingEntries?: number; existingCalories?: number } = {
      sessionId,
      date: logDate,
      entries,
      summary: {
        totalCalories: Math.round(totalCalories),
        totalProtein_g: Math.round(totalProtein * 10) / 10,
        totalFat_g: Math.round(totalFat * 10) / 10,
        totalCarbs_g: Math.round(totalCarbs * 10) / 10,
      },
      existingEntries: existingCount,
      existingCalories: existingCalories,
    };

    reqLog.info({ sessionId, totalCalories: Math.round(totalCalories) }, "preview ready");
    res.json(preview);
  } catch (err: any) {
    reqLog.error({ err: err.message, stack: err.stack }, "error processing log");
    res.status(500).json({ error: err.message });
  }
});

// POST /confirm/:sessionId
// Body: { userId?: string, overwrite?: boolean }
// Confirms a pending session and writes the food log JSON file to disk
// overwrite: true = replace the whole day, false (default) = append to existing entries
app.post("/confirm/:sessionId", async (req, res) => {
  const reqLog = (req as any).log;
  const { sessionId } = req.params;
  const { userId, overwrite } = req.body;
  const user = userId || DEFAULT_USER;

  // Look up the pending session
  const session = getSession(sessionId);

  if (!session) {
    reqLog.warn({ sessionId }, "session not found or expired");
    res.status(404).json({ error: "Session not found or expired. Please re-submit your food log." });
    return;
  }

  // Make sure this session belongs to the right user
  if (session.userId !== user) {
    reqLog.warn({ sessionId, sessionUser: session.userId, requestUser: user }, "session user mismatch");
    res.status(403).json({ error: "This session belongs to a different user" });
    return;
  }

  try {
    let filePath: string;
    let totalEntries: number;
    let totalCalories: number;

    if (overwrite) {
      // Overwrite mode: ignore any existing entries, save only the new ones
      const { sumNutrients } = require("./enricher");
      const { writeDayLog } = require("./store");
      const newLog = {
        date: session.date,
        userId: session.userId,
        entries: session.entries,
        daily_totals: sumNutrients(session.entries),
      };
      filePath = writeDayLog(newLog);
      totalEntries = session.entries.length;
      totalCalories = Math.round(newLog.daily_totals.calories);
    } else {
      // Append mode: add new entries to whatever's already there
      const { log, filePath: fp } = appendEntries(session.userId, session.date, session.entries);
      filePath = fp;
      totalEntries = log.entries.length;
      totalCalories = Math.round(log.daily_totals.calories);
    }

    // Clean up the session from memory now that it's been saved
    deleteSession(sessionId);

    const result: ConfirmResponse = {
      success: true,
      message: `Logged ${session.entries.length} new entries for ${session.date}. Day total: ${totalEntries} entries, ${totalCalories} calories`,
      filePath,
    };

    reqLog.info({ sessionId, userId: user, filePath, totalEntries, totalCalories }, "session confirmed and saved");
    res.json(result);
  } catch (err: any) {
    reqLog.error({ err: err.message, stack: err.stack, sessionId }, "error saving log");
    res.status(500).json({ error: err.message });
  }
});

// GET /log/:userId/:date
// Returns the saved food log for a specific user and date
// Useful for building a UI or checking what was logged
app.get("/log/:userId/:date", (req, res) => {
  const reqLog = (req as any).log;
  const { userId, date } = req.params;
  const log = readDayLog(userId, date);

  if (!log) {
    reqLog.info({ userId, date }, "day log not found");
    res.status(404).json({ error: `No log found for user '${userId}' on ${date}` });
    return;
  }

  reqLog.info({ userId, date, entryCount: log.entries.length }, "day log retrieved");
  res.json(log);
});

// Start the server
const PORT = parseInt(process.env.PORT || "3000");
app.listen(PORT, () => {
  logger.info({
    port: PORT,
    defaultUser: DEFAULT_USER,
    dataDir: process.env.DATA_DIR || "./data",
    logDir: process.env.LOG_DIR || "./logs",
  }, "VoiceBite server started");
});
