// backfill.ts
// Populate the food library from the foods you already eat, once, up front.
//
//   npm run backfill              look up your top repeat foods, review each, save
//   npm run backfill -- --limit 40 --from 2026-04-01
//   npm run backfill -- --dry-run          resolve and print, write nothing
//   npm run backfill -- --auto             accept confident results without prompting,
//                                          and set aside anything that needs your eyes
//   npm run backfill -- --gold             also emit eval/gold.json from what you accept
//
// Why this exists: 27 distinct foods account for 23% of the logged calories in this
// corpus, and every one of them is currently re-derived from scratch on every logging.
// Resolving them once turns the most common case - logging a food you have had before -
// into a table lookup that is instant, free, and identical every time.
//
// It is also the cheapest way to make the first week bearable. Without it, every familiar
// food pays a 30-second cold lookup the first time you log it after the change.
//
// Review is interactive on purpose. A lookup can find the wrong variant - "Texas Toast"
// versus "Garlic Texas Toast, frozen" - and a human takes one second to see it. An
// accepted row is pinned as verified_by "owner", which no later automated lookup may
// overwrite; skipping leaves the food to be resolved normally at log time.

import "./env";
import fs from "fs";
import path from "path";
import readline from "readline";
import Anthropic from "@anthropic-ai/sdk";
import { initLogger, getLogger } from "./logger";
import { readFoodStats, todayDateString, type FoodStat } from "./store";
import { readPantry, upsertItem, pantryKey, type PantryItem } from "./pantry";
import { resolveOne, resolveAll, type ResolveResult } from "./resolver";
import { NUTRIENT_KEYS } from "./types";

function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

interface Args {
  user: string;
  from: string;
  to: string;
  limit: number;
  dryRun: boolean;
  gold: boolean;
  auto: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const to = flag("to") ?? todayDateString();
  return {
    user: flag("user") ?? process.env.DEFAULT_USER ?? "billy",
    // Default window covers the whole corpus - the point is your staples, not last week's.
    from: flag("from") ?? "2020-01-01",
    to,
    limit: parseInt(flag("limit") ?? "30"),
    dryRun: argv.includes("--dry-run"),
    gold: argv.includes("--gold"),
    auto: argv.includes("--auto"),
  };
}

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "-" : String(v));

/** Foods worth resolving: eaten more than once, and not already pinned by the owner. */
function selectTargets(args: Args): FoodStat[] {
  const pantry = readPantry(args.user);
  const pinned = new Set(
    Object.values(pantry.items).filter((i) => i.verified_by === "owner").map((i) => i.key),
  );
  return readFoodStats(args.user, args.from, args.to, args.limit * 3)
    .filter((s) => s.count >= 2)
    .filter((s) => !pinned.has(s.key))
    .slice(0, args.limit);
}

