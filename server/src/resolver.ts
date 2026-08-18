// resolver.ts
// Reads published nutrition facts for one branded product, instead of recalling them.
//
// This is the step that addresses the largest measured error in the app. 78% of the
// corpus's calories come from branded or chain food that publishes exact figures, and the
// pipeline was estimating all of it from memory. Four products checked against their own
// manufacturers: Raising Cane's Texas toast logged at 320 and 210 against a published 150;
// Chomps sodium stably 34-58% low; a Legendary Foods pastry with 3-7 g of sugar invented
// on a product that contains none. One - a McGriddle - was recalled perfectly, three times.
// That is the tell: the model is not sampling around the right answer and missing, it is
// confidently returning a wrong one. Only reading the label fixes that.
//
// Three decisions worth knowing:
//
// - The result comes back through a FORCED TOOL, not output_config.format. Structured
//   outputs and citations are mutually exclusive, and once search is on, the response is a
//   mix of narration and results - reading a tool_use block's already-parsed `.input` is
//   immune to all of it.
//
// - Every lookup is bounded by a wall-clock deadline shared across the whole request, not
//   a per-item timeout. The user is standing there holding a phone; the budget that
//   matters is how long until THEY get a screen, not how long one lookup took.
//
// - A failed lookup is never an error. It falls back to the estimate the parse call
//   already produced, which is exactly today's behaviour. Grounding can only improve an
//   item or leave it alone.

import Anthropic from "@anthropic-ai/sdk";
import pino from "pino";
import { Nutrients, EstimateMeta, NUTRIENT_KEYS, CORE_NUTRIENT_KEYS } from "./types";
import { sanitizeNutrients } from "./enricher";
import { CostMeter } from "./cost";

const MICRO_KEYS = NUTRIENT_KEYS.filter((k) => !CORE_NUTRIENT_KEYS.includes(k));

// Source quality is a PREFERENCE, not a filter. The search tool once carried an
// `allowed_domains` list of 29 sites, but a hand-maintained list can't cover what one
// person actually eats: Red Bull wasn't on it, so a lookup for one of the most documented
// products in existence was confined to domains that don't carry it. The prompt asks the
// model to prefer the manufacturer instead, and every result records source_tier + source_url
// so an aggregator value is visible as one. See groundingTools() for the full rationale.

export type SourceTier = "manufacturer" | "aggregator" | "none";

/** What the model is required to hand back, exactly once, at the end. */
export interface ReferenceRecord {
  found: boolean;
  display_name: string;
  source_url: string;
  source_title: string;
  source_tier: SourceTier;
  serving_label: string;
  serving_grams: number;
  servings_per_container: number;
  /** How many of the source's servings the user's described portion is. */
  servings_consumed: number;
  confidence: "high" | "medium" | "low";
  note: string;
  macros: Record<string, number>;
  micronutrients: Array<{ key: string; value: number }>;
}

