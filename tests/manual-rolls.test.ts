import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  builder,
  type CharacterBuild,
  type CharacterState,
  computePlaySheet,
  createEncounter,
  createState,
  type D20TestResult,
  type DeclaredResult,
  type Encounter,
  type EncounterAction,
  scriptedRng,
} from "../src/index";
import { autocomplete, catalog, classBuild, fighterBuild, levelUpIn } from "./helpers";

// Played by hand with the engine's dice (Roll20-style): the actor's own dice are rolled and
// shown (`DeclaredResult.rolls`), nothing is applied; the targets' saves aren't rolled. A save
// on demand is the `check` action with `save`.

/** A level 7 Wizard with Fireball prepared (a 4th-level slot). */
function wizard(): CharacterBuild {
  const b = levelUpIn(autocomplete(classBuild("wizard", { name: "Ilse" })), "wizard", 6);
  const prepared = b.choices["class:wizard#prepared"] ?? [];
  return builder.setChoice(b, catalog, "class:wizard#prepared", ["fireball", ...prepared.slice(1)])
    .build;
}

/** One character first in the order, then monsters; started. */
function session(
  key: string,
  build: CharacterBuild,
  monsters: string[],
  dice: "engine" | "table" = "engine",
) {
  let encounter: Encounter = createEncounter({ dice });
  let state: CharacterState = createState(build, catalog);
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    let r: ReturnType<typeof applyEncounterAction> | null = null;
    for (const action of actions) {
      r = applyEncounterAction(encounter, action, {
        catalog,
        characters: { [key]: { build, state } },
        rng: scriptedRng(rolls),
      });
      encounter = r.encounter;
      state = r.states[key] ?? state;
    }
    return r as ReturnType<typeof applyEncounterAction>;
  };
  const ids = [key, ...monsters.map((m, i) => (monsters.indexOf(m) === i ? m : `${m}-2`))];
  act(
    [],
    { type: "add_character", character: key, side: "party" },
    ...monsters.map((monster) => ({ type: "add_monster", monster, side: "enemies" }) as const),
    ...ids.map((id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const),
    { type: "start" },
  );
  return {
    act,
    encounter: () => encounter,
    state: () => state,
    sheet: () => computePlaySheet(build, state, catalog),
    get: (id: string) => encounter.combatants.find((c) => c.id === id),
  };
}

const swing: EncounterAction = {
  type: "attack",
  id: "brakka",
  target: "goblin-warrior",
  attack: "Greatsword",
  manual: true,
};
const declared = (r: { result: unknown }) => r.result as DeclaredResult;

