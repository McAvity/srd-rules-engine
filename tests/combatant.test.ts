import { describe, expect, it } from "vitest";
import {
  applyAction,
  type CharacterState,
  type Combatant,
  combatantFromCharacter,
  combatantFromSnapshot,
  computePlaySheet,
  createState,
  makeAttack,
  PlayError,
  rollD20,
  rollSavingThrow,
  scriptedRng,
} from "../src/index";
import { catalog, fighterBuild } from "./helpers";

const fighter = fighterBuild(); // Str 17, Dex 14, Chain Mail + Defense: AC 17, 12 HP
const fresh = () => createState(fighter, catalog);
const brakka = (state: CharacterState = fresh()) => combatantFromCharacter(fighter, state, catalog);

describe("rollD20", () => {
  it("keeps the higher die with Advantage and the lower with Disadvantage", () => {
    expect(rollD20({ rng: scriptedRng([7]) })).toEqual({
      rolls: [7],
      d20: 7,
      mode: "normal",
      kept: 0,
      natural: 7,
    });
    expect(rollD20({ mode: "advantage", rng: scriptedRng([7, 15]) }).d20).toBe(15);
    expect(rollD20({ mode: "disadvantage", rng: scriptedRng([7, 15]) }).d20).toBe(7);
  });
});

describe("combatantFromCharacter", () => {
  it("takes its numbers from the play sheet", () => {
    const c = brakka();
    const sheet = computePlaySheet(fighter, fresh(), catalog);
    expect(c).toMatchObject({
      name: "Brakka",
      armor_class: 17,
      hp: 12,
      max_hp: 12,
      temp_hp: 0,
      critical_hit_on: 20,
    });
    expect(c.saving_throws.str).toBe(sheet.saving_throws.str.modifier);
    expect(c.attacks.map((a) => a.name)).toContain("Greatsword");
  });

  it("Petrified gives Resistance to all damage", () => {
    const state = applyAction(fighter, fresh(), catalog, {
      type: "add_condition",
      condition: "petrified",
    }).state;
    expect(brakka(state).defenses.resistances).toContain("all");
    expect(brakka(state).conditions).toEqual(expect.arrayContaining(["petrified"]));
  });
});

describe("makeAttack", () => {
  it("hits when the total meets the AC, and previews the damage", () => {
    // d20 12 + 5 = 17 vs AC 17: a hit. Greatsword 2d6+3: 4 + 5 + 3 = 12.
    const r = makeAttack(brakka(), "Greatsword", brakka(), { rng: scriptedRng([12, 4, 5]) });
    expect(r).toMatchObject({ total: 17, hit: true, critical_hit: false });
    expect(r.instances).toEqual([{ amount: 12, type: "slashing" }]);
    expect(r.outcome).toMatchObject({ dealt: 12, hp: 0, dropped_to_zero: true });
  });

  it("the damage instances apply to the target's state", () => {
    const r = makeAttack(brakka(), "Greatsword", brakka(), { rng: scriptedRng([15, 1, 2]) });
    const { state } = applyAction(fighter, fresh(), catalog, {
      type: "damage",
      instances: [...r.instances],
      critical: r.critical_hit,
    });
    expect(computePlaySheet(fighter, state, catalog).play.hp.current).toBe(r.outcome?.hp);
    expect(r.outcome?.hp).toBe(6);
  });

  it("a natural 1 misses and a natural 20 hits, rolling the dice twice", () => {
    const tough: Combatant = { ...brakka(), armor_class: 30, max_hp: 99, hp: 99 };
    const miss = makeAttack(brakka(), "Greatsword", brakka(), { rng: scriptedRng([1]) });
    expect(miss).toMatchObject({ hit: false, critical_miss: true, damage: null, outcome: null });
    const crit = makeAttack(brakka(), "Greatsword", tough, { rng: scriptedRng([20, 1, 2, 3, 4]) });
    expect(crit).toMatchObject({ hit: true, critical_hit: true });
    expect(crit.damage?.parts[0]?.rolls).toEqual([1, 2, 3, 4]);
    expect(crit.instances).toEqual([{ amount: 13, type: "slashing" }]);
  });

  it("a wider critical range crits and hits on 19 (Improved Critical)", () => {
    const champion: Combatant = { ...brakka(), critical_hit_on: 19 };
    const target: Combatant = { ...brakka(), armor_class: 30, hp: 99, max_hp: 99 };
    const r = makeAttack(champion, "Greatsword", target, { rng: scriptedRng([19, 1, 1, 1, 1]) });
    expect(r).toMatchObject({ hit: true, critical_hit: true });
  });

  it("uses the two-handed damage of a Versatile weapon when asked", () => {
    const armed = applyAction(fighter, fresh(), catalog, { type: "add_item", item: "longsword" });
    const attacker = brakka(armed.state);
    const r = makeAttack(attacker, "Longsword", brakka(), {
      rng: scriptedRng([15, 10]),
      two_handed: true,
    });
    expect(r.damage?.parts[0]).toMatchObject({ dice: "1d10", rolls: [10], total: 13 });
  });

  it("the target's defenses and conditions apply", () => {
    const petrified = applyAction(fighter, fresh(), catalog, {
      type: "add_condition",
      condition: "petrified",
    }).state;
    // Petrified: attacks against it have Advantage (two d20s), and Resistance to all damage.
    const r = makeAttack(brakka(), "Greatsword", brakka(petrified), {
      rng: scriptedRng([15, 2, 3, 3]),
    });
    expect(r.roll).toMatchObject({ rolls: [15, 2], mode: "advantage" });
    expect(r.reasons).toEqual(["Advantage: Brakka is Petrified (within 5 ft)"]);
    expect(r.outcome).toMatchObject({ dealt: 4, hp: 8 }); // 9 halved
  });

  it("refuses an attack the attacker doesn't have", () => {
    expect(() => makeAttack(brakka(), "Laser", brakka())).toThrow(/no attack 'Laser'/);
  });
});

