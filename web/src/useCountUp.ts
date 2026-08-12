// A number that travels to its new value instead of teleporting.
//
// Used on the one figure worth watching change - the day's calorie total. Applying this
// to every number on screen would be noise: motion draws the eye, so it should be spent
// where a change actually matters.
//
// No dependency: rAF and an easing function are the whole implementation.

import { useEffect, useRef, useState } from "react";

/** True when the OS asks for reduced motion. Read live, not cached at module load. */
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Same curve as --ease-out in the stylesheet, so a counting number and a rising card
// feel like they belong to the same system.
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export function useCountUp(target: number, duration = 650): number {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    // Honour the OS setting, and skip the work entirely when there's nothing to animate.
    if (prefersReducedMotion() || !Number.isFinite(target) || fromRef.current === target) {
      fromRef.current = target;
      setValue(target);
      return;
    }

    const from = fromRef.current;
    const delta = target - from;
    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      setValue(from + delta * easeOut(t));
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        // Land on the exact target rather than whatever the easing rounded to - an
        // animated total that settles one kcal off its own subtitle looks like a bug.
        fromRef.current = target;
        setValue(target);
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      // Whatever happens next should travel from where we actually stopped, not from
      // a value the user never saw.
      fromRef.current = target;
    };
  }, [target, duration]);

  return value;
}