describe("played by hand, with the engine's dice", () => {
  it("an attack rolls the d20 and the damage, and applies nothing", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"]);
    const r = s.act([15, 3, 4], swing);
    expect(r.rolls).toEqual([15, 3, 4]);
    const [attack] = declared(r).rolls?.attacks ?? [];
    expect(attack).toMatchObject({
      target: "goblin-warrior",
      roll: { d20: 15, mode: "normal" },
      bonus: 5,
      total: 20,
      target_ac: 15,
      hit: true,
      critical_hit: false,
    });
    expect(attack?.damage?.parts).toEqual([
      { dice: "2d6", bonus: 3, type: "slashing", rolls: [3, 4], total: 10 },
    ]);
    expect(s.get("goblin-warrior")?.hp).toBe(10);
    expect(s.get("brakka")?.used.action).toBe(true);
    expect(r.notes).toEqual([
      "Brakka declares Greatsword on Goblin Warrior, by hand.",
      "Attack roll against Goblin Warrior: 20 vs AC 15, would hit.",
      "Greatsword damage rolled: 10 slashing (3 + 4).",
    ]);
  });

  it("a natural 20 doubles the damage dice; a Prone target nearby gives Advantage", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"]);
    const crit = declared(s.act([20, 1, 2, 3, 4], swing)).rolls?.attacks[0];
    expect(crit).toMatchObject({ critical_hit: true, damage: { critical: true } });
    expect(crit?.damage?.parts[0]).toMatchObject({ rolls: [1, 2, 3, 4], total: 13 });

    const p = session("brakka", fighterBuild(), ["goblin-warrior"]);
    p.act(
      [],
      { type: "place", id: "brakka", x: 0, y: 0 },
      { type: "place", id: "goblin-warrior", x: 1, y: 0 },
      {
        type: "effects",
        id: "goblin-warrior",
        actions: [{ type: "add_condition", condition: "prone" }],
      },
    );
    const adv = declared(p.act([5, 12, 3, 4], swing)).rolls?.attacks[0];
    expect(adv?.roll).toEqual({ rolls: [5, 12], d20: 12, mode: "advantage" });
    expect(adv?.reasons.join()).toMatch(/Prone/);
  });

  it("a miss still rolls the damage (the table decides)", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"]);
    const miss = declared(s.act([2, 6, 6], swing)).rolls?.attacks[0];
    expect(miss).toMatchObject({ hit: false, damage: { total: 15 } });
  });

  it("Fireball at level 4 rolls 9d6 once, shows the save, rolls no saves", () => {
    const s = session("ilse", wizard(), ["goblin-warrior", "goblin-warrior"]);
    const nine = [1, 2, 3, 4, 5, 6, 1, 2, 3];
    const r = s.act(nine, {
      type: "cast",
      id: "ilse",
      spell: "fireball",
      slot_level: 4,
      targets: ["goblin-warrior", "goblin-warrior-2"],
      manual: true,
    });
    expect(r.rolls).toEqual(nine);
    const rolls = declared(r).rolls;
    expect(rolls?.save).toEqual({ ability: "dex", dc: s.sheet().spellcasting[0]?.save_dc });
    expect(rolls?.damage?.parts[0]).toMatchObject({ dice: "9d6", total: 27 });
    expect(rolls?.attacks).toEqual([]);
    expect([s.get("goblin-warrior")?.hp, s.get("goblin-warrior-2")?.hp]).toEqual([10, 10]);
    expect(s.sheet().play.spell_slots.find((x) => x.level === 4)?.spent).toBe(1);
  });

  it("Second Wind by hand rolls 1d10 + Fighter level, not applied", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"]);
    s.act([], { type: "effects", id: "brakka", actions: [{ type: "damage", amount: 9 }] });
    const r = s.act([7], { type: "feature", id: "brakka", feature: "Second Wind", manual: true });
    expect(declared(r).rolls?.healing).toBe(8);
    expect(r.notes).toContain("Second Wind healing rolled: 8.");
    expect(s.state().hp.current).toBe(s.sheet().play.hp.max - 9);
  });

  it("with the actor's dice at the table, nothing is rolled (as before)", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"], "table");
    const r = s.act([], swing);
    expect(r.rolls).toEqual([]);
    expect(declared(r).rolls).toBeNull();
  });
});

describe("a saving throw on demand (check with save)", () => {
  it("rolls a Restrained goblin's Dexterity save with Disadvantage, nothing else changes", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"]);
    s.act([], {
      type: "effects",
      id: "goblin-warrior",
      actions: [{ type: "add_condition", condition: "restrained" }],
    });
    const before = s.encounter();
    const r = s.act([14, 3], { type: "check", id: "goblin-warrior", save: "dex", dc: 15 });
    const save = r.result as D20TestResult;
    expect(save).toMatchObject({
      kind: "save",
      ability: "dex",
      roll: { rolls: [14, 3], d20: 3, mode: "disadvantage" },
      dc: 15,
      success: false,
    });
    expect(r.notes[0]).toMatch(
      /^Goblin Warrior's Dexterity saving throw: \d+ vs DC 15; .*: failure\.$/,
    );
    expect(s.encounter()).toEqual(before);
  });

  it("without a DC it shows the total; with table dice it waits for the d20", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"], "table");
    s.act([], { type: "check", id: "brakka", save: "str" });
    expect(s.encounter().pending?.roll?.dice).toBe("1d20");
    const r = s.act([], { type: "enter_roll", values: [10] });
    expect(r.result).toMatchObject({ kind: "save", dc: null, success: null });
    expect(r.notes[0]).toMatch(/^Brakka's Strength saving throw: \d+\.$/);
  });
});
