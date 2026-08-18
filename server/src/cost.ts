// cost.ts
// What one log actually cost, in dollars.
//
// A log now makes between one and five model calls depending on what you ate - a parse,
// zero or more published-label lookups, and a composition pass for the nutrients no label
// prints. That range is $0.03 to well over $1.00, and until this file existed the only way
// to know which you had just paid for was to grep the server log afterwards.
//
// The numbers below are Anthropic's published list prices. They are hardcoded rather than
// fetched because a price that silently changes under you is worse than one that is
// visibly stale: this figure is for budgeting, and a wrong-but-confident number is the
// failure mode to avoid. Check them when you change models.

import { CallCost, LogCostSummary } from "./types";

/** USD per million tokens, by model id prefix. Longest match wins. */
const PRICING: Array<{ prefix: string; inputPerM: number; outputPerM: number }> = [
  { prefix: "claude-opus-5", inputPerM: 5, outputPerM: 25 },
  { prefix: "claude-opus-4", inputPerM: 5, outputPerM: 25 },
  { prefix: "claude-sonnet-5", inputPerM: 3, outputPerM: 15 },
  { prefix: "claude-sonnet-4", inputPerM: 3, outputPerM: 15 },
  { prefix: "claude-haiku-4", inputPerM: 1, outputPerM: 5 },
  { prefix: "claude-fable-5", inputPerM: 10, outputPerM: 50 },
];

/** Server-side web search is billed per request, separately from tokens. */
const USD_PER_WEB_SEARCH = 10 / 1000;

function priceFor(model: string): { inputPerM: number; outputPerM: number } {
  const match = PRICING
    .filter((p) => model.startsWith(p.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  // An unknown model prices at zero rather than guessing. A zero is visibly wrong in the
  // UI and prompts a look at this table; an invented price quietly corrupts the budget.
  return match ?? { inputPerM: 0, outputPerM: 0 };
}

/**
 * Accumulates the cost of every model call made while handling one request.
 *
 * Created per request and threaded through, rather than being a module-level singleton,
 * because two logs can be in flight at once and their costs must not merge.
 */
export class CostMeter {
  private readonly calls: CallCost[] = [];

  record(method: string, model: string, usage: {
    inputTokens?: number;
    outputTokens?: number;
    webSearches?: number;
  }): void {
    const { inputPerM, outputPerM } = priceFor(model);
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const webSearches = usage.webSearches ?? 0;
    this.calls.push({
      method,
      inputTokens,
      outputTokens,
      webSearches,
      usd:
        (inputTokens / 1e6) * inputPerM +
        (outputTokens / 1e6) * outputPerM +
        webSearches * USD_PER_WEB_SEARCH,
    });
  }

  total(): LogCostSummary {
    const sum = (pick: (c: CallCost) => number) => this.calls.reduce((n, c) => n + pick(c), 0);
    return {
      // Four decimal places: a cheap log is $0.03 and rounding to cents would render the
      // common case as "$0.03" and the very cheapest as "$0.00", which reads as free.
      usd: Math.round(sum((c) => c.usd) * 10000) / 10000,
      inputTokens: sum((c) => c.inputTokens),
      outputTokens: sum((c) => c.outputTokens),
      webSearches: sum((c) => c.webSearches),
      calls: this.calls,
    };
  }
}
