import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyEncounterAction,
  builder,
  type CharacterBuild,
  type CharacterState,
  checkAction,
  computePlaySheet,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  EncounterError,
  FORCEABLE_REFUSALS,
  scriptedRng,
} from "../src/index";
import { autocomplete, catalog, classBuild, fighterBuild, levelUpIn } from "./helpers";

// A GM override (`force: true`): a refusal of legality (turn, economy, range, movement,
// resources) becomes a note and the action applies; anything else still refuses.

/** A level 5 Wizard with Fireball prepared. */
function wizard(): CharacterBuild {
  const b = levelUpIn(autocomplete(classBuild("wizard", { name: "Ilse" })), "wizard", 4);
  const prepared = b.choices["class:wizard#prepared"] ?? [];
  return builder.setChoice(b, catalog, "class:wizard#prepared", ["fireball", ...prepared.slice(1)])
    .build;
}

/** One character first in the order, then monsters; started. */
function session(key: string, build: CharacterBuild, monsters: string[], state?: CharacterState) {
  let encounter: Encounter = createEncounter();
  let current = state ?? createState(build, catalog);
  const ctx = () => ({ catalog, characters: { [key]: { build, state: current } } });
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    let r: ReturnType<typeof applyEncounterAction> | null = null;
    for (const action of actions) {
      r = applyEncounterAction(encounter, action, { ...ctx(), rng: scriptedRng(rolls) });
      encounter = r.encounter;
      current = r.states[key] ?? current;
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
    ctx,
    encounter: () => encounter,
    state: () => current,
    sheet: () => computePlaySheet(build, current, catalog),
    hp: (id: string) => encounter.combatants.find((c) => c.id === id)?.hp,
  };
}

const swing: EncounterAction = {
  type: "attack",
  id: "brakka",
  target: "goblin-warrior",
  attack: "Greatsword",
};

describe("GM override (force)", () => {
  it("a Fighter with no attack left attacks anyway, with the override noted", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"]);
    s.act([2, 1, 1], swing); // a miss: the Attack action's one attack
    expect(() => s.act([15, 3, 4], swing)).toThrow("Brakka has no attacks left this turn");
    const r = s.act([15, 3, 4], { ...swing, force: true });
    expect(r.messages[0]).toMatchObject({
      code: "override.applied",
      text: "GM override: Brakka has no attacks left this turn",
    });
    expect(r.result).toMatchObject({ hit: true });
    expect(s.hp("goblin-warrior")).toBeLessThan(10);
  });

  it("overrides the turn and range too, and checkAction says what it would override", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"]);
    s.act(
      [],
      { type: "place", id: "brakka", x: 0, y: 0 },
      { type: "place", id: "goblin-warrior", x: 4, y: 0 },
      { type: "next_turn" },
    );
    const plain = checkAction(s.encounter(), swing, s.ctx());
    expect(plain.ok).toBe(false);
    expect(plain.codes).toContain("not_your_turn");
    const forced = checkAction(s.encounter(), { ...swing, force: true }, s.ctx());
    expect(forced.ok).toBe(true);
    expect(forced.override_codes).toEqual(["not_your_turn", "out_of_range"]);
    expect(forced.overrides?.map((m) => m.text)).toEqual([
      "It isn't Brakka's turn: only a reaction can attack",
      "Goblin Warrior is 20 feet away: out of Greatsword's reach (5 ft)",
    ]);
    expect(checkAction(s.encounter(), swing, s.ctx()).overrides).toBeUndefined();
  });

  it("a forced cast without a slot of its level casts it and spends no slot", () => {
    const build = wizard();
    let state = createState(build, catalog);
    for (let i = 0; i < 2; i++) {
      state = applyAction(build, state, catalog, { type: "spend_slot", level: 3 }).state;
    }
    const s = session("ilse", build, ["goblin-warrior"], state);
    const cast: EncounterAction = {
      type: "cast",
      id: "ilse",
      spell: "fireball",
      slot_level: 3,
      targets: ["goblin-warrior"],
    };
    expect(() => s.act([1, ...Array<number>(8).fill(1)], cast)).toThrow(
      /Ilse: .*level 3 spell slots? left/,
    );
    const r = s.act([1, ...Array<number>(8).fill(1)], { ...cast, force: true });
    expect(r.messages.filter((m) => m.code === "override.applied")).toHaveLength(1);
    expect(s.hp("goblin-warrior")).toBe(2);
    expect(s.sheet().play.spell_slots.find((x) => x.level === 3)?.spent).toBe(2);
  });

  it("force doesn't override what isn't a matter of legality", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"]);
    const unknown: EncounterAction = {
      type: "cast",
      id: "brakka",
      spell: "no-such-spell",
      targets: ["goblin-warrior"],
      force: true,
    };
    expect(() => s.act([], unknown)).toThrow(EncounterError);
    const check = checkAction(s.encounter(), { ...swing, target: "nobody", force: true }, s.ctx());
    expect(check).toMatchObject({ ok: false, codes: ["unknown"], overrides: [] });
    expect(FORCEABLE_REFUSALS).not.toContain("unknown");
  });

  it("a forced move beyond Speed moves, and a forced legendary action spends no more uses", () => {
    const s = session("brakka", fighterBuild(), ["adult-blue-dragon"]);
    s.act([], { type: "place", id: "brakka", x: 0, y: 0 });
    expect(() => s.act([], { type: "move", id: "brakka", feet: 40 })).toThrow("can move 30");
    const r = s.act([], { type: "move", id: "brakka", feet: 40, force: true });
    expect(r.notes[0]).toBe("GM override: Brakka can move 30 more feet this turn");
    const legendary: EncounterAction = {
      type: "legendary",
      id: "adult-blue-dragon",
      action: "Tail Swipe",
      target: "brakka",
      force: true,
    };
    // Three uses a round; a natural 1 misses, so nothing else is rolled.
    for (let i = 0; i < 3; i++) s.act([1], { ...legendary, force: false });
    expect(() => s.act([1], { ...legendary, force: false })).toThrow("no legendary action uses");
    s.act([1], legendary);
    const dragon = s.encounter().combatants.find((c) => c.id === "adult-blue-dragon");
    expect(dragon?.legendary_used).toBe(3);
  });
});