const RECORD_TOOL: Anthropic.Tool = {
  name: "record_reference",
  description:
    "Record the published nutrition reference you found for this one product. Call this exactly once, as the last thing you do.",
  // Guarantees the input validates against the schema, so `.input` can be read directly.
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "found", "display_name", "source_url", "source_title", "source_tier",
      "serving_label", "serving_grams", "servings_per_container", "servings_consumed",
      "confidence", "note", "macros", "micronutrients",
    ],
    properties: {
      found: {
        type: "boolean",
        description: "True only if you actually read published nutrition figures for this product. False if you could not find any and are falling back to an estimate.",
      },
      display_name: { type: "string", description: "Canonical product name, e.g. \"Raising Cane's Texas Toast\"." },
      source_url: { type: "string", description: "The page you took the numbers from. Empty string if found is false." },
      source_title: {
        type: "string",
        description: "Product name EXACTLY as printed at that source. If it does not match what the user described, lower your confidence and say so in note.",
      },
      source_tier: {
        type: "string",
        enum: ["manufacturer", "aggregator", "none"],
        description: "'manufacturer' = the company's or chain's own site. 'aggregator' = a third-party nutrition database. 'none' = you did not find published data.",
      },
      serving_label: { type: "string", description: "The source's OWN serving, e.g. \"1 slice\", \"1 bottle\", \"2/3 cup\"." },
      serving_grams: { type: "number", description: "Mass of that one serving in grams. 0 if the source does not state one." },
      servings_per_container: { type: "number", description: "Servings in the whole package. 0 if unknown or not applicable." },
      servings_consumed: {
        type: "number",
        description: "How many of those servings the user actually ate, from their own words. \"half a bottle\" of a 2-serving bottle is 1. This is what the stored figures get multiplied by.",
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "'high' = read off the manufacturer's page for this exact product. 'medium' = an aggregator, or the maker's page for a close variant. 'low' = could not find it and estimated.",
      },
      note: {
        type: "string",
        description: "Anything the user should check in one sentence - a variant you had to pick, a serving mismatch. Empty string if nothing.",
      },
      macros: {
        type: "object",
        additionalProperties: false,
        required: CORE_NUTRIENT_KEYS,
        properties: Object.fromEntries(
          CORE_NUTRIENT_KEYS.map((k) => [k, { type: "number", description: `${k} for ONE serving_label, not for the whole portion.` }]),
        ),
      },
      micronutrients: {
        type: "array",
        description:
          "ONLY the nutrients the source actually prints, for ONE serving_label. Omit everything else - an omitted nutrient is recorded as unknown, which is correct and useful. Never fill this in from memory.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "value"],
          properties: {
            key: { type: "string", enum: MICRO_KEYS },
            value: { type: "number" },
          },
        },
      },
    },
  },
};

const RESOLVE_SYSTEM = `You look up published nutrition facts for a single food product and record what you find.

Where to look, in order of preference:
- The manufacturer's or restaurant chain's own site is always the best source.
- Failing that, an established nutrition database - nutritionix, fatsecret, calorieking, myfooddata, fastfoodnutrition - is acceptable, and often the only place a chain's numbers exist outside a PDF. Record it honestly as source_tier "aggregator" so it can be double-checked.
- A blog, a forum post or a retailer listing is not a nutrition source. If that is all you can find, set found to false.

How to work:
- Search for the manufacturer's or restaurant chain's own nutrition information first. Their published figures are the answer; your own knowledge is the fallback, not the starting point.
- Read the actual page. Do not answer from memory even when you are confident - being confident and wrong is the exact failure this exists to correct.
- Match the VARIANT carefully. "Texas toast" from a chain is not the same product as frozen garlic Texas toast, and a 26 g protein shake is not the 42 g one. If you cannot confirm the exact variant, say so in note and lower your confidence.
- Record the numbers for ONE of the source's own servings, and put the portion the user ate in servings_consumed. Do not pre-multiply.
- Copy only the nutrients the source actually prints. Most labels list very few micronutrients; that is expected and an omission is recorded honestly as unknown.
- If you genuinely cannot find published data, set found to false and confidence to low rather than inventing a source.

Call record_reference exactly once, at the end.`;

export interface ResolveResult {
  /** Scaled to the portion the user actually ate. */
  nutrients: Nutrients;
  /** The source's own per-serving figures, unscaled - what belongs in the pantry. */
  perServing: Nutrients;
  /** How many of the source's servings the portion was. */
  servings: number;
  meta: EstimateMeta;
  record: ReferenceRecord;
}

/**
 * Whether the most recent failed lookup was transient (a timeout, a network error) rather
 * than a genuine "this product publishes nothing". Read immediately after a null return.
 *
 * A module-level flag is not elegant, but the alternative is widening the return type of a
 * function whose whole contract is "returns null on any failure", and every caller would
 * then have to destructure a result they mostly ignore.
 */
let lastFailureWasTransient = false;
export function lastLookupFailureWasTransient(): boolean {
  return lastFailureWasTransient;
}

