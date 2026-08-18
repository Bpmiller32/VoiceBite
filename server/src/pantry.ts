// pantry.ts
// A per-user reference table of foods this person actually eats.
//
// The problem it solves, measured on the real corpus: the same Fairlife Core Power shake
// was logged five times and estimated at 150, 150, 100, 170 and 150 kcal. Nothing in the
// pipeline remembered what it decided last time, so every logging was an independent
// guess at a product with a published label.
//
// Two design decisions carry the whole file:
//
// - The SERVER does the arithmetic, not the model. Once a reference exists, an entry is
//   `per_serving x servings`, computed in TypeScript. Scaling a self-consistent label by
//   a scalar is exactly self-consistent, so a pantry-resolved entry cannot contradict its
//   own macros and cannot disagree with yesterday's logging of the same food. Both of
//   those are guarantees by construction rather than things to measure and hope for.
//
// - Unknown scales to unknown. `null` means "nobody knows this nutrient" everywhere in
//   this codebase, and multiplying it by a serving count must not turn it into 0. That is
//   the same unknown-as-zero mistake the nutrient contract exists to prevent.
//
// If pantry.json is missing, empty or corrupt, every function here degrades to "no
// candidates" and the pipeline behaves exactly as it did before this file existed.

import fs from "fs";
import { Nutrients, NUTRIENT_KEYS } from "./types";
import { emptyNutrients, sanitizeNutrients } from "./enricher";
import { userFilePath, writeJsonAtomic } from "./store";
import { getLogger } from "./logger";

/** How much a source is trusted. Only the top two may be written without a human look. */
export type SourceTier = "manufacturer" | "aggregator" | "user" | "none";

export interface PantryItem {
  /** Stable slug, minted once: `brand|product`. */
  key: string;
  display_name: string;
  /** Every surface form that has resolved here, so matching survives rephrasing. */
  aliases: string[];
  /** The label's OWN serving, e.g. "1 slice", "1 bottle", "2/3 cup". */
  serving_label: string;
  /** Mass of that serving in grams. 0 when the source doesn't state one. */
  serving_grams: number;
  /** Servings in the whole package. 0 = unknown. Needed to read "half a bottle". */
  servings_per_container: number;
  /** Nutrients for ONE serving_label. null still means unknown. */
  per_serving: Nutrients;
  source_url: string;
  /** Product name exactly as printed at the source, for spotting a wrong-variant match. */
  source_title: string;
  source_tier: SourceTier;
  /** "owner" is frozen: no model call may overwrite a value the user confirmed. */
  verified_by: "claude" | "owner";
  verified_at: string;
  log_count: number;
}

export interface Pantry {
  schema_version: 1;
  items: Record<string, PantryItem>;
  /** Foods we looked for and could not find, so we don't pay for the same miss daily. */
  misses: Record<string, { searched_at: string; attempts: number }>;
}

const EMPTY_PANTRY: Pantry = { schema_version: 1, items: {}, misses: {} };

/** How many candidate rows to put in front of the model. Enough to match, small enough to cache. */
const MAX_CANDIDATES = 40;

/** Re-search a food that previously missed only after this long. */
const MISS_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Words that appear across many unrelated foods, so matching on them alone means nothing.
 * Used to require that at least one *distinctive* token matched.
 */
const GENERIC_FOOD_WORDS = new Set([
  "protein", "drink", "energy", "bar", "shake", "water", "juice", "coffee", "tea", "milk",
  "chicken", "cheese", "sauce", "original", "flavor", "flavored", "mix", "snack", "food",
  "large", "small", "medium", "mini", "bag", "bottle", "can", "cup", "pack", "stick",
]);

function pantryPath(userId: string): string {
  return userFilePath(userId, "pantry.json");
}

/**
 * Normalize a food name for matching.
 *
 * Deliberately aggressive: drops the trailing "(2 slice)" the display name carries, folds
 * punctuation and spacing, and strips a few filler words. "Raising Cane's Texas Toast",
 * "raising canes texas toast" and "Texas toast from Raising Canes" all land on overlapping
 * token sets, which is what makes alias matching work across rephrasing.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\([^()]*\)\s*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an|of|from|with|and|my)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Mint a stable key from a brand and product name. */
