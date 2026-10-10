import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  builder,
  type CharacterBuild,
  type CharacterState,
  createEncounter,
  createHistory,
  createState,
  type Encounter,
  type EncounterAction,
  EncounterError,
  recordAction,
  replayHistory,
  scriptedRng,
  undoAction,
} from "../src/index";
import { autocomplete, catalog, classBuild, fighterBuild, levelUpIn } from "./helpers";

// Dice rolled at the table (`dice: "table"`): each roll a combatant makes stops the action
// (`pending.kind: "roll"`) until its numbers are entered (`enter_roll`); the action then goes on
// exactly as if the engine had drawn them.

/** A level 5 Wizard with Fireball prepared. */
function wizard(): CharacterBuild {
  const b = levelUpIn(autocomplete(classBuild("wizard", { name: "Ilse" })), "wizard", 4);
  const prepared = b.choices["class:wizard#prepared"] ?? [];
  return builder.setChoice(b, catalog, "class:wizard#prepared", ["fireball", ...prepared.slice(1)])
    .build;
}

/** One character and monsters, in this Initiative order, started; dice set as given. */
function session(
  key: string,
  build: CharacterBuild,
  monsters: string[],
  dice: { character?: "engine" | "table"; encounter?: Encounter },
) {
  let encounter = dice.encounter ?? createEncounter();
  let state: CharacterState = createState(build, catalog);
  let last: ReturnType<typeof applyEncounterAction> | null = null;
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    for (const action of actions) {
      last = applyEncounterAction(encounter, action, {
        catalog,
        characters: { [key]: { build, state } },
        rng: scriptedRng(rolls),
      });
      encounter = last.encounter;
      state = last.states[key] ?? state;
    }
    return last as ReturnType<typeof applyEncounterAction>;
  };
  const ids = [key, ...monsters.map((m, i) => (monsters.indexOf(m) === i ? m : `${m}-2`))];
  act(
    [],
    { type: "add_character", character: key, side: "party", dice: dice.character },
    ...monsters.map((monster) => ({ type: "add_monster", monster, side: "enemies" }) as const),
    ...ids.map((id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const),
    { type: "start" },
  );
  return {
    act,
    encounter: () => encounter,
    hp: (id: string) => encounter.combatants.find((c) => c.id === id)?.hp,
  };
}

const swing: EncounterAction = {
  type: "attack",
  id: "brakka",
  target: "goblin-warrior",
  attack: "Greatsword",
};

