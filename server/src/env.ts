// env.ts
// Loads .env, and nothing else. Import this FIRST, before any other local module.
//
// Why this file exists rather than a bare dotenv.config() at the top of server.ts:
//
// ES module imports are evaluated before any top-level statement in the importing file.
// So this:
//
//     import dotenv from "dotenv";
//     dotenv.config({ override: true });   // <- runs THIRD
//     import { parseAndEnrich } from "./enricher";  // <- enricher's body runs SECOND
//
// does not do what it looks like it does. Every imported module's body has already run by
// the time dotenv.config() executes, so anything those modules read from process.env at
// module scope sees the shell environment, not .env.
//
// That bit us for real: enricher.ts built its Anthropic client at module scope, which
// captured a stale ANTHROPIC_API_KEY from the shell and produced a 401 on every request
// while the correct key sat in .env being ignored. CLAUDE_MODEL, CLAUDE_EFFORT and
// CLAUDE_MAX_TOKENS were silently ignored the same way - and went unnoticed because the
// .env values happened to match the code defaults.
//
// Importing this module first works because imports are evaluated in source order, so its
// side effect lands before any sibling module's body runs. Belt and braces, enricher.ts
// also reads its config lazily, so it stays correct even if someone reorders the imports.

import dotenv from "dotenv";
import path from "path";
import fs from "fs";

// Resolve .env relative to THIS FILE, not to process.cwd().
//
// dotenv's default is cwd-relative, which means `npm start` only works if you happen to be
// standing in server/. Run the CLI from the repo root - or from anywhere else, e.g. over SSH
// from a phone - and dotenv quietly finds nothing, ANTHROPIC_API_KEY is never set, and the
// SDK fails with "Could not resolve authentication method", which reads like a credentials
// problem rather than a working-directory problem.
//
// This file lives at server/src/env.ts, so the .env sits one directory up from src/.
const envPath = path.resolve(__dirname, "..", ".env");

// override: true means .env always beats an existing shell variable. That is deliberate -
// a stale exported key in a long-lived shell should not silently outrank the file you edited.
const result = dotenv.config({ path: envPath, override: true });

if (result.error && !fs.existsSync(envPath)) {
  // Fail loudly and specifically. The alternative is a confusing SDK auth error thrown
  // several layers away from the actual cause.
  console.error(
    `[voicebite] No .env found at ${envPath}\n` +
    `            Copy server/.env.example to server/.env and set ANTHROPIC_API_KEY.`,
  );
}
