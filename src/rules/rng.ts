/**
 * Random number sources. Every function that rolls dice takes an optional `Rng`, so tests,
 * replays and multiplayer sessions can be deterministic.
 */

export interface Rng {
  /** A uniformly random integer in `[min, max]`, both inclusive. */
  int(min: number, max: number): number;
}

/** Backed by `Math.random()`. Not seedable; the default when no `Rng` is given. */
export const mathRng: Rng = {
  int: (min, max) => min + Math.floor(Math.random() * (max - min + 1)),
};

/**
 * A seeded generator (mulberry32). The same seed always yields the same sequence, on every
 * platform. Not suitable for cryptography.
 */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { int: (min, max) => min + Math.floor(next() * (max - min + 1)) };
}

/** An `Rng` that returns the given values in order: handy for tests ("force a natural 20"). */
export function scriptedRng(values: Iterable<number>): Rng {
  const it = values[Symbol.iterator]();
  return {
    int: () => {
      const { value, done } = it.next();
      if (done) throw new Error("scriptedRng ran out of values");
      return value;
    },
  };
}

/** An `Rng` that always returns `value`. */
export function fixedRng(value: number): Rng {
  return { int: () => value };
}