export interface ResolveOptions {
  /** Accumulates what this request spends, so the UI can report it. */
  meter?: CostMeter;
  /** Absolute epoch ms after which this lookup must stop, shared across the request. */
  deadlineAt: number;
  logger: pino.Logger;
  model: string;
  /**
   * Effort for the LOOKUP, which is deliberately not the effort used for parsing.
   *
   * Reading a number off a page is retrieval, not reasoning - the hard thinking already
   * happened when the parse call worked out which product and what portion. Running this
   * at the parse's effort spent the entire wall-clock budget on two items and grounded
   * neither, so the whole request fell back to estimates it had already paid for.
   */
  effort: "low" | "medium" | "high" | "xhigh" | "max";
}

/** Server-side search + fetch, restricted to sources worth trusting for nutrition data. */
function groundingTools(): Anthropic.ToolUnion[] {
  return [
    {
      type: "web_search_20260209",
      name: "web_search",
      max_uses: 2,
      // No allowed_domains.
      //
      // It was a hand-maintained list of 29 manufacturer sites, and a hand-maintained list
      // cannot cover what one person actually eats. Red Bull is not on it, so a search for
      // one of the most documented products in existence was confined to domains that do
      // not carry it - and spent 71 seconds and the entire request budget failing.
      //
      // Source quality is handled where it belongs instead: the prompt says to prefer the
      // manufacturer, and every result records source_tier and source_url so an aggregator
      // value is visible as one. Restricting the search bought less quality than it cost in
      // outright failures.
    },
    {
      type: "web_fetch_20260209",
      name: "web_fetch",
      max_uses: 2,
      // The single biggest cost lever in this file, and it was set far too high.
      //
      // Server tools run an internal model loop, and every iteration re-processes the
      // accumulated tool results - so fetched page content is paid for repeatedly, not
      // once. At 20000 tokens per fetch that produced measured lookups of 71k-141k input
      // tokens, or $0.39-$0.76 EACH, against a 4k-token parse call at $0.05.
      //
      // A Nutrition Facts panel is a small table. 5000 tokens is comfortably enough for
      // it plus surrounding context; the other 15000 was navigation, marketing copy and
      // related-products carousels, re-billed on every internal turn.
      max_content_tokens: 5000,
    },
    RECORD_TOOL,
  ] as Anthropic.ToolUnion[];
}

/**
 * Look up one product. Returns null on any failure, timeout or not-found.
 *
 * Never throws: the caller already holds a usable estimate, and losing the user's whole
 * dictation because a website was slow would be a far worse bug than an ungrounded number.
 */