async function main(): Promise<void> {
  const args = parseArgs();
  initLogger("cli");
  const log = getLogger();
  const client = new Anthropic({ maxRetries: 3, timeout: 10 * 60 * 1000 });
  const model = process.env.CLAUDE_MODEL || "claude-opus-5";
  // Offline and one-off, so correctness beats speed here in a way it cannot at log time.
  const effort = (process.env.CLAUDE_BACKFILL_EFFORT || "medium") as "low" | "medium" | "high";

  const targets = selectTargets(args);
  if (targets.length === 0) {
    console.log("\nNothing to back-fill: every repeat food is already pinned in your library.\n");
    return;
  }

  const totalLoggings = targets.reduce((n, t) => n + t.count, 0);
  console.log(
    `\nLooking up ${targets.length} foods you have logged ${totalLoggings} times between ` +
    `${args.from === "2020-01-01" ? "the beginning" : args.from} and ${args.to}.\n` +
    `This runs three at a time and takes roughly ${Math.ceil(targets.length / 3 * 30 / 60)} minutes.\n`,
  );

  // Generous per-item deadline: nobody is waiting on a screen.
  const results = new Map<string, ResolveResult | null>();
  let done = 0;
  await resolveAll(targets, async (stat) => {
    const result = await resolveOne(
      client,
      { name: stat.name, brand: "", spokenPortion: "", transcript: "" },
      { deadlineAt: Date.now() + 120_000, logger: log, model, effort },
    );
    results.set(stat.key, result);
    done++;
    process.stdout.write(`\r  resolved ${done}/${targets.length}   `);
  }, 3);
  console.log("\n");

  const accepted: Array<{ stat: FoodStat; result: ResolveResult }> = [];

  for (const stat of targets) {
    const result = results.get(stat.key);
    console.log("─".repeat(74));
    console.log(`${stat.name}`);
    console.log(`  you logged this ${stat.count}x, averaging ${stat.avg_calories} kcal per logging`);

    if (!result) {
      console.log(`  no published data found - it will be looked up normally when you log it\n`);
      continue;
    }

    const r = result.record;
    const n = result.perServing;
    console.log(`  found: ${r.source_title || r.display_name}`);
    console.log(`  per ${r.serving_label}: ${fmt(n.calories)} kcal | P${fmt(n.protein_g)} F${fmt(n.fat_g)} C${fmt(n.carbs_g)}` +
      `${n.sodium_mg !== null ? ` | Na ${n.sodium_mg}mg` : ""}${r.serving_grams ? ` | ${r.serving_grams}g` : ""}`);
    console.log(`  source: ${r.source_tier}  ${r.source_url}`);
    if (r.note) console.log(`  note: ${r.note}`);

    // Flag the case most worth a human glance: the found value disagrees sharply with what
    // has been logged. Either the old estimates were wrong - the point of this exercise -
    // or the lookup found the wrong variant.
    if (n.calories && stat.avg_calories) {
      const ratio = n.calories / stat.avg_calories;
      if (ratio < 0.6 || ratio > 1.7) {
        console.log(`  ** this is ${ratio > 1 ? "much higher" : "much lower"} than your logged average - check the variant`);
      }
    }

    if (args.dryRun) { console.log(""); continue; }

    // --auto accepts anything the lookup was reasonably sure of, and stops for the two
    // cases a human is actually needed for: low confidence, and a value that disagrees
    // sharply with what has been logged (usually the wrong variant).
    if (args.auto) {
      const ratio = n.calories && stat.avg_calories ? n.calories / stat.avg_calories : 1;
      const suspicious = ratio < 0.6 || ratio > 1.7;
      if (r.confidence === "low" || suspicious) {
        console.log(`  needs your eyes - left for manual review\n`);
        continue;
      }
      accepted.push({ stat, result });
      console.log("  accepted automatically\n");
      continue;
    }

    const answer = (await promptLine("  [a]ccept  [s]kip  [e]dit calories  > ")).trim().toLowerCase();
    if (answer === "s" || answer === "") { console.log("  skipped\n"); continue; }

    if (answer === "e") {
      const raw = (await promptLine(`  calories per ${r.serving_label}: `)).trim();
      const cal = Number(raw);
      if (Number.isFinite(cal) && cal > 0) {
        // Rescale the whole profile so the macros stay consistent with the new calories.
        const factor = n.calories ? cal / n.calories : 1;
        for (const key of NUTRIENT_KEYS) {
          const v = n[key];
          if (v !== null) n[key] = Math.round(v * factor * 1000) / 1000;
        }
        console.log(`  set to ${cal} kcal (macros scaled to match)`);
      } else {
        console.log("  not a number - skipping\n");
        continue;
      }
    }

    accepted.push({ stat, result });
    console.log("  accepted\n");
  }

  if (args.dryRun) {
    console.log(`\nDry run - nothing written. ${results.size} foods resolved.\n`);
    return;
  }

  for (const { stat, result } of accepted) {
    const r = result.record;
    const item: PantryItem = {
      key: pantryKey("", r.display_name || stat.name),
      display_name: r.display_name || stat.name,
      aliases: [stat.name, r.source_title].filter(Boolean),
      serving_label: r.serving_label || "1 serving",
      serving_grams: r.serving_grams > 0 ? r.serving_grams : 0,
      servings_per_container: r.servings_per_container > 0 ? r.servings_per_container : 0,
      per_serving: result.perServing,
      source_url: r.source_url,
      source_title: r.source_title,
      source_tier: r.source_tier === "none" ? "none" : r.source_tier,
      // You looked at it and said yes. Nothing automated overwrites that.
      verified_by: "owner",
      verified_at: new Date().toISOString(),
      log_count: stat.count,
    };
    upsertItem(args.user, item);
  }

  console.log(`\nSaved ${accepted.length} foods to your library.`);
  console.log(`Logging any of them is now instant, free, and identical every time.\n`);

  if (args.gold && accepted.length > 0) writeGoldSet(accepted);
}

/**
 * Emit an evaluation set from what was accepted: each food's foodKey, its published
 * per-serving values, and the source URL they came from, so a lookup can be scored against
 * the real number rather than a plausible one.
 *
 * Note the accepted foods have all just been pinned into the pantry above, so goldMetric
 * scores them against the same published labels they were seeded from - see the caveat on
 * goldMetric in eval/metrics.ts about what that measures and what it doesn't.
 */
function writeGoldSet(accepted: Array<{ stat: FoodStat; result: ResolveResult }>): void {
  const goldPath = path.resolve(__dirname, "eval", "gold.json");
  const items = accepted.map(({ stat, result }) => ({
    match: stat.key,
    display_name: result.record.display_name || stat.name,
    expected: Object.fromEntries(
      NUTRIENT_KEYS
        .map((k) => [k, result.perServing[k]])
        .filter(([, v]) => v !== null),
    ),
    source_url: result.record.source_url,
  }));

  fs.mkdirSync(path.dirname(goldPath), { recursive: true });
  fs.writeFileSync(goldPath, JSON.stringify(items, null, 2), "utf-8");
  console.log(`Wrote ${items.length} foods to eval/gold.json.`);
  console.log(`Run: npm run eval -- --tag after-backfill\n`);
}

main().catch((err) => {
  console.error(`\nBack-fill failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
