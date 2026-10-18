import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  combatantFromCharacter,
  combatantFromMonster,
  computePlaySheet,
  createEncounter,
  createState,
  evaluate,
  lookup,
  type MonsterDef,
  type RollWhat,
  rollByHand,
  type SpellCastResult,
  scriptedRng,
} from "../src/index";
import { autocomplete, catalog, classBuild, levelUpIn } from "./helpers";

// A Sorcerer 1 / Bard 1 (both Charisma, same DC): Color Spray is on both class lists. Prepared as a Bard spell it's a
// Bard spell, so Innate Sorcery ("your Sorcerer spells") doesn't raise its DC (kenli K-001); `spellcasting` picks the
// feature when a spell comes from more than one.

const multiclass = (): CharacterBuild =>
  autocomplete(levelUpIn(autocomplete(classBuild("sorcerer", { name: "Kai" })), "bard", 1));
const innate = (build: CharacterBuild): CharacterState =>
  applyAction(build, createState(build, catalog), catalog, {
    type: "activate",
    key: "sorcerer:innate-sorcery",
  }).state;
const roll = (
  build: CharacterBuild,
  state: CharacterState,
  what: Omit<RollWhat & { type: "cast" }, "type">,
) =>
  rollByHand(combatantFromCharacter(build, state, catalog), { type: "cast", ...what } as RollWhat, {
    catalog,
    character: { build, state },
    rng: scriptedRng([10]),
  });
const dc = (
  build: CharacterBuild,
  state: CharacterState,
  what: Omit<RollWhat & { type: "cast" }, "type">,
) => roll(build, state, what).rolls.save?.dc;

describe("spellcasting source of a spell", () => {
  it("lists the spellcasting features a spell is cast with", () => {
    const build = multiclass();
    const spells = computePlaySheet(build, createState(build, catalog), catalog).spells;
    const of = (id: string) => spells.find((s) => s.id === id)?.spellcasting;
    expect(of("color-spray")).toEqual(["Bard"]);
    expect(of("charm-person")).toEqual(["Sorcerer"]);
    expect(of("light")).toEqual(["Bard"]);
  });

  it("casts a spell from one feature with that feature: Innate Sorcery raises only Sorcerer spells", () => {
    const build = multiclass();
    const rested = createState(build, catalog);
    expect(dc(build, rested, { spell: "color-spray" })).toBe(12);
    expect(dc(build, rested, { spell: "charm-person" })).toBe(12);
    const active = innate(build);
    expect(dc(build, active, { spell: "charm-person" })).toBe(13);
    // Prepared through Bard, also on the Sorcerer list: still a Bard spell.
    expect(dc(build, active, { spell: "color-spray" })).toBe(12);
  });

  it("takes the feature the caller names, and refuses one the character doesn't have", () => {
    const build = multiclass();
    const active = innate(build);
    expect(dc(build, active, { spell: "color-spray", spellcasting: "Bard" })).toBe(12);
    expect(dc(build, active, { spell: "color-spray", spellcasting: "Sorcerer" })).toBe(13);
    expect(() => roll(build, active, { spell: "color-spray", spellcasting: "Wizard" })).toThrow(
      "Kai has no spellcasting from 'Wizard'",
    );
  });

  it("a spell given by two features (refused by validation, still loadable) lists both: the caller chooses", () => {
    const base = multiclass();
    const build: CharacterBuild = {
      ...base,
      choices: { ...base.choices, "class:sorcerer#prepared": ["burning-hands", "color-spray"] },
    };
    expect(evaluate(build, catalog).report.issues.map((i) => i.message)).toContain(
      "Bard prepared spells: Color Spray — already known from Sorcerer",
    );
    const active = innate(build);
    const line = computePlaySheet(build, active, catalog).spells.find(
      (s) => s.id === "color-spray",
    );
    expect(line?.spellcasting).toEqual(["Sorcerer", "Bard"]);
    expect(dc(build, active, { spell: "color-spray", spellcasting: "Bard" })).toBe(12);
    expect(dc(build, active, { spell: "color-spray", spellcasting: "Sorcerer" })).toBe(13);
  });

  it("keeps the costs: the slot and nothing else, whatever the feature", () => {
    const build = multiclass();
    const active = innate(build);
    const legacy = roll(build, active, { spell: "color-spray", slot_level: 1 });
    const named = roll(build, active, {
      spell: "color-spray",
      slot_level: 1,
      spellcasting: "Bard",
    });
    expect(named.costs).toEqual(legacy.costs);
    expect(legacy.costs).toEqual([{ type: "play", action: { type: "spend_slot", level: 1 } }]);
    expect(named.slot_level).toBe(1);
  });

  it("an encounter cast takes the spell's feature too, or the one named", () => {
    const build = multiclass();
    const state = innate(build);
    const characters = { kai: { build, state } };
    let encounter = createEncounter();
    for (const action of [
      { type: "add_character", character: "kai", side: "party" },
      { type: "add_monster", monster: "goblin-warrior", side: "enemies" },
      { type: "set_initiative", id: "kai", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 10 },
      { type: "start" },
    ] as const)
      encounter = applyEncounterAction(encounter, action, { catalog, characters }).encounter;
    const cast = (spellcasting?: string) =>
      applyEncounterAction(
        encounter,
        {
          type: "cast",
          id: "kai",
          spell: "color-spray",
          targets: ["goblin-warrior"],
          ...(spellcasting ? { spellcasting } : {}),
        },
        { catalog, characters, rng: scriptedRng([10, 10, 10, 10, 10, 10]) },
      ).result as SpellCastResult;
    expect(cast()).toMatchObject({ spellcasting: "Bard", save_dc: 12 });
    expect(cast("Sorcerer")).toMatchObject({ spellcasting: "Sorcerer", save_dc: 13 });
  });

  it("a monster casts through its action: another spellcasting is refused, not ignored", () => {
    const mage = lookup(catalog.monsters, "mage") as MonsterDef;
    const by = (what: RollWhat) =>
      rollByHand(combatantFromMonster(mage), what, {
        catalog,
        monster: mage,
        rng: scriptedRng([10]),
      });
    expect(by({ type: "cast", spell: "light" }).action).toBe("cast");
    expect(by({ type: "cast", spell: "light", spellcasting: "Spellcasting" }).action).toBe("cast");
    expect(() => by({ type: "cast", spell: "light", spellcasting: "Bard" })).toThrow(
      "has no spellcasting from 'Bard'",
    );
  });
});
