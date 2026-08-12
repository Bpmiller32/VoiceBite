// auth.ts
// A single-user password gate. Deliberately small - no dependencies, no user table,
// no sessions in a database. Node's crypto has everything this needs.
//
// The threat model is honest about what it is: this API is on the public internet and
// serves one person's food log and their raw voice transcripts. It does not need
// enterprise identity; it needs "nobody but Billy can read or write this".
//
// Three things it does NOT do, on purpose:
//   - store the password anywhere (only a scrypt hash of it)
//   - compare secrets with === (timing side channel; timingSafeEqual instead)
//   - trust anything the client sends about who it is (the token is signed server-side)

import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { getLogger } from "./logger";

// How long a login lasts. Long, because it's one person on their own phone and being
// logged out mid-week is a worse outcome here than a stale token.
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const SCRYPT_KEYLEN = 64;

/**
 * Hash a password for storage in AUTH_PASSWORD_HASH.
 * Format: scrypt$<salt-hex>$<hash-hex> - self-describing, so the verifier doesn't need
 * to guess the parameters and a future algorithm change stays distinguishable.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Constant-time check of a password against a stored scrypt hash. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[1], "hex");
    expected = Buffer.from(parts[2], "hex");
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEYLEN) return false;

  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  // Lengths match by construction above, so timingSafeEqual won't throw.
  return crypto.timingSafeEqual(actual, expected);
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) {
    // Failing loudly beats signing tokens with a weak or empty key and looking secure.
    throw new Error("AUTH_SECRET must be set to at least 32 characters");
  }
  return s;
}

/**
 * A signed bearer token: base64url(payload).base64url(hmac).
 *
 * This is a JWT in spirit without the dependency or the algorithm-confusion footguns -
 * there is exactly one algorithm and it isn't negotiable by the client.
 */
export function signToken(userId: string): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = b64url(JSON.stringify({ sub: userId, exp: expiresAt }));
  const sig = b64url(crypto.createHmac("sha256", secret()).update(payload).digest());
  return { token: `${payload}.${sig}`, expiresAt };
}

/** Returns the userId a token vouches for, or null if it is invalid or expired. */
export function verifyToken(token: string): string | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;

  const expected = crypto.createHmac("sha256", secret()).update(payload).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  // Compare lengths first: timingSafeEqual throws on a mismatch, and that throw would
  // itself be a (very coarse) oracle.
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof claims?.sub !== "string") return null;
    if (typeof claims?.exp !== "number" || Date.now() > claims.exp) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

/** True when a password has been configured. Without one, the gate can't be closed. */
export function authConfigured(): boolean {
  return Boolean(process.env.AUTH_PASSWORD_HASH && process.env.AUTH_SECRET);
}

/**
 * Gate for everything that touches real data.
 *
 * Note this protects the SERVER, not the UI. Hiding a screen behind a password in React
 * while the API stays open is theatre - `curl` doesn't run your JavaScript.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const log = (req as any).log ?? getLogger();

  if (!authConfigured()) {
    // Refuse rather than fall open. An unconfigured gate that silently allows everything
    // is the worst of both worlds: it looks protected and isn't.
    log.error("auth is not configured - set AUTH_PASSWORD_HASH and AUTH_SECRET");
    res.status(503).json({
      error: { code: "auth_not_configured", message: "Authentication is not configured on this server" },
    });
    return;
  }

  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const userId = token ? verifyToken(token) : null;

  if (!userId) {
    log.warn({ hasHeader: Boolean(header) }, "unauthorized request");
    res.status(401).json({ error: { code: "unauthorized", message: "Sign in to continue" } });
    return;
  }

  (req as any).userId = userId;
  next();
}

/**
 * The authenticated user must match the :userId in the path.
 *
 * Belt and braces next to requireAuth: without it a valid token for one user could read
 * another's data just by changing the URL, which is exactly the tenant-confusion the
 * path-based userId invites.
 */
export function requireOwnUser(req: Request, res: Response, next: NextFunction) {
  const authed = (req as any).userId;
  const target = req.params.userId;
  if (target && authed && target !== authed) {
    res.status(403).json({ error: { code: "wrong_user", message: "That isn't your data" } });
    return;
  }
  next();
}