export function pantryKey(brand: string, product: string): string {
  const slug = (s: string) => normalizeName(s).replace(/\s+/g, "-").slice(0, 48);
  const b = slug(brand);
  const p = slug(product);
  return b ? `${b}|${p}` : p;
}

// ── read / write ───────────────────────────────────────────────────────────

export function readPantry(userId: string): Pantry {
  const filePath = pantryPath(userId);
  if (!fs.existsSync(filePath)) return { ...EMPTY_PANTRY, items: {}, misses: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const items: Record<string, PantryItem> = {};
    for (const [key, v] of Object.entries<any>(raw?.items ?? {})) {
      if (!v || typeof v !== "object") continue;
      items[key] = {
        key,
        display_name: String(v.display_name ?? key),
        aliases: Array.isArray(v.aliases) ? v.aliases.filter((a: unknown) => typeof a === "string") : [],
        serving_label: String(v.serving_label ?? "1 serving"),
        serving_grams: Number(v.serving_grams) || 0,
        servings_per_container: Number(v.servings_per_container) || 0,
        // Through sanitize like everything else that reaches disk, so one bad stored
        // value cannot poison every future entry scaled from it.
        per_serving: sanitizeNutrients(v.per_serving),
        source_url: String(v.source_url ?? ""),
        source_title: String(v.source_title ?? ""),
        source_tier: (["manufacturer", "aggregator", "user", "none"] as const).includes(v.source_tier)
          ? v.source_tier : "none",
        verified_by: v.verified_by === "owner" ? "owner" : "claude",
        verified_at: String(v.verified_at ?? ""),
        log_count: Number(v.log_count) || 0,
      };
    }
    const misses: Pantry["misses"] = {};
    for (const [key, v] of Object.entries<any>(raw?.misses ?? {})) {
      if (v && typeof v.searched_at === "string") {
        misses[key] = { searched_at: v.searched_at, attempts: Number(v.attempts) || 1 };
      }
    }
    return { schema_version: 1, items, misses };
  } catch (err) {
    // A broken pantry must never break logging. Report it and carry on with none - the
    // pipeline's behaviour without a pantry is exactly its behaviour before one existed.
    getLogger().error({ err, userId, filePath }, "pantry is unreadable - continuing without it");
    return { ...EMPTY_PANTRY, items: {}, misses: {} };
  }
}

export function writePantry(userId: string, pantry: Pantry): void {
  writeJsonAtomic(pantryPath(userId), pantry);
}

/**
 * Add or update one reference.
 *
 * An owner-verified row is never overwritten by a model-sourced one. That is the whole
 * point of pinning: once the user has said "this is the right number", no later automated
 * lookup gets to disagree with them.
 */
export function upsertItem(userId: string, item: PantryItem): { written: boolean; reason?: string } {
  const pantry = readPantry(userId);
  const existing = pantry.items[item.key];

  if (existing?.verified_by === "owner" && item.verified_by !== "owner") {
    return { written: false, reason: "owner-verified row is frozen" };
  }

  pantry.items[item.key] = {
    ...item,
    // Aliases accumulate; every new surface form makes the next match easier.
    aliases: [...new Set([...(existing?.aliases ?? []), ...item.aliases])].slice(0, 24),
    log_count: (existing?.log_count ?? 0) + (item.log_count || 0),
  };
  delete pantry.misses[item.key];
  writePantry(userId, pantry);
  return { written: true };
}

/** Record that a food could not be found, so we don't pay to re-search it every day. */
export function recordMiss(userId: string, key: string): void {
  const pantry = readPantry(userId);
  const prev = pantry.misses[key];
  pantry.misses[key] = {
    searched_at: new Date().toISOString(),
    attempts: (prev?.attempts ?? 0) + 1,
  };
  writePantry(userId, pantry);
}

export function isRecentMiss(pantry: Pantry, key: string): boolean {
  const miss = pantry.misses[key];
  if (!miss) return false;
  return Date.now() - Date.parse(miss.searched_at) < MISS_TTL_MS;
}

// ── scaling ────────────────────────────────────────────────────────────────

