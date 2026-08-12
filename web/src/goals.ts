// goals.ts
// The one place daily targets live on the client.
//
// Goals used to sit in localStorage, which meant the phone and the desktop drew different
// reference lines from identical data - you could be "over" on one device and "under" on
// the other. They now live on the server (GET/PUT /profile/:userId) so there is a single
// answer, and localStorage is demoted to a cache.
//
// Keeping the cache matters for two things the server can't do:
//   - first paint. Reading a goal is synchronous in a dozen render paths; without a cached
//     value every chart would flash default reference lines before snapping to the real ones.
//   - a Pi that is asleep or unreachable. Charts still draw against your real targets
//     instead of silently reverting to someone else's defaults.
//
// This is a module-level store rather than a context because goals are read during render
// in three screens and written in one. useSyncExternalStore is built into React 18, so it
// costs no dependency and gets tearing-free reads for free.

import { useSyncExternalStore } from "react";
import type { Goals } from "./types";
import { DEFAULT_GOALS } from "./types";
import { api } from "./api";

const CACHE_KEY = "voicebite.goals.v1";

function readCache(): Goals {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return DEFAULT_GOALS;
    // Spread over the defaults so a cache written by an older build, missing a field,
    // doesn't produce an undefined target and an Infinity percentage downstream.
    return { ...DEFAULT_GOALS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_GOALS;
  }
}

function writeCache(goals: Goals): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(goals));
  } catch {
    // Private browsing or a full quota. The in-memory value still applies this session.
  }
}

let current: Goals = readCache();
const listeners = new Set<() => void>();

function emit(next: Goals): void {
  // useSyncExternalStore compares snapshots by identity, so this must be a new object
  // even when the values are unchanged.
  current = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Current goals. Safe to call during render. */
export function getGoals(): Goals {
  return current;
}

/** Subscribe a component to goal changes. */
export function useGoals(): Goals {
  return useSyncExternalStore(subscribe, getGoals, getGoals);
}

/**
 * Pull the authoritative values from the server. Called once when the app mounts.
 * A failure is deliberately silent: the cached values are still the user's own, and a
 * banner about goals would just be noise on top of the health warning App already shows.
 */
export async function hydrateGoals(): Promise<void> {
  try {
    const { goals } = await api.getGoals();
    const merged = { ...DEFAULT_GOALS, ...goals };
    writeCache(merged);
    emit(merged);
  } catch {
    // Offline or Pi down - keep the cache.
  }
}

/**
 * Save a change. Updates local state first so the UI responds immediately, then persists.
 * If the server rejects it, the previous values are put back and the error is rethrown so
 * the form can report it - a goals screen that says "Saved" while the server disagreed is
 * worse than one that says nothing.
 */
export async function saveGoals(next: Goals): Promise<Goals> {
  const previous = current;
  const optimistic = { ...DEFAULT_GOALS, ...next };
  writeCache(optimistic);
  emit(optimistic);

  try {
    const { goals } = await api.putGoals(optimistic);
    // Trust the server's echo - it sanitizes, so what came back may differ from what we sent.
    const confirmed = { ...DEFAULT_GOALS, ...goals };
    writeCache(confirmed);
    emit(confirmed);
    return confirmed;
  } catch (err) {
    writeCache(previous);
    emit(previous);
    throw err;
  }
}
