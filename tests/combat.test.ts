import { describe, expect, it } from "vitest";
import { type Character, CharacterSchema, fixedRng } from "../src/index";
// Behind the HTTP routes `/v1/characters/{name}/alive`, `/passive-perception` and
// `/v1/combat/saving-throw`; not exported.
import { savingThrow } from "../src/rules/combat";
import { isAlive, passivePerception } from "../src/services/combat";

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return CharacterSchema.parse({
    name: "Test",
    character_class: "fighter",
    level: 5,
    ability_scores: {
      strength: 16,
      dexterity: 14,
      constitution: 15,
      intelligence: 10,
      wisdom: 12,
      charisma: 8,
    },
    max_hit_points: 44,
    current_hit_points: 44,
    armor_class: 16,
    proficiency_bonus: 3,
    ...overrides,
  });
}

describe("saving throws", () => {
  it("succeeds when the total meets the DC", () => {
    const result = savingThrow(makeCharacter(), "dexterity", 15, { rng: fixedRng(20) });
    expect(result.success).toBe(true);
  });

  it("adds proficiency when proficient", () => {
    const result = savingThrow(makeCharacter(), "Strength", 10, {
      proficient: true,
      rng: fixedRng(5),
    });
    expect(result.bonus).toBe(3 + 3);
  });

  it("rejects unknown abilities", () => {
    expect(() => savingThrow(makeCharacter(), "constructor", 10)).toThrow(/Unknown ability/);
  });
});

describe("hit points", () => {
  it("is alive above 0 HP", () => {
    expect(isAlive(makeCharacter({ current_hit_points: 1 }))).toBe(true);
    expect(isAlive(makeCharacter({ current_hit_points: 0 }))).toBe(false);
  });
  it("passive perception", () => {
    expect(passivePerception(makeCharacter())).toBe(11);
    expect(passivePerception(makeCharacter(), true)).toBe(14);
  });
});
