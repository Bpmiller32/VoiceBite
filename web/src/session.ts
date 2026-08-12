// session.ts
// Who the app thinks you are, and the token that proves it.
//
// Three states, and the app renders differently in each:
//   "loading" - we have a stored token and haven't checked it yet
//   "demo"    - nobody is signed in; the app runs on local fixture data
//   "real"    - signed in; every request carries a bearer token
//
// The token is the only thing that matters. Hiding screens in React is not security -
// the server rejects unauthenticated requests regardless of what the UI shows.

import { useSyncExternalStore } from "react";

const TOKEN_KEY = "voicebite.token.v1";

export type Mode = "loading" | "demo" | "real";

interface Session {
  mode: Mode;
  userId: string | null;
}

let current: Session = { mode: "loading", userId: null };
const listeners = new Set<() => void>();

function emit(next: Session) {
  current = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSession(): Session {
  return current;
}

export function useSession(): Session {
  return useSyncExternalStore(subscribe, getSession, getSession);
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private browsing. The in-memory session still works for this tab.
  }
}

/**
 * Decide which mode we're in, once, at startup.
 *
 * No stored token means demo - not an error state. Someone arriving at the portfolio link
 * should land in a working app, not a login wall.
 */
export async function resolveSession(): Promise<void> {
  const token = getToken();
  if (!token) {
    emit({ mode: "demo", userId: null });
    return;
  }

  try {
    const res = await fetch(`${apiBase()}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const body = await res.json();
      emit({ mode: "real", userId: body.userId });
      return;
    }
    // A token the server won't accept is worse than none - it would 401 every request
    // with no obvious cause. Drop it and fall back to demo.
    storeToken(null);
    emit({ mode: "demo", userId: null });
  } catch {
    // The Pi is unreachable. Keep the token (it's probably still valid) but run in demo
    // mode so the app is usable rather than a wall of failed requests.
    emit({ mode: "demo", userId: null });
  }
}

export async function login(password: string): Promise<void> {
  const res = await fetch(`${apiBase()}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error?.message ?? "Couldn't sign in");
  }
  storeToken(body.token);
  emit({ mode: "real", userId: body.userId });
}

export function logout(): void {
  storeToken(null);
  emit({ mode: "demo", userId: null });
}

/** Called by the API layer when the server rejects our token mid-session. */
export function onUnauthorized(): void {
  if (current.mode === "real") {
    storeToken(null);
    emit({ mode: "demo", userId: null });
  }
}

// Duplicated from api.ts rather than imported, to keep the module graph acyclic:
// api.ts needs getToken() from here, so this file must not need anything from there.
function apiBase(): string {
  if (import.meta.env.DEV) return "/api";
  return (import.meta.env.VITE_API_BASE as string | undefined) ?? "https://voicebite.billmill.dev";
}
