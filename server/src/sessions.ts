// sessions.ts
// Manages pending log sessions in memory
// A "session" is created after we parse and enrich food entries but before the user confirms.
// The user gets a sessionId, reviews the food list, then hits /confirm/:sessionId to save it.

import { PendingSession, FoodEntry } from "./types";
import { getLogger } from "./logger";

// In-memory map of sessionId -> session data.
// Fine for a personal Pi server. The tradeoff is that a restart or deploy drops any
// in-flight confirmation, so the TTL below is generous enough to survive a slow review
// but the client should be prepared for a 404 and re-submit.
const sessions = new Map<string, PendingSession>();

// How long a session is valid before it expires.
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Upper bound on how many pending sessions we hold, so a burst can't grow memory unbounded.
const MAX_SESSIONS = 100;

// Create a new pending session and return the sessionId
export function createSession(
  userId: string,
  date: string,
  entries: FoodEntry[],
  transcript: string,
  overwrite: boolean,
): string {
  const log = getLogger();
  const sessionId = crypto.randomUUID();

  // Evict the oldest if we're at the cap. Map preserves insertion order.
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest) sessions.delete(oldest);
  }

  sessions.set(sessionId, {
    sessionId,
    userId,
    date,
    entries,
    transcript,
    overwrite,
    createdAt: new Date(),
  });

  log.info({ sessionId, userId, date, entryCount: entries.length, overwrite }, "session created");
  return sessionId;
}

// Retrieve a pending session by ID.
// Returns null if the session doesn't exist or has expired.
export function getSession(sessionId: string): PendingSession | null {
  const log = getLogger();
  const session = sessions.get(sessionId);

  if (!session) {
    log.debug({ sessionId, found: false }, "session lookup");
    return null;
  }

  const ageMs = Date.now() - session.createdAt.getTime();
  if (ageMs > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    log.info({ sessionId, ageMs }, "session expired on lookup");
    return null;
  }

  log.debug({ sessionId, found: true, ageMs }, "session lookup");
  return session;
}

// Remove a session from memory after it's been confirmed (or rejected)
export function deleteSession(sessionId: string): void {
  const log = getLogger();
  sessions.delete(sessionId);
  log.debug({ sessionId }, "session deleted");
}

// How many sessions are currently pending - reported by GET /health
export function sessionCount(): number {
  return sessions.size;
}

// Purge all sessions older than SESSION_TTL_MS - called on a timer by the server.
// The interval is deliberately shorter than the TTL so an expired session doesn't
// linger in memory for up to another full interval before being collected.
export function purgeExpiredSessions(): void {
  const log = getLogger();
  const now = Date.now();
  let purgedCount = 0;
  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt.getTime() > SESSION_TTL_MS) {
      sessions.delete(id);
      purgedCount++;
    }
  }
  if (purgedCount > 0) {
    log.info({ purgedCount, remainingSessions: sessions.size }, "purged expired sessions");
  }
}
