// One-off helper: turn a password into the scrypt hash that goes in .env.
//
// Usage:  npm run set-password -- "your password here"
//
// Prints the two lines to paste. Deliberately does not write .env itself - editing a file
// that holds live API keys from a throwaway script is not a trade worth making.
import crypto from "crypto";
import { hashPassword } from "./auth";

const password = process.argv.slice(2).join(" ").trim();

if (!password) {
  console.error('Usage: npm run set-password -- "your password here"');
  process.exit(1);
}
if (password.length < 8) {
  console.error("Use at least 8 characters.");
  process.exit(1);
}

console.log("\nAdd (or replace) these two lines in server/.env, then `pm2 restart VoiceBite`:\n");
console.log(`AUTH_PASSWORD_HASH=${hashPassword(password)}`);
console.log(`AUTH_SECRET=${crypto.randomBytes(48).toString("base64url")}`);
console.log("\n# Note: AUTH_SECRET signs login tokens. Changing it logs every device out.\n");