export async function resolveOne(
  client: Anthropic,
  args: { name: string; brand: string; spokenPortion: string; transcript: string },
  opts: ResolveOptions,
): Promise<ResolveResult | null> {
  const { logger: log, deadlineAt } = opts;
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs < 5_000) {
    log.info({ food: args.name }, "skipping lookup - not enough time left in the budget");
    return null;
  }

  // AbortController rather than Promise.race: a race leaves the losing request streaming
  // in the background, still burning tokens and holding a connection, while we move on.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingMs);
  const startMs = Date.now();

  try {
    const ask =
      `Find the published nutrition facts for this product:\n` +
      `  product: ${args.brand ? `${args.brand} ` : ""}${args.name}\n` +
      `  portion the user described: ${args.spokenPortion || "not stated"}\n\n` +
      `For context, they said: "${args.transcript.slice(0, 500)}"`;

    let messages: Anthropic.MessageParam[] = [{ role: "user", content: ask }];
    let record: ReferenceRecord | null = null;
    // Accumulated across the whole pause_turn loop. Without this, grounding spend is
    // invisible: a lookup can pull tens of thousands of input tokens of fetched page
    // content, and none of it appeared in any log, so nobody could see what it cost.
    let inputTokens = 0, outputTokens = 0, searches = 0;

    // A server-tool turn can stop with `pause_turn` when the tool loop hits its internal
    // limit. Resuming means re-sending the assistant turn unchanged WITH the same tools -
    // dropping the tools array 400s. Capped so a pathological loop cannot run forever.
    for (let attempt = 0; attempt < 5 && !record; attempt++) {
      const message: Anthropic.Message = await client.messages.create(
        {
          model: opts.model,
          max_tokens: 8000,
          system: RESOLVE_SYSTEM,
          tools: groundingTools(),
          output_config: { effort: opts.effort },
          messages,
        },
        { signal: controller.signal },
      );

      inputTokens += message.usage?.input_tokens ?? 0;
      outputTokens += message.usage?.output_tokens ?? 0;
      searches += message.usage?.server_tool_use?.web_search_requests ?? 0;

      record = readRecord(message, log);
      if (record) break;

      if (message.stop_reason === "pause_turn") {
        messages = [...messages, { role: "assistant", content: message.content }];
        continue;
      }

      // Deliberately NO retry nudge here.
      //
      // Resending the conversation to ask again means re-paying for every fetched page in
      // it - measured at 78k-99k input tokens for lookups that then still found nothing.
      // The fallback estimate is already in hand and is what a failed nudge would have
      // left us with anyway, so the nudge bought nothing and cost roughly $0.50 a time.
      break;
    }

    opts.meter?.record("resolveOne", opts.model, { inputTokens, outputTokens, webSearches: searches });
    if (!record) {
      // No usable record is NOT a definitive "this product publishes nothing" - the
      // pause_turn loop may have been exhausted, the turn may have been narration-only, or
      // it may have hit max_tokens. Mark it transient so the caller doesn't blacklist the
      // food for a fortnight over a non-answer. (Every return path must set this flag; the
      // caller reads it synchronously right after we return.)
      lastFailureWasTransient = true;
      log.warn(
        { food: args.name, ms: Date.now() - startMs,
          claude: { method: "resolveOne", model: opts.model, inputTokens, outputTokens, webSearches: searches } },
        "lookup produced no reference record",
      );
      return null;
    }
    // A definitive "searched and found nothing" - the one case worth remembering.
    lastFailureWasTransient = false;
    if (!record.found || record.source_tier === "none") {
      log.info(
        { food: args.name, note: record.note,
          claude: { method: "resolveOne", model: opts.model, inputTokens, outputTokens, webSearches: searches } },
        "no published data found - keeping the estimate",
      );
      return null;
    }

    const servings = Number.isFinite(record.servings_consumed) && record.servings_consumed > 0
      ? record.servings_consumed
      : 1;

    // Scale the label's per-serving values in TypeScript. Same reasoning as the pantry:
    // arithmetic on a self-consistent label stays self-consistent, and unknown stays
    // unknown rather than becoming zero.
    const perServing = sanitizeNutrients({
      ...record.macros,
      ...Object.fromEntries((record.micronutrients ?? []).map((m) => [m.key, m.value])),
    }, log);

    const nutrients = sanitizeNutrients(
      Object.fromEntries(
        NUTRIENT_KEYS.map((k) => {
          const v = perServing[k];
          return [k, v === null ? null : Math.round(v * servings * 1000) / 1000];
        }),
      ),
      log,
    );

    const meta: EstimateMeta = {
      basis: "published_label",
      brand: args.brand || undefined,
      confidence: record.confidence,
      source_url: record.source_url || undefined,
      source_title: record.source_title || undefined,
    };
    if (record.serving_grams > 0) {
      meta.grams = Math.round(record.serving_grams * servings * 10) / 10;
      meta.grams_basis = "label_serving";
    }
    if (record.note) meta.assumptions = record.note;

    log.info(
      {
        food: args.name, calories: nutrients.calories, servings,
        tier: record.source_tier, confidence: record.confidence,
        source: record.source_url, ms: Date.now() - startMs,
        // Same shape as the parse call's `claude` block, so one log query totals the bill.
        claude: { method: "resolveOne", model: opts.model, inputTokens, outputTokens, webSearches: searches },
      },
      "grounded from published data",
    );

    return { nutrients, perServing, servings, meta, record };
  } catch (err) {
    // The SDK does not throw a DOMException named "AbortError" - it surfaces the abort as
    // an error whose message is "Request was aborted.". Matching on `.name` therefore never
    // fired, and a 71-second timeout on Red Bull was logged as a generic failure. That
    // mattered for more than the log line: the caller uses this distinction to decide
    // whether to remember the food as "no data available", and a timeout is not that.
    const message = (err as Error)?.message ?? "";
    const timedOut =
      (err as Error)?.name === "AbortError" ||
      /aborted|timeout|timed out/i.test(message);
    log.warn(
      { food: args.name, err: message, timedOut, ms: Date.now() - startMs },
      timedOut ? "lookup ran out of time - keeping the estimate" : "lookup failed - keeping the estimate",
    );
    // Distinguishable by the caller: null means "no usable result", and `timedOut` says
    // whether that is a fact about the food or a fact about today's network.
    lastFailureWasTransient = timedOut || !/refus/i.test(message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Micronutrient pass ─────────────────────────────────────────────────────
//
// Nutrition labels are legally required to print four micronutrients: vitamin D, calcium,
// iron and potassium. Magnesium, zinc, selenium, B6, B12, thiamin, riboflavin, niacin,
// folate, vitamin E and vitamin K appear on almost nothing. So grounding - which is the
// right answer for calories, macros, fiber, sugar and sodium - structurally cannot fill
// eleven of the tracked nutrients, and the omit-rather-than-guess rule correctly refuses
// to invent them. Measured on the August entries: vitamin E and K at 4.3% coverage,
// vitamin D 8.7%, folate/thiamin/selenium 13%.
//
// Those have to come from food composition reasoning or not at all. The reason the main
// parse call omits them is not that the model cannot estimate them - it is that it has no
// confirmed identity and no mass to reason from, so refusing is correct. By this point it
// has both. Asking separately, with the portion mass and the label macros already fixed,
// is a different and much more answerable question.

/** The nutrients no label prints, which therefore can only come from composition. */
export const COMPOSITION_ONLY_KEYS = MICRO_KEYS.filter(
  (k) => !["vitamin_d_mcg", "calcium_mg", "iron_mg", "potassium_mg", "sodium_mg",
           "fiber_g", "sugar_g", "saturated_fat_g", "cholesterol_mg", "caffeine_mg",
           "alcohol_g"].includes(k),
);

const MICRO_TOOL: Anthropic.Tool = {
  name: "record_micronutrients",
  description: "Record the micronutrients you can estimate from this food's composition. Call once.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["micronutrients", "note"],
    properties: {
      micronutrients: {
        type: "array",
        description:
          "Nutrients you can estimate from what this food is made of, for the WHOLE portion described. Omit any you have no reasonable basis for - an omission is recorded honestly as unknown and is far better than a guess.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "value"],
          properties: {
            key: { type: "string", enum: COMPOSITION_ONLY_KEYS },
            value: { type: "number", description: "Amount for the whole portion, in the unit named by the key." },
          },
        },
      },
      note: { type: "string", description: "One sentence on what you reasoned from. Empty string if obvious." },
    },
  },
};

