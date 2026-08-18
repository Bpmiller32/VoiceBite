// eval/run.ts
// Measure the estimator against the stored corpus, and diff two measurements.
//
//   npm run eval -- --tag before          measure and save as "before"
//   npm run eval -- --diff before after   compare two saved measurements
//   npm run eval -- --tag x --user billy  non-default user
//
// Three of the four metrics need no ground truth, so this is runnable today, on real
// data, before a single line of the pipeline changes. That baseline is the whole point:
// without a frozen "before" row, every later claim about accuracy is an anecdote.

import "../env";
import fs from "fs";
import path from "path";
import { initLogger } from "../logger";
import { listDates, readDayLog } from "../store";
import { DayLog } from "../types";
import { buildReport, EvalReport, GoldItem } from "./metrics";

const RESULTS_DIR = path.resolve(__dirname, "results");
const GOLD_PATH = path.resolve(__dirname, "gold.json");

function loadCorpus(userId: string, from?: string, to?: string): DayLog[] {
  const days: DayLog[] = [];
  for (const date of listDates(userId)) {
    if (from && date < from) continue;
    if (to && date > to) continue;
    const day = readDayLog(userId, date);
    if (day) days.push(day);
  }
  return days;
}

function loadGold(): GoldItem[] | null {
  if (!fs.existsSync(GOLD_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(GOLD_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed : parsed.items ?? null;
  } catch (err) {
    console.error(`Could not read ${GOLD_PATH}: ${(err as Error).message}`);
    return null;
  }
}

function save(report: EvalReport): string {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `${report.tag}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf-8");
  return file;
}

function load(tag: string): EvalReport {
  const file = path.join(RESULTS_DIR, `${tag}.json`);
  if (!fs.existsSync(file)) {
    console.error(`No saved measurement named "${tag}". Run: npm run eval -- --tag ${tag}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

const pct = (n: number) => `${n.toFixed(1)}%`;

function print(r: EvalReport): void {
  const { atwater: a, selfAgreement: s, coverage: c } = r;

  const slice = r.from || r.to ? `  [${r.from ?? "start"} .. ${r.to ?? "end"}]` : "";
  console.log(`\n  ${r.tag}${slice}\n  ${r.days} days, ${a.entries} scorable food entries, measured ${r.measuredAt.slice(0, 16).replace("T", " ")}\n`);

  // Two different things, deliberately labelled apart. The residual is a soft quality
  // signal - a food can sit below the naive macro sum legitimately (fiber, allulose,
  // sugar alcohols). "Impossible" is the hard count: entries whose protein and fat alone
  // exceed their stated calories, which no labelling convention permits.
  console.log("  MACRO PLAUSIBILITY (how far do the macros sit from the calorie count?)");
  console.log(`    residual p50 ${pct(a.p50)}   p90 ${pct(a.p90)}`);
  console.log(`    beyond 5%:  ${a.over5pct} of ${a.entries}  (${pct((a.over5pct / a.entries) * 100)})`);
  console.log(`    beyond 10%: ${a.over10pct}   beyond 20%: ${a.over20pct}`);
  console.log(`    PHYSICALLY IMPOSSIBLE: ${a.impossible}   <- the hard failures`);
  if (a.worst.length) {
    console.log("    worst:");
    for (const w of a.worst.slice(0, 4)) {
      console.log(`      ${pct(w.residualPct).padStart(7)}  ${w.calories} kcal  ${w.name.slice(0, 52)}`);
    }
  }

  console.log("\n  SELF-AGREEMENT (does the same food get the same numbers twice?)");
  console.log(`    repeat groups: ${s.groups}   fully stable: ${s.stableGroups}`);
  console.log(`    disagree on any nutrient: ${s.unstableGroups}   on calories: ${s.calorieUnstableGroups}`);
  console.log(`    entries sitting in a disagreeing group: ${pct(s.unstableEntryShare * 100)}`);
  console.log(`    worst calorie spread: ${s.worstCalorieSpread.toFixed(2)}x`);
  if (s.worst.length) {
    console.log("    worst:");
    for (const g of s.worst.slice(0, 4)) {
      const sp = g.spreads.calories ? `${g.spreads.calories.toFixed(2)}x` : "  -  ";
      console.log(`      ${sp.padStart(7)}  n=${g.count}  [${g.calorieValues.join("/")}]  ${g.key.slice(0, 46)}`);
    }
  }

  console.log("\n  MICRONUTRIENT COVERAGE (how much is actually estimated?)");
  console.log(`    mean across micronutrients: ${pct(c.microMean * 100)}`);
  console.log(`    of all known values, exactly zero: ${pct(c.hardZeroShare * 100)}`);
  const sparse = Object.entries(c.byNutrient)
    .filter(([, v]) => v < 0.5)
    .sort((x, y) => x[1] - y[1])
    .slice(0, 6);
  if (sparse.length) {
    console.log(`    thinnest: ${sparse.map(([k, v]) => `${k} ${pct(v * 100)}`).join(", ")}`);
  }

  if (r.gold) {
    console.log("\n  GOLD SET (measured against published values)");
    console.log(`    entries covered: ${r.gold.covered}`);
    for (const [k, v] of Object.entries(r.gold.byNutrient)) {
      console.log(`      ${k.padEnd(18)} MAPE ${pct(v.mape).padStart(8)}  (n=${v.n})`);
    }
    if (r.gold.worst.length) {
      console.log("    worst:");
      for (const w of r.gold.worst.slice(0, 5)) {
        console.log(`      ${pct(w.errPct).padStart(8)}  ${w.nutrient} ${w.got} vs ${w.expected}  ${w.name.slice(0, 40)}`);
      }
    }
  } else {
    console.log("\n  GOLD SET: not built yet (eval/gold.json absent)");
  }
  console.log("");
}

function arrow(before: number, after: number, lowerIsBetter = true): string {
  const d = after - before;
  if (Math.abs(d) < 1e-9) return "  =  ";
  const better = lowerIsBetter ? d < 0 : d > 0;
  return `${better ? "+" : "!"} ${d > 0 ? "+" : ""}${d.toFixed(2)}`;
}

function diff(a: EvalReport, b: EvalReport): void {
  console.log(`\n  ${a.tag} -> ${b.tag}\n`);
  const row = (label: string, x: number, y: number, lower = true) =>
    console.log(`    ${label.padEnd(38)} ${String(x).padStart(8)} ${String(y).padStart(8)}   ${arrow(x, y, lower)}`);

  console.log(`    ${"".padEnd(38)} ${a.tag.slice(0, 8).padStart(8)} ${b.tag.slice(0, 8).padStart(8)}`);
  row("macro residual p50 (%)", a.atwater.p50, b.atwater.p50);
  row("entries over 5%", a.atwater.over5pct, b.atwater.over5pct);
  row("physically impossible", a.atwater.impossible, b.atwater.impossible);
  row("disagreeing repeat groups", a.selfAgreement.unstableGroups, b.selfAgreement.unstableGroups);
  row("worst calorie spread (x)", a.selfAgreement.worstCalorieSpread, b.selfAgreement.worstCalorieSpread);
  row("micronutrient coverage (%)", round1(a.coverage.microMean * 100), round1(b.coverage.microMean * 100), false);
  row("hard zeros among known (%)", round1(a.coverage.hardZeroShare * 100), round1(b.coverage.hardZeroShare * 100));
  if (a.gold && b.gold) {
    for (const k of Object.keys(b.gold.byNutrient)) {
      if (a.gold.byNutrient[k]) row(`gold MAPE ${k} (%)`, a.gold.byNutrient[k].mape, b.gold.byNutrient[k].mape);
    }
  }
  console.log("");
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function main(): void {
  // store.ts calls getLogger() on every read. Initialise it silently: this is a
  // measurement tool pointed at production data, and it should not append hundreds of
  // lines to the real log just for reading files. Set inside main(), not at module
  // scope, because import bodies are evaluated before top-level statements.
  process.env.LOG_LEVEL = "silent";
  initLogger("cli");

  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const userId = flag("user") ?? process.env.DEFAULT_USER ?? "billy";

  const diffPair = argv.indexOf("--diff");
  if (diffPair >= 0) {
    diff(load(argv[diffPair + 1]), load(argv[diffPair + 2]));
    return;
  }

  const tag = flag("tag") ?? "current";
  const from = flag("from");
  const to = flag("to");
  const days = loadCorpus(userId, from, to);
  if (days.length === 0) {
    console.error(
      `No day logs found for user "${userId}"${from || to ? ` in ${from ?? "start"}..${to ?? "end"}` : ""}. ` +
      `Check DATA_DIR in server/.env.`,
    );
    process.exit(1);
  }
  const report = buildReport(tag, days, loadGold(), { from, to });
  print(report);
  console.log(`  saved ${path.relative(process.cwd(), save(report))}\n`);
}

main();
