import { describe, expect, it } from "vitest";
import {
  type Ability,
  type AbilityMap,
  pointBuyStatus,
  rollAbilityScore,
  rollAbilityScores,
  scriptedRng,
  seededRng,
  unassignedValues,
} from "../src/index";
import { backgroundBonusMessages, baseScoreMessages } from "../src/rules/ability-scores";
import { catalog } from "./helpers";

const baseScoreErrors = (...args: Parameters<typeof baseScoreMessages>) =>
  baseScoreMessages(...args).map((m) => m.text);
const backgroundBonusErrors = (...args: Parameters<typeof backgroundBonusMessages>) =>
  backgroundBonusMessages(...args).map((m) => m.text);

const all = (score: number): AbilityMap => ({
  str: score,
  dex: score,
  con: score,
  int: score,
  wis: score,
  cha: score,
});

describe("point buy", () => {
  const rules = catalog.creation.point_buy;

  it("tracks remaining points and the highest reachable score", () => {
    const status = pointBuyStatus({ str: 15, dex: 14, con: 13 }, rules);
    expect(status.spent).toBe(9 + 7 + 5);
    expect(status.remaining).toBe(6);
    // 6 points left: an 8 can reach 13 (5 points) but not 14 (7 points).
    expect(status.abilities.int.max_affordable).toBe(13);
    expect(status.abilities.str.increase_cost).toBeNull(); // already 15
    expect(status.abilities.dex.increase_cost).toBe(2);
    expect(status.abilities.dex.can_increase).toBe(true);
  });

  it("can't increase anything once the budget is spent", () => {
    const status = pointBuyStatus({ str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, rules);
    expect(status.remaining).toBe(0);
    expect(Object.values(status.abilities).some((a) => a.can_increase)).toBe(false);
    expect(status.abilities.cha.max_affordable).toBe(8);
  });

  it("rejects all fifteens", () => {
    expect(baseScoreErrors("point_buy", all(15), catalog.creation)).toEqual([
      "Point buy overspent: 54 of 27 points",
    ]);
  });

  it.each([7, 16, 20])("rejects out-of-range score %i", (score) => {
    const errors = baseScoreErrors("point_buy", { str: score }, catalog.creation);
    expect(errors[0]).toContain("8-15");
  });
});

describe("standard array and rolls", () => {
  it("rejects a reused value", () => {
    const errors = baseScoreErrors("standard_array", { str: 15, dex: 15 }, catalog.creation);
    expect(errors[0]).toContain("standard array");
  });

  it("allows a partial assignment", () => {
    const scores = { str: 15, dex: 14 };
    expect(baseScoreErrors("standard_array", scores, catalog.creation)).toEqual([]);
    expect(unassignedValues("standard_array", scores, catalog.creation, [])).toEqual([
      13, 12, 10, 8,
    ]);
  });

  it("rolled scores must come from the pool", () => {
    const pool = [18, 12, 11, 10, 9, 7];
    expect(baseScoreErrors("roll", { str: 18, dex: 12 }, catalog.creation, pool)).toEqual([]);
    expect(baseScoreErrors("roll", { str: 17 }, catalog.creation, pool)).not.toEqual([]);
  });

  it("4d6 drops the lowest die", () => {
    const result = rollAbilityScore(scriptedRng([6, 1, 4, 5]));
    expect([result.dropped, result.total]).toEqual([1, 15]);
  });

  it("six rolls are deterministic with a seed", () => {
    const first = rollAbilityScores(seededRng(7)).map((r) => r.total);
    const second = rollAbilityScores(seededRng(7)).map((r) => r.total);
    expect(first).toEqual(second);
    expect(first).toHaveLength(6);
    expect(first.every((t) => t >= 3 && t <= 18)).toBe(true);
  });
});

describe("background bonus", () => {
  const BG: Ability[] = ["str", "dex", "con"];

  it.each<AbilityMap>([
    { str: 2, con: 1 },
    { str: 1, dex: 1, con: 1 },
    { dex: 2, str: 1 },
  ])("accepts %o", (bonus) => {
    expect(backgroundBonusErrors(bonus, BG, {}, 20)).toEqual([]);
  });

  it.each<AbilityMap>([{ str: 3 }, { str: 2, dex: 2 }, { str: 2 }, { str: 1, dex: 1 }])(
    "rejects %o",
    (bonus) => {
      expect(backgroundBonusErrors(bonus, BG, {}, 20)).not.toEqual([]);
    },
  );

  it("only raises the background's abilities", () => {
    const errors = backgroundBonusErrors({ wis: 2, str: 1 }, BG, {}, 20);
    expect(errors.some((e) => e.includes("Wisdom"))).toBe(true);
  });

  it("can't exceed 20", () => {
    expect(backgroundBonusErrors({ str: 2, con: 1 }, BG, { str: 19 }, 20)).toEqual([
      "Strength can't exceed 20",
    ]);
  });
});
