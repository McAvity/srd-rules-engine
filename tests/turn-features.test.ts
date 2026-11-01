import { describe, expect, it } from "vitest";
import {
  type AttackResult,
  applyAction,
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  computePlaySheet,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  scriptedRng,
} from "../src/index";
import { autocomplete, catalog, classBuild, fighterBuild, levelUpIn } from "./helpers";

// SRD 5.2.1 class features used in turns: Second Wind, Action Surge, Lay On Hands, Monk's Focus
// (Flurry of Blows, Patient Defense, Step of the Wind), Stunning Strike, Uncanny Dodge, Bardic
// Inspiration.

const level = (classId: string, n: number, name: string) =>
  levelUpIn(autocomplete(classBuild(classId, { name })), classId, n - 1);

/** Characters (Initiative 20, 19…) then a goblin (5); `act` applies actions with scripted dice. */
function session(builds: Record<string, CharacterBuild>) {
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, catalog)]),
  );
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
  let result: unknown = null;
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    const rng = scriptedRng(rolls);
    for (const action of actions) {
      const characters = Object.fromEntries(
        Object.entries(builds).map(([k, build]) => [
          k,
          { build, state: states[k] as CharacterState },
        ]),
      );
      const r = applyEncounterAction(encounter, action, { catalog, characters, rng });
      encounter = r.encounter;
      Object.assign(states, r.states);
      notes.push(...r.notes);
      result = r.result;
    }
  };
  const keys = Object.keys(builds);
  act(
    [],
    ...keys.map((character) => ({ type: "add_character", character }) as const),
    { type: "add_monster", monster: "goblin-warrior" },
    ...keys.map((id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const),
    { type: "set_initiative", id: "goblin-warrior", value: 5 },
    { type: "start" },
  );
  const get = (id: string) => encounter.combatants.find((c) => c.id === id);
  return { act, notes, get, states, encounter: () => encounter, result: () => result };
}
const next = { type: "next_turn" } as const;
const feature = (id: string, name: string, extra: Partial<EncounterAction> = {}) =>
  ({ type: "feature", id, feature: name, ...extra }) as EncounterAction;

describe("Fighter", () => {
  it("Second Wind: a Bonus Action that heals 1d10 + Fighter level, in play too", () => {
    const brakka = fighterBuild();
    let state = applyAction(brakka, createState(brakka, catalog), catalog, {
      type: "damage",
      amount: 8,
    }).state;
    const r = applyAction(
      brakka,
      state,
      catalog,
      { type: "use_feature", key: "fighter:second-wind" },
      {
        rng: scriptedRng([6]),
      },
    );
    state = r.state;
    expect(r.notes).toContain("Second Wind: regains 7 Hit Points.");
    const sheet = computePlaySheet(brakka, state, catalog);
    expect(sheet.play.uses.find((u) => u.key === "fighter:second-wind")?.spent).toBe(1);
    const s = session({ brakka });
    s.act([3], feature("brakka", "Second Wind"));
    expect(s.get("brakka")?.used.bonus_action).toBe(true);
  });

  it("Action Surge: one additional action, after the first, not the Magic action", () => {
    const brakka = levelUpIn(fighterBuild(), "fighter", 1);
    const s = session({ brakka });
    expect(() => s.act([], feature("brakka", "Action Surge"))).toThrow(
      "Take your action first: Action Surge gives one additional action",
    );
    const swing = {
      type: "attack",
      id: "brakka",
      target: "goblin-warrior",
      attack: "Greatsword",
    } as const;
    s.act([2, 1], swing, feature("brakka", "Action Surge"));
    expect(s.get("brakka")).toMatchObject({ used: { action: false }, surged: true });
    s.act([2, 1], swing);
    expect(() => s.act([], swing)).toThrow("Brakka has no attacks left this turn");
  });

  it("Action Surge at 17: two uses, but only once per turn (SRD); the next turn again", () => {
    const brakka = levelUpIn(fighterBuild(), "fighter", 16);
    const s = session({ brakka });
    const swing = {
      type: "attack",
      id: "brakka",
      target: "goblin-warrior",
      attack: "Greatsword",
    } as const;
    s.act([2, 2, 2], swing, swing, swing, feature("brakka", "Action Surge"));
    s.act([2, 2, 2], swing, swing, swing);
    expect(() => s.act([], feature("brakka", "Action Surge"))).toThrow(/Action Surge/);
    expect(s.get("brakka")?.used.action).toBe(true);
  });

  it("Extra Attack's attacks left unused don't carry into the next turn (kenli F-002 T08)", () => {
    // SRD "Extra Attack": the attacks are part of the Attack action on that turn. Found by the
    // F-002 T08 browser pilot: one attack at 19, then the next turn took the leftover attacks
    // without the action, and a whole Attack action on top.
    const brakka = levelUpIn(fighterBuild(), "fighter", 4); // Fighter 5: two attacks
    const s = session({ brakka });
    const swing = {
      type: "attack",
      id: "brakka",
      target: "goblin-warrior",
      attack: "Greatsword",
    } as const;
    s.act([2], swing); // one of the two; one left this turn
    expect(s.get("brakka")?.attacks_left).toBe(1);
    s.act([], next, next); // the goblin's turn, then Brakka's again
    expect(s.get("brakka")?.used.action).toBe(false);
    expect(s.get("brakka")?.attacks_left).toBe(0);
    s.act([2], swing); // takes the Attack action: one more left in it
    expect(s.get("brakka")?.used.action).toBe(true);
    expect(s.get("brakka")?.attacks_left).toBe(1);
    s.act([2], swing);
    expect(() => s.act([2], swing)).toThrow(/no attacks left/);
  });

  it("the additional action can't cast a spell", () => {
    const ilse = levelUpIn(level("wizard", 1, "Ilse"), "fighter", 2);
    const s = session({ ilse });
    const cantrip = computePlaySheet(ilse, createState(ilse, catalog), catalog)
      .cantrips[0] as string;
    const bolt = {
      type: "cast",
      id: "ilse",
      spell: cantrip,
      targets: [],
    } satisfies EncounterAction;
    s.act([2], bolt, feature("ilse", "Action Surge"));
    expect(() => s.act([2], bolt)).toThrow(
      "Action Surge's additional action can't be the Magic action",
    );
  });
});