describe("table dice", () => {
  it("a Fighter's attack stops for the d20, then for the damage dice", () => {
    const table = session("brakka", fighterBuild(), ["goblin-warrior"], { character: "table" });
    const first = table.act([], swing);
    expect(first.rolls).toEqual([]);
    expect(table.encounter().pending).toMatchObject({
      kind: "roll",
      combatant: "brakka",
      roll: { dice: "1d20", count: 1, sides: 20, keep: null },
      question: "Brakka: roll 1d20 for attack roll with Greatsword.",
    });
    expect(table.hp("goblin-warrior")).toBe(10);
    // Nothing else happens until the roll is entered.
    expect(() => table.act([], { type: "next_turn" })).toThrow(EncounterError);
    table.act([], { type: "enter_roll", values: [15] });
    expect(table.encounter().pending).toMatchObject({
      kind: "roll",
      roll: { dice: "2d6", count: 2, sides: 6 },
      question: "Brakka: roll 2d6 for slashing damage for Greatsword.",
    });
    const done = table.act([], { type: "enter_roll", values: [3, 4] });
    expect(table.encounter().pending).toBeNull();

    // The same as the engine drawing 15, 3 and 4.
    const engine = session("brakka", fighterBuild(), ["goblin-warrior"], {});
    const same = engine.act([15, 3, 4], swing);
    expect(done.result).toEqual(same.result);
    expect(done.rolls).toEqual([]);
    expect(table.hp("goblin-warrior")).toBe(engine.hp("goblin-warrior"));
    expect(table.hp("goblin-warrior")).toBeLessThan(10);
  });

  it("with Advantage it asks for two d20s and keeps the higher", () => {
    const table = session("brakka", fighterBuild(), ["goblin-warrior"], { character: "table" });
    table.act([], { ...swing, mode: "advantage" });
    expect(table.encounter().pending).toMatchObject({
      roll: { dice: "2d20", count: 2, sides: 20, keep: "higher" },
      question: "Brakka: roll 2d20 and keep the higher for attack roll with Greatsword.",
    });
    const r = table.act([], { type: "enter_roll", values: [2, 18] });
    expect(r.encounter.pending?.roll?.dice).toBe("2d6");
    table.act([], { type: "enter_roll", values: [1, 1] });
    expect(table.encounter().pending).toBeNull();
    expect(table.encounter().combatants.find((c) => c.id === "brakka")?.used.action).toBe(true);
  });

  it("a Wizard's Fireball asks only the 8d6: the goblins' saves are the engine's", () => {
    const table = session("ilse", wizard(), ["goblin-warrior", "goblin-warrior"], {
      character: "table",
    });
    const cast: EncounterAction = {
      type: "cast",
      id: "ilse",
      spell: "fireball",
      slot_level: 3,
      targets: ["goblin-warrior", "goblin-warrior-2"],
    };
    // The two saves are drawn by the engine (1 and 20), then the damage stops.
    const first = table.act([1, 20], cast);
    expect(first.rolls).toEqual([1, 20]);
    expect(table.encounter().pending).toMatchObject({
      combatant: "ilse",
      roll: { dice: "8d6", count: 8, sides: 6, keep: null },
      question: "Ilse: roll 8d6 for fire damage for Fireball.",
    });
    const done = table.act([], { type: "enter_roll", values: [1, 1, 1, 1, 1, 1, 1, 1] });
    // Entered dice aren't drawn: the action's `rolls` (for undo) lists only the engine's.
    expect(done.rolls).toEqual([]);
    expect(table.encounter().pending).toBeNull();
    // 8 fire damage: the failed save takes it all, the other half.
    expect([table.hp("goblin-warrior"), table.hp("goblin-warrior-2")]).toEqual([2, 6]);
  });

  it("refuses a value a die can't roll, or the wrong number of dice, with a code", () => {
    const table = session("brakka", fighterBuild(), ["goblin-warrior"], { character: "table" });
    table.act([], swing);
    table.act([], { type: "enter_roll", values: [15] });
    const refused = (values: number[]) => {
      try {
        table.act([], { type: "enter_roll", values });
      } catch (error) {
        if (error instanceof EncounterError) return error;
      }
      throw new Error("not refused");
    };
    const range = refused([7, 2]);
    expect(range.message).toBe("A d6 rolls 1 to 6, not 7");
    expect(range.codes).toContain("invalid_roll");
    const count = refused([2, 3, 4]);
    expect(count.message).toBe("Enter 2 dice, not 3");
    expect(count.codes).toContain("invalid_roll");
    expect(table.encounter().pending?.roll?.dice).toBe("2d6");
  });

  it("a monster set to table asks the GM; the character's dice stay the engine's", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"], {});
    s.act([], { type: "set_dice", id: "goblin-warrior", mode: "table" }, { type: "next_turn" });
    s.act([], { type: "attack", id: "goblin-warrior", target: "brakka", attack: "Scimitar" });
    expect(s.encounter().pending).toMatchObject({
      combatant: "goblin-warrior",
      roll: { dice: "1d20" },
    });
    s.act([], { type: "enter_roll", values: [1] }); // a natural 1: a miss, no damage dice
    expect(s.encounter().pending).toBeNull();
  });

  it("the encounter's setting covers everyone without their own; initiative too", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"], {
      encounter: createEncounter({ dice: "table" }),
    });
    s.act([], { type: "set_dice", id: "goblin-warrior", mode: "engine" });
    s.act([7], { type: "roll_initiative", ids: ["goblin-warrior", "brakka"] });
    expect(s.encounter().pending).toMatchObject({
      combatant: "brakka",
      question: "Brakka: roll 1d20 for Initiative.",
    });
    s.act([], { type: "enter_roll", values: [12] });
    expect(s.encounter().pending).toBeNull();
    const brakka = s.encounter().combatants.find((c) => c.id === "brakka");
    expect(brakka?.initiative).toBe(12 + 2);
    s.act([], { type: "set_dice", mode: "engine" });
    expect(s.encounter().dice).toBe("engine");
  });

  it("a decision after a roll is asked once the roll is entered", () => {
    const s = session("ilse", wizard(), ["adult-blue-dragon"], {});
    s.act(
      [],
      { type: "set_dice", id: "adult-blue-dragon", mode: "table" },
      { type: "set_decisions", id: "adult-blue-dragon", mode: "ask" },
    );
    const cast: EncounterAction = {
      type: "cast",
      id: "ilse",
      spell: "fireball",
      slot_level: 3,
      targets: ["adult-blue-dragon"],
    };
    s.act([], cast);
    expect(s.encounter().pending).toMatchObject({
      kind: "roll",
      combatant: "adult-blue-dragon",
      question: "Adult Blue Dragon: roll 1d20 for Dexterity saving throw.",
    });
    s.act([], { type: "enter_roll", values: [2] });
    expect(s.encounter().pending).toMatchObject({
      kind: "legendary_resistance",
      combatant: "adult-blue-dragon",
    });
    // The caster's damage is the engine's: drawn after the answer.
    s.act(Array<number>(8).fill(3), { type: "decide", use: false });
    expect(s.encounter().pending).toBeNull();
    expect(s.hp("adult-blue-dragon")).toBe(212 - 24);
  });

  it("undo replays entered dice like drawn ones", () => {
    const build = fighterBuild();
    const s = session("brakka", build, ["goblin-warrior"], { character: "table" });
    const start = s.encounter();
    const ctx = { catalog, characters: { brakka: { build, state: createState(build, catalog) } } };
    let history = createHistory(start, {});
    for (const action of [
      swing,
      { type: "enter_roll", values: [15] },
      { type: "enter_roll", values: [6, 6] },
    ] as EncounterAction[]) {
      history = recordAction(history, action, s.act([], action));
    }
    expect(replayHistory(history, ctx).encounter).toEqual(s.encounter());
    const undone = undoAction(history, ctx);
    expect(undone.encounter.pending?.roll?.dice).toBe("2d6");
    expect(undone.encounter.combatants.find((c) => c.id === "goblin-warrior")?.hp).toBe(10);
  });

  it('"engine" changes nothing', () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"], { character: "engine" });
    const r = s.act([15, 3, 4], swing);
    expect(s.encounter().pending).toBeNull();
    expect(r.rolls).toEqual([15, 3, 4]);
    expect(createEncounter().dice).toBe("engine");
  });
});
