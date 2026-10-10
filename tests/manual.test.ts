import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  builder,
  type CharacterBuild,
  type CharacterState,
  checkAction,
  combatantOptions,
  computePlaySheet,
  createEncounter,
  createHistory,
  createState,
  type DeclaredResult,
  type Encounter,
  type EncounterAction,
  EncounterError,
  recordAction,
  scriptedRng,
  undoAction,
} from "../src/index";
import { autocomplete, catalog, classBuild, levelUpIn } from "./helpers";

// Manual play: an action declared by hand (`manual: true`) is checked and its costs spent as
// usual, and no outcome is applied. With the table rolling (`dice: "table"`) nothing is rolled
// (an empty `scriptedRng` would throw); with the engine's dice, the actor's own dice are rolled
// and shown (`rolls`).

/** A level 5 Wizard with Fireball and Fly prepared. */
function wizard(): CharacterBuild {
  let b = levelUpIn(autocomplete(classBuild("wizard", { name: "Ilse" })), "wizard", 4);
  b = builder.setChoice(b, catalog, "class:wizard:5#spellbook", ["fly", "haste"]).build;
  const prepared = b.choices["class:wizard#prepared"] ?? [];
  const picks = ["fireball", "fly", ...prepared.slice(2)];
  return builder.setChoice(b, catalog, "class:wizard#prepared", picks).build;
}

/** An encounter of Ilse and monsters, in this Initiative order, started. */
function session(monsters: string[], build = wizard()) {
  let encounter: Encounter = createEncounter({ dice: "table" });
  let state: CharacterState = createState(build, catalog);
  const ctx = () => ({ catalog, characters: { ilse: { build, state } } });
  let history = createHistory(encounter, { ilse: state });
  const act = (action: EncounterAction) => {
    const r = applyEncounterAction(encounter, action, { ...ctx(), rng: scriptedRng([]) });
    encounter = r.encounter;
    state = r.states.ilse ?? state;
    history = recordAction(history, action, r);
    return r;
  };
  const ids = ["ilse", ...monsters.map((m, i) => (monsters.indexOf(m) === i ? m : `${m}-2`))];
  for (const action of [
    { type: "add_character", character: "ilse", side: "party" },
    ...monsters.map((monster) => ({ type: "add_monster", monster, side: "enemies" })),
    ...ids.map((id, i) => ({ type: "set_initiative", id, value: 20 - i })),
    { type: "start" },
  ] as EncounterAction[]) {
    act(action);
  }
  history = createHistory(encounter, { ilse: state });
  return {
    act,
    ctx,
    encounter: () => encounter,
    state: () => state,
    history: () => history,
    sheet: () => computePlaySheet(build, state, catalog),
    hp: (id: string) => encounter.combatants.find((c) => c.id === id)?.hp,
  };
}

const fireball = (targets: string[]): EncounterAction => ({
  type: "cast",
  id: "ilse",
  spell: "fireball",
  slot_level: 3,
  targets,
  manual: true,
});

