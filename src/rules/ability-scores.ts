/** Ability score generation and validation (SRD 5.2.1, Character Creation step 3). */

import type { AbilityMap, AbilityMethod } from "../models/build";
import { ABILITIES, type Ability, type CreationRules, type PointBuyRules } from "../models/content";
import type { Message } from "../models/messages";
import { message, RuleError } from "./messages";
import { mathRng, type Rng } from "./rng";

export interface AbilityRoll {
  readonly rolls: readonly number[];
  readonly dropped: number;
  readonly total: number;
}

/** Roll 4d6 and drop the lowest die. */
export function rollAbilityScore(rng: Rng = mathRng): AbilityRoll {
  const rolls = Array.from({ length: 4 }, () => rng.int(1, 6));
  const dropped = Math.min(...rolls);
  return { rolls, dropped, total: rolls.reduce((a, b) => a + b, 0) - dropped };
}

export function rollAbilityScores(rng: Rng = mathRng): AbilityRoll[] {
  return Array.from({ length: 6 }, () => rollAbilityScore(rng));
}

// --- Point buy ----------------------------------------------------------------------------

export interface PointBuyAbility {
  readonly score: number;
  readonly cost: number;
  /** Extra points for +1, `null` if already at the maximum. */
  readonly increase_cost: number | null;
  readonly can_increase: boolean;
  readonly can_decrease: boolean;
  /** Highest score reachable for this ability with the points left. */
  readonly max_affordable: number;
}

export interface PointBuyStatus {
  readonly budget: number;
  readonly spent: number;
  readonly remaining: number;
  readonly abilities: Readonly<Record<Ability, PointBuyAbility>>;
}

function costTable(rules: PointBuyRules, score: number): number | undefined {
  return Object.hasOwn(rules.costs, score) ? rules.costs[score] : undefined;
}

export function pointBuyCost(score: number, rules: PointBuyRules): number {
  const cost = costTable(rules, score);
  if (cost === undefined) {
    throw new RuleError(
      message("rule.point_buy_scores_must", {
        min_score: rules.min_score,
        max_score: rules.max_score,
        score,
      }),
    );
  }
  return cost;
}

/** Budget summary; abilities not yet set count as the minimum score (cost 0). */
export function pointBuyStatus(scores: AbilityMap, rules: PointBuyRules): PointBuyStatus {
  const full = Object.fromEntries(
    ABILITIES.map((a) => [a, scores[a] ?? rules.min_score]),
  ) as Record<Ability, number>;
  const spent = ABILITIES.reduce((sum, a) => sum + pointBuyCost(full[a], rules), 0);
  const remaining = rules.budget - spent;
  const abilities = {} as Record<Ability, PointBuyAbility>;
  for (const ability of ABILITIES) {
    const score = full[ability];
    const cost = pointBuyCost(score, rules);
    const inc = score < rules.max_score ? pointBuyCost(score + 1, rules) - cost : null;
    let best = score;
    while (best < rules.max_score && pointBuyCost(best + 1, rules) - cost <= remaining) best += 1;
    abilities[ability] = {
      score,
      cost,
      increase_cost: inc,
      can_increase: inc !== null && inc <= remaining,
      can_decrease: score > rules.min_score,
      max_affordable: best,
    };
  }
  return { budget: rules.budget, spent, remaining, abilities };
}

// --- Validation ---------------------------------------------------------------------------

/** Errors in the base (pre-background) scores, as messages. Missing abilities are not errors. */
export function baseScoreMessages(
  method: AbilityMethod,
  scores: AbilityMap,
  rules: CreationRules,
  rolledPool: readonly number[] = [],
): Message[] {
  const errors: Message[] = [];
  const entries = definedEntries(scores);
  const values = entries.map(([, s]) => s);
  if (method === "point_buy") {
    const pb = rules.point_buy;
    const bad = entries
      .filter(([, s]) => costTable(pb, s) === undefined)
      .map(([a, s]) => message("ability.score", { ability: message(`ability.${a}`), score: s }));
    if (bad.length) {
      errors.push(message("scores.point_buy_range", { min: pb.min_score, max: pb.max_score, bad }));
    } else {
      const { spent } = pointBuyStatus(scores, pb);
      if (spent > pb.budget) {
        errors.push(message("scores.point_buy_overspent", { spent, budget: pb.budget }));
      }
    }
  } else {
    const pool = method === "standard_array" ? rules.standard_array : rolledPool;
    if (method === "roll" && pool.length !== 6) {
      errors.push(message("scores.roll_first"));
    } else if (multisetDifference(values, pool).length) {
      errors.push(
        message("scores.not_from_pool", {
          scores: pyList(descending(values)),
          method,
          pool: pyList(descending(pool)),
        }),
      );
    }
  }
  return errors;
}

/** For array/roll methods: values from the pool not yet assigned to an ability. */
export function unassignedValues(
  method: AbilityMethod,
  scores: AbilityMap,
  rules: CreationRules,
  pool: readonly number[],
): number[] {
  const source = method === "standard_array" ? rules.standard_array : pool;
  const assigned = definedEntries(scores).map(([, s]) => s);
  return descending(multisetDifference(source, assigned));
}

/** Errors in the background's ability score increases, as messages. */
export function backgroundBonusMessages(
  bonus: AbilityMap,
  allowed: readonly Ability[],
  baseScores: AbilityMap,
  cap: number,
): Message[] {
  const errors: Message[] = [];
  const entries = definedEntries(bonus);
  const ability = (a: Ability) => message(`ability.${a}`);
  const notAllowed = entries.filter(([a]) => !allowed.includes(a)).map(([a]) => ability(a));
  if (notAllowed.length) {
    errors.push(
      message("scores.background_only", { allowed: allowed.map(ability), not: notAllowed }),
    );
  }
  const pattern = entries
    .map(([, v]) => v)
    .sort((a, b) => a - b)
    .join(",");
  if (pattern !== "1,2" && pattern !== "1,1,1") {
    errors.push(message("scores.background_pattern"));
  }
  for (const [ability, inc] of entries) {
    const base = baseScores[ability];
    if (base !== undefined && base + inc > cap) {
      errors.push(message("scores.cap", { ability: message(`ability.${ability}`), cap }));
    }
  }
  return errors;
}

export function finalScores(baseScores: AbilityMap, bonus: AbilityMap): AbilityMap {
  const out: AbilityMap = {};
  for (const a of ABILITIES) {
    const base = baseScores[a];
    if (base !== undefined) out[a] = base + (bonus[a] ?? 0);
  }
  return out;
}

// --- helpers ------------------------------------------------------------------------------

/** Entries of a partial ability map, in insertion order, skipping missing values. */
export function definedEntries(map: AbilityMap): [Ability, number][] {
  return (Object.entries(map) as [Ability, number | undefined][]).filter(
    (e): e is [Ability, number] => e[1] !== undefined,
  );
}

/** Values of `a` left after removing one occurrence per value in `b` (like `Counter(a) - Counter(b)`). */
function multisetDifference(a: readonly number[], b: readonly number[]): number[] {
  const left = [...a];
  for (const value of b) {
    const i = left.indexOf(value);
    if (i >= 0) left.splice(i, 1);
  }
  return left;
}

function descending(values: readonly number[]): number[] {
  return [...values].sort((x, y) => y - x);
}

function pyList(values: readonly number[]): string {
  return `[${values.join(", ")}]`;
}
