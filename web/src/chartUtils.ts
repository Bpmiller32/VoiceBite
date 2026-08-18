// Shared chart primitives for the History screen and its second-tier InsightCharts.
//
// Both files used to carry byte-identical copies of these plus two DIVERGENT dateSequence
// implementations - a fix that keeps the newest days when a range runs past the cap landed
// in one copy and never reached the other. One source of truth removes that trap and means a
// future tweak (or a second web frontend) can't silently apply to only one chart file.

/** recharts axis tick style and grid colour, read from the theme's CSS variables. */
export const AXIS_TICK = { fill: "var(--chart-axis)", fontSize: 11 };
export const GRID = "var(--chart-grid)";

/** "4/18" - a compact axis label. */
export const tickDate = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

/** "Sat, Apr 18" - a tooltip header. */
export const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

/** Shift a YYYY-MM-DD by N days. Noon avoids the DST-midnight-rolls-backwards trap. */
function shiftIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Inclusive YYYY-MM-DD sequence, walked BACKWARDS from `to` so the cap keeps the most recent
 * days. Building it forwards meant an "All time" range longer than the cap silently dropped
 * the newest days - the half the user actually looks at. Capped so a corrupt range can't spin.
 */
export function dateSequence(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = to;
  while (cursor >= from && out.length < 1500) {
    out.push(cursor);
    cursor = shiftIso(cursor, -1);
  }
  return out.reverse();
}

/**
 * Trailing mean over the values that exist in the window, skipping nulls and requiring
 * `minSamples` real points so the line doesn't draw a confident stroke straight across a gap.
 * Rounded to one decimal - plenty for both a calorie trend and a noisy weight line.
 */
export function rollingMean(values: (number | null)[], window = 7, minSamples = 3): (number | null)[] {
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      const v = values[j];
      if (v !== null) {
        sum += v;
        n += 1;
      }
    }
    return n >= minSamples ? Math.round((sum / n) * 10) / 10 : null;
  });
}