const MICRO_SYSTEM = `You estimate the micronutrients that nutrition labels do not print.

You are given a food that has already been identified, with its portion mass and its major nutrients settled. Your only job is the nutrients a label would not carry: magnesium, zinc, selenium, B vitamins, folate, vitamin E, vitamin K, phosphorus and similar.

How to work:
- Reason from what the food is MADE OF and how much of it there is. A 44 g slice of enriched white bread has a knowable thiamin and folate content because enriched flour is fortified to a standard; a 190 g portion of breaded fried chicken has knowable selenium and B6 from the meat.
- The portion mass is the anchor. Estimate per 100 g from composition, then scale to the mass given.
- Omit anything you cannot reason about. A composed restaurant dish of unknown recipe may warrant very few values, and that is the correct answer - unknown is recorded as unknown, not as zero.
- Do not restate calories, protein, fat, carbohydrate, fiber, sugar, sodium, calcium, iron, potassium or vitamin D. Those are already known and are not yours to change.`;

/**
 * Fill in the composition-derived micronutrients for one already-identified item.
 *
 * Only ever ADDS: a value already known from a label is never overwritten. Returns the
 * merged nutrients, or the originals unchanged on any failure.
 */
export async function enrichMicronutrients(
  client: Anthropic,
  args: { name: string; grams?: number; nutrients: Nutrients },
  opts: ResolveOptions,
): Promise<Nutrients> {
  const { logger: log, deadlineAt } = opts;
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs < 4_000) return args.nutrients;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingMs);
  try {
    const n = args.nutrients;
    const known =
      `calories ${n.calories}, protein ${n.protein_g} g, fat ${n.fat_g} g, carbs ${n.carbs_g} g` +
      (n.fiber_g !== null ? `, fiber ${n.fiber_g} g` : "") +
      (n.sodium_mg !== null ? `, sodium ${n.sodium_mg} mg` : "");

    const message = await client.messages.create(
      {
        model: opts.model,
        max_tokens: 4000,
        system: MICRO_SYSTEM,
        tools: [MICRO_TOOL],
        tool_choice: { type: "tool", name: "record_micronutrients" },
        output_config: { effort: opts.effort },
        messages: [{
          role: "user",
          content:
            `Food: ${args.name}\n` +
            `Portion: ${args.grams ? `${args.grams} g` : "mass not established"}\n` +
            `Already known for this portion: ${known}\n\n` +
            `Estimate the micronutrients a label would not print.`,
        }],
      },
      { signal: controller.signal },
    );

    opts.meter?.record("enrichMicronutrients", opts.model, {
      inputTokens: message.usage?.input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
    });

    const block = message.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "record_micronutrients",
    );
    if (!block) return args.nutrients;

    const input = block.input as { micronutrients: Array<{ key: string; value: number }>; note: string };
    const additions = sanitizeNutrients(
      Object.fromEntries((input.micronutrients ?? []).map((m) => [m.key, m.value])),
      log,
    );

    // Merge, never overwrite. A label value outranks a composition estimate every time.
    const merged = { ...args.nutrients };
    let added = 0;
    for (const key of COMPOSITION_ONLY_KEYS) {
      if (merged[key] === null && additions[key] !== null) {
        merged[key] = additions[key];
        added++;
      }
    }
    log.info(
      {
        food: args.name, added, note: input.note,
        // Same `claude` block shape as the other two call sites. This was missing, which
        // meant the per-log cost reported after a pantry hit was understated - the pass
        // ran, added 13 nutrients, and cost nothing as far as any log could tell.
        claude: {
          method: "enrichMicronutrients", model: opts.model,
          inputTokens: message.usage?.input_tokens ?? 0,
          outputTokens: message.usage?.output_tokens ?? 0,
        },
      },
      "micronutrient pass complete",
    );
    return merged;
  } catch (err) {
    log.warn({ food: args.name, err: (err as Error)?.message }, "micronutrient pass failed - keeping what we have");
    return args.nutrients;
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the forced tool call's already-parsed input out of a response. */
function readRecord(message: Anthropic.Message, log: pino.Logger): ReferenceRecord | null {
  for (const block of message.content) {
    if (block.type === "tool_use" && block.name === "record_reference") {
      return block.input as ReferenceRecord;
    }
  }
  if (message.stop_reason === "refusal") {
    log.warn("lookup was declined by safety classifiers");
  }
  return null;
}

/**
 * Run several lookups with a concurrency cap and one shared deadline.
 *
 * The cap exists because the deadline is wall-clock: eight items firing at once would each
 * get the full budget and all finish late together, whereas three at a time means the
 * early ones land while there is still time to use them.
 */
export async function resolveAll<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency = 3,
): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      await worker(next);
    }
  });
  await Promise.all(runners);
}