describe("rollSavingThrow", () => {
  it("uses the sheet's save bonus; a natural 20 isn't an automatic success", () => {
    const r = rollSavingThrow(brakka(), "str", 30, { rng: scriptedRng([20]) });
    expect(r).toMatchObject({ bonus: 5, total: 25, success: false });
  });
});

describe("combatantFromSnapshot (the old Character model)", () => {
  it("converts full ability names to modifiers", () => {
    const c = combatantFromSnapshot({
      name: "Old",
      character_class: "fighter",
      level: 1,
      ability_scores: {
        strength: 16,
        dexterity: 8,
        constitution: 12,
        intelligence: 10,
        wisdom: 10,
        charisma: 10,
      },
      max_hit_points: 10,
      current_hit_points: 7,
      armor_class: 15,
      proficiency_bonus: 2,
      speed: 30,
    });
    expect(c).toMatchObject({ armor_class: 15, hp: 7, max_hp: 10, attacks: [] });
    expect([c.modifiers.str, c.modifiers.dex, c.saving_throws.str]).toEqual([3, -1, 3]);
  });
});

describe("the damage action", () => {
  it("takes an amount or instances, not both", () => {
    expect(() => applyAction(fighter, fresh(), catalog, { type: "damage" })).toThrow(PlayError);
    expect(() =>
      applyAction(fighter, fresh(), catalog, {
        type: "damage",
        amount: 1,
        instances: [{ amount: 1 }],
      }),
    ).toThrow(/either an amount or a list/);
  });

  it("adjusts each instance for its own type", () => {
    const ring = applyAction(fighter, fresh(), catalog, {
      type: "add_item",
      item: "ring-of-resistance",
      variant: "fire",
    }).state;
    const id = ring.inventory.find((i) => i.item === "ring-of-resistance")?.id as string;
    const state = applyAction(fighter, ring, catalog, { type: "equip", id, equipped: true }).state;
    const r = applyAction(fighter, state, catalog, {
      type: "damage",
      instances: [
        { amount: 4, type: "slashing" },
        { amount: 6, type: "fire" },
      ],
    });
    expect(computePlaySheet(fighter, r.state, catalog).play.hp.current).toBe(12 - 4 - 3);
  });
});