describe("Paladin, Monk, Rogue, Bard", () => {
  it("Lay On Hands: Hit Points from the pool, on another creature", () => {
    const anna = level("paladin", 1, "Anna");
    const brakka = fighterBuild();
    const s = session({ anna, brakka });
    s.act([], { type: "effects", id: "brakka", actions: [{ type: "damage", amount: 6 }] });
    expect(() =>
      s.act([], feature("anna", "Lay On Hands", { target: "brakka", amount: 6 })),
    ).toThrow("Lay On Hands: 5 left");
    s.act([], feature("anna", "Lay On Hands", { target: "brakka", amount: 4 }));
    expect(s.notes).toContain("Brakka regains 4 Hit Points.");
    const sheet = computePlaySheet(anna, s.states.anna as CharacterState, catalog);
    expect(sheet.play.uses.find((u) => u.key === "paladin:lay-on-hands")?.spent).toBe(4);
  });

  it("Flurry of Blows, Patient Defense, Step of the Wind", () => {
    const kai = level("monk", 2, "Kai");
    const s = session({ kai });
    s.act([], feature("kai", "Flurry of Blows"));
    const punch = {
      type: "attack",
      id: "kai",
      target: "goblin-warrior",
      attack: "Unarmed Strike",
      granted: true,
    } as const;
    s.act([2, 2], punch, punch);
    expect(() => s.act([2], punch)).toThrow("Kai has no granted attacks left this turn");
    expect(s.get("kai")?.used).toMatchObject({ action: false, bonus_action: true });
    s.act([], next, next, feature("kai", "Patient Defense"));
    expect(s.get("kai")).toMatchObject({ disengaged: true, dodging: true });
    expect(() => s.act([], feature("kai", "Step of the Wind"))).toThrow(
      "Kai has already used its bonus action this turn",
    );
  });

  it("Stunning Strike: after a hit, a Constitution save or Stunned until the monk's next turn", () => {
    const kai = level("monk", 5, "Kai");
    const s = session({ kai });
    const strike = feature("kai", "Stunning Strike", { target: "goblin-warrior" });
    expect(() => s.act([], strike)).toThrow("Kai hasn't hit Goblin Warrior this turn");
    s.act([18, 1], {
      type: "attack",
      id: "kai",
      target: "goblin-warrior",
      attack: "Unarmed Strike",
    });
    s.act([1], strike);
    expect(s.get("goblin-warrior")?.conditions).toEqual(["stunned"]);
    expect(s.encounter().effects).toMatchObject([
      {
        target: "goblin-warrior",
        condition: "stunned",
        source: "kai",
        ends: { at: "start", of: "kai" },
      },
    ]);
    expect(() => s.act([], strike)).toThrow("Kai has already used Stunning Strike this turn");
    s.act([], next, next); // the goblin's (Stunned) turn, then Kai's: Stunned ends
    expect(s.get("goblin-warrior")?.conditions).toEqual([]);
  });

  it("Uncanny Dodge: the rogue's reaction halves a hit's damage", () => {
    const pip = level("rogue", 5, "Pip");
    const s = session({ pip });
    s.act([], next); // the goblin's turn
    s.act([19, 6], {
      type: "attack",
      id: "goblin-warrior",
      target: "pip",
      attack: "Scimitar",
    });
    const hit = s.result() as AttackResult;
    expect(hit.hit).toBe(true);
    expect(s.notes).toContain("Pip uses Uncanny Dodge: the damage is halved.");
    expect(s.get("pip")?.used.reaction).toBe(true);
  });

  it("Bardic Inspiration: a die added to the ally's next failed D20 Test", () => {
    const lute = level("bard", 1, "Lute");
    const brakka = fighterBuild();
    const s = session({ lute, brakka });
    expect(() => s.act([], feature("lute", "Bardic Inspiration"))).toThrow(
      "Bardic Inspiration is used on another creature",
    );
    s.act([], feature("lute", "Bardic Inspiration", { target: "brakka" }));
    expect(s.get("brakka")?.inspiration).toEqual({ die: 6, by: "lute" });
    // A Strength check: 2 + 3 fails DC 9 by 4, which a d6 can make up: rolled (5) and added.
    s.act([2, 5], { type: "check", id: "brakka", ability: "str", dc: 9 });
    expect(s.notes).toContain("Brakka adds its Bardic Inspiration die: 5.");
    expect(s.get("brakka")?.inspiration).toBeNull();
  });
});
