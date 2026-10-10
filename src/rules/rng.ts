/**
 * Random number sources. Every function that rolls dice takes an optional `Rng`, so tests,
 * replays and multiplayer sessions can be deterministic.
 */

import type { Message } from "../models/messages";

export interface Rng {
  /** A uniformly random integer in `[min, max]`, both inclusive. */
  int(min: number, max: number): number;
  /**
   * Told before a group of dice is drawn: who rolls them and what for. An encounter uses it to
   * stop for dice rolled at the table (`dice: "table"`); other sources ignore it.
   */
  dice?(request: DiceRequest): void;
}

/** A group of dice about to be drawn (`Rng.dice`). */
export interface DiceRequest {
  /** The combatant id whose roll it is (`null`: nobody's, the engine rolls it). */
  readonly by: string | null;
  readonly count: number;
  readonly sides: number;
  /** Two d20s for Advantage (`higher`) or Disadvantage (`lower`). */
  readonly keep: "higher" | "lower" | null;
  /** What it's for: "Dexterity saving throw", "fire damage for Fireball". */
  readonly purpose: Message;
}

/** Announce the next dice to `rng` (a no-op for a plain source). */
export function announce(
  rng: Rng,
  count: number,
  sides: number,
  purpose: Message,
  keep: DiceRequest["keep"] = null,
): void {
  if (count > 0) rng.dice?.({ by: null, count, sides, keep, purpose });
}

/**
 * `rng` with the rolls made through it belonging to combatant `id`, unless something closer
 * says otherwise (a target's saving throw inside its caster's spell is the target's).
 */
export function rollingFor(rng: Rng, id: string | null | undefined): Rng {
  if (!id || !rng.dice) return rng;
  return {
    int: (min, max) => rng.int(min, max),
    dice: (request) => rng.dice?.({ ...request, by: request.by ?? id }),
  };
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