/**
 * Scale a reference to a number of servings.
 *
 * This is the single highest-leverage function in the accuracy work. Everything it
 * produces is internally consistent, because it is one multiply applied to a set of
 * numbers that were consistent to begin with.
 */
export function scaleReference(ref: PantryItem, servings: number): Nutrients {
  const out = emptyNutrients();
  if (!Number.isFinite(servings) || servings <= 0) return out;
  for (const key of NUTRIENT_KEYS) {
    const v = ref.per_serving[key];
    // Unknown scales to unknown. Never to zero.
    if (v === null || !Number.isFinite(v)) continue;
    out[key] = Math.round(v * servings * 1000) / 1000;
  }
  return out;
}

// ── candidate selection ────────────────────────────────────────────────────

/**
 * Pick the rows worth showing the model for this utterance.
 *
 * Deterministic and local - a Map lookup and some token overlap, single-digit milliseconds
 * on a Pi. Deliberately NOT a model call: choosing what to put in the prompt must not
 * itself cost a round trip, and the ordering must be stable or it breaks prompt caching.
 */
export function selectCandidates(pantry: Pantry, text: string, limit = MAX_CANDIDATES): PantryItem[] {
  const items = Object.values(pantry.items);
  if (items.length === 0) return [];

  const haystack = normalizeName(text);
  const words = new Set(haystack.split(" ").filter((w) => w.length > 2));

  const scored = items.map((item) => {
    const surfaces = [item.display_name, ...item.aliases].map(normalizeName);
    let score = 0;
    for (const surface of surfaces) {
      if (!surface) continue;
      // Whole-phrase hit is worth far more than incidental word overlap.
      if (haystack.includes(surface)) score = Math.max(score, 100 + surface.length);

      const tokens = surface.split(" ").filter((w) => w.length > 2);
      const hits = tokens.filter((t) => words.has(t)).length;
      // Two matching tokens minimum, and never a token that is generic across foods.
      // One shared word is not evidence: "protein" alone pulled a Fairlife shake into the
      // candidates for a transcript about a protein pastry and Texas toast. Every row
      // offered costs prompt tokens and gives the model one more chance to mis-match.
      const distinct = tokens.filter((t) => words.has(t) && !GENERIC_FOOD_WORDS.has(t)).length;
      if (tokens.length && hits >= 2 && distinct >= 1) {
        score = Math.max(score, Math.round((hits / tokens.length) * 50));
      }
    }
    // Staples earn a bonus, but only on a row that already matched something. A standing
    // bonus applied to everything would put the whole pantry in every prompt.
    return { item, score: score > 0 ? score + Math.min(item.log_count, 10) : 0 };
  });

  return scored
    .filter((s) => s.score >= 20)
    .sort((a, b) =>
      b.score - a.score ||
      b.item.log_count - a.item.log_count ||
      // Final tiebreak on key so the ordering is byte-stable across calls.
      a.item.key.localeCompare(b.item.key))
    .slice(0, limit)
    .map((s) => s.item);
}

/**
 * Render candidates as a table for the prompt.
 *
 * Byte-stable on purpose: fixed column order, sorted keys, no timestamps. This block sits
 * in the cached prefix, and a table that reorders itself between calls would invalidate
 * the cache on every request while looking identical.
 */
export function renderPantryTable(items: PantryItem[]): string {
  if (items.length === 0) return "";

  const rows = [...items].sort((a, b) => a.key.localeCompare(b.key));
  const lines = rows.map((i) => {
    const kcal = i.per_serving.calories;
    const owner = i.verified_by === "owner" ? " [verified by user]" : "";
    return `${i.key} | ${i.display_name} | ${i.serving_label} | ${kcal ?? "?"} kcal | ${i.source_tier}${owner}`;
  });

  return [
    "YOUR FOOD LIBRARY",
    "Foods this user has logged before, with values taken from the source shown.",
    "If an item you are parsing is one of these, set route to \"pantry\" and pantry_key to the",
    "matching key, and give the portion in spoken_portion. The server fills in the nutrients",
    "from the library and scales them - do not re-derive a row's numbers, and do not search",
    "for a food that is already listed here.",
    "A row marked [verified by user] was checked by the user personally. Never contradict it.",
    "",
    "key | name | serving | per serving | source",
    ...lines,
  ].join("\n");
}
