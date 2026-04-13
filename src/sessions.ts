// sessions.ts
// Manages pending log sessions in memory
// A "session" is created after we parse and enrich food entries but before the user confirms
// The user gets a sessionId, reviews the food list, then hits /confirm/:sessionId to save it
// Sessions expire after 10 minutes if not confirmed

import { PendingSession, FoodEntry } from "./types";

// In-memory map of sessionId → session data
// This is fine for a personal Pi server - one user, no persistence needed across restarts
const sessions = new Map<string, PendingSession>();

// How long (in milliseconds) a session is valid before it expires
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Create a new pending session and return the sessionId
export function createSession(userId: string, date: string, entries: FoodEntry[]): string {
  // Generate a random unique ID for this session
  const sessionId = crypto.randomUUID();

  sessions.set(sessionId, {
    sessionId,
    userId,
    date,
    entries,
    createdAt: new Date(),
  });

  return sessionId;
}

// Retrieve a pending session by ID
// Returns null if the session doesn't exist or has expired
export function getSession(sessionId: string): PendingSession | null {
  const session = sessions.get(sessionId);

  // Session doesn't exist
  if (!session) return null;

  // Check if the session has expired
  const ageMs = Date.now() - session.createdAt.getTime();
  if (ageMs > SESSION_TTL_MS) {
    // Clean it up and treat it as not found
    sessions.delete(sessionId);
    return null;
  }

  return session;
}

// Remove a session from memory after it's been confirmed (or rejected)
export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}

// Purge all sessions older than SESSION_TTL_MS - call this periodically to avoid memory leaks
// The server calls this on a timer so old unconfirmed sessions don't pile up
export function purgeExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt.getTime() > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}
