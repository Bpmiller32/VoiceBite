// logger.ts
// Central structured logging for VoiceBite using pino
//
// Two modes:
//   - "server": JSON logs to file + human-readable to stdout
//   - "cli":    JSON logs to file only (stdout stays clean for interactive UI)
//
// Log files go to LOG_DIR (default: ./logs/). Log level from LOG_LEVEL (default: "info").
// Use pino-pretty to read log files: cat logs/voicebite.log | npx pino-pretty

import pino from "pino";
import fs from "fs";
import path from "path";

// The singleton logger instance - initialized by initLogger()
let _logger: pino.Logger | null = null;

// Initialize the logger for a specific mode
// Must be called after dotenv.config() so env vars are available
export function initLogger(mode: "server" | "cli"): pino.Logger {
  const logDir = process.env.LOG_DIR || "./logs";
  const logLevel = process.env.LOG_LEVEL || "info";
  const logFile = path.join(logDir, "voicebite.log");

  // Ensure the logs directory exists
  fs.mkdirSync(logDir, { recursive: true });

  // Build the streams array - always write structured JSON to file
  const streams: pino.StreamEntry[] = [
    { level: logLevel as pino.Level, stream: pino.destination({ dest: logFile, sync: true }) },
  ];

  // In server mode, also write to stdout for PM2 / terminal visibility
  if (mode === "server") {
    streams.push({ level: logLevel as pino.Level, stream: process.stdout });
  }

  _logger = pino(
    {
      level: logLevel,
      base: { app: "voicebite", mode },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams),
  );

  return _logger;
}

// Get the logger instance - throws if initLogger() hasn't been called yet
export function getLogger(): pino.Logger {
  if (!_logger) {
    throw new Error("Logger not initialized - call initLogger() first");
  }
  return _logger;
}