describe("declared by hand (manual)", () => {
  it("Fireball: a 3rd-level slot and the action spent, nothing rolled, no damage", () => {
    const s = session(["goblin-warrior", "goblin-warrior"]);
    const before = [s.hp("goblin-warrior"), s.hp("goblin-warrior-2")];
    const r = s.act(fireball(["goblin-warrior", "goblin-warrior-2"]));
    expect(r.rolls).toEqual([]);
    expect(r.result).toEqual({
      manual: true,
      by: "ilse",
      action: "cast",
      name: "Fireball",
      slot_level: 3,
      targets: ["goblin-warrior", "goblin-warrior-2"],
      rolls: null,
    } satisfies DeclaredResult);
    expect([s.hp("goblin-warrior"), s.hp("goblin-warrior-2")]).toEqual(before);
    expect(s.sheet().play.spell_slots.find((x) => x.level === 3)?.spent).toBe(1);
    expect(s.encounter().combatants.find((c) => c.id === "ilse")?.used.action).toBe(true);
    expect(r.messages).toEqual([
      expect.objectContaining({
        code: "manual.declared",
        text: "Ilse declares Fireball at level 3 on Goblin Warrior, Goblin Warrior 2, by hand.",
      }),
    ]);
  });

  it("refused for today's reasons: no 3rd-level slot left, or no action left", () => {
    const s = session(["goblin-warrior"]);
    s.act(fireball(["goblin-warrior"]));
    const again = () => s.act(fireball(["goblin-warrior"]));
    expect(again).toThrow("has already used its action");
    // Two more turns' worth of slots: the third 3rd-level cast has none left.
    const next = { type: "next_turn" } as const;
    s.act(next);
    s.act(next);
    s.act(fireball(["goblin-warrior"]));
    s.act(next);
    s.act(next);
    try {
      s.act(fireball(["goblin-warrior"]));
      expect.unreachable();
    } catch (error) {
      if (!(error instanceof EncounterError)) throw error;
      expect(error.messages).toEqual(["Ilse: No level 3 spell slots left"]);
      expect(error.codes).toEqual(["no_resources"]);
    }
  });

  it("a Concentration spell starts Concentration (and ends the previous one)", () => {
    const s = session(["goblin-warrior"]);
    s.act({ type: "cast", id: "ilse", spell: "fly", targets: ["ilse"], manual: true });
    expect(s.state().concentration).toBe("Fly");
    s.act({ type: "next_turn" });
    s.act({ type: "next_turn" });
    s.act({ type: "cast", id: "ilse", spell: "bane", targets: ["goblin-warrior"], manual: true });
    expect(s.state().concentration).toBe("Bane");
  });

  it("a monster's 1/Day spell counts its daily use; a Recharge action is marked used", () => {
    const s = session(["adult-black-dragon", "adult-red-dragon"]);
    s.act({ type: "next_turn" }); // the black dragon's turn
    const sphere: EncounterAction = {
      type: "cast",
      id: "adult-black-dragon",
      spell: "vitriolic-sphere",
      targets: ["ilse"],
      manual: true,
    };
    const r = s.act(sphere);
    expect(r.result).toMatchObject({ manual: true, name: "Vitriolic Sphere", targets: ["ilse"] });
    expect(s.state().hp.current).toBeNull(); // untouched
    const black = s.encounter().combatants.find((c) => c.id === "adult-black-dragon");
    expect(black?.daily_used).toEqual({ "Spellcasting#vitriolic-sphere": 1 });
    s.act({ type: "next_turn" }); // the red dragon's turn
    s.act({
      type: "save_action",
      id: "adult-red-dragon",
      ability: "Fire Breath",
      targets: ["ilse"],
      manual: true,
    });
    const red = s.encounter().combatants.find((c) => c.id === "adult-red-dragon");
    expect(red?.expended).toEqual(["Fire Breath"]);
    s.act({ type: "next_turn" });
    s.act({ type: "next_turn" }); // the black dragon again, a new round
    expect(() => s.act(sphere)).toThrow("1 time today");
  });

  it("checkAction and combatantOptions agree; undo reverts a declaration", () => {
    const s = session(["goblin-warrior"]);
    expect(checkAction(s.encounter(), fireball(["goblin-warrior"]), s.ctx()).ok).toBe(true);
    s.act(fireball(["goblin-warrior"]));
    expect(checkAction(s.encounter(), fireball(["goblin-warrior"]), s.ctx()).codes).toEqual([
      "economy_used",
    ]);
    expect(
      combatantOptions(s.encounter(), "ilse", s.ctx()).spells.find((x) =>
        x.label.startsWith("Fireball"),
      )?.available,
    ).toBe(false);
    const undone = undoAction(s.history(), s.ctx());
    expect(undone.encounter.combatants.find((c) => c.id === "ilse")?.used.action).toBe(false);
    expect(undone.states.ilse?.spell_slots_spent ?? []).toEqual([]);
  });

  it("an attack by hand uses the attack, rolls nothing and deals nothing", () => {
    const s = session(["goblin-warrior"]);
    const sheet = s.sheet();
    const attack = sheet.attacks[0]?.name as string;
    const hp = s.hp("goblin-warrior");
    const r = s.act({
      type: "attack",
      id: "ilse",
      target: "goblin-warrior",
      attack,
      manual: true,
    });
    expect(r.result).toMatchObject({ manual: true, action: "attack", targets: ["goblin-warrior"] });
    expect(r.rolls).toEqual([]);
    expect(s.hp("goblin-warrior")).toBe(hp);
    expect(s.encounter().combatants.find((c) => c.id === "ilse")?.used.action).toBe(true);
  });
});
