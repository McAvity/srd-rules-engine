import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyEncounterAction,
  type CharacterBuild,
  type CharacterState,
  computePlaySheet,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  type SaveResult,
  type SpellCastResult,
  scriptedRng,
} from "../src/index";
import { autocomplete, catalog, classBuild, fighterBuild, levelUpIn } from "./helpers";

// SRD 5.2.1 class features used in turns: Indomitable, Deflect Attacks, Stunning Strike (on a
// success), Lay On Hands (Poisoned), Innate Sorcery, Channel Divinity (Divine Spark, Turn Undead).

const level = (classId: string, n: number, name: string, base?: CharacterBuild) =>
  levelUpIn(base ?? autocomplete(classBuild(classId, { name })), classId, n - 1);

function session(
  builds: Record<string, CharacterBuild>,
  monsters: { monster: string; at?: [number, number] }[] = [],
  at: Record<string, [number, number]> = {},
) {
  const states: Record<string, CharacterState> = Object.fromEntries(
    Object.entries(builds).map(([k, b]) => [k, createState(b, catalog)]),
  );
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
  let result: unknown = null;
  const ctx = () => ({
    catalog,
    characters: Object.fromEntries(
      Object.entries(builds).map(([k, build]) => [
        k,
        { build, state: states[k] as CharacterState },
      ]),
    ),
  });
  const act = (rolls: number[], ...actions: EncounterAction[]) => {
    for (const action of actions) {
      const r = applyEncounterAction(encounter, action, { ...ctx(), rng: scriptedRng(rolls) });
      encounter = r.encounter;
      Object.assign(states, r.states);
      notes.push(...r.notes);
      result = r.result;
    }
  };
  const keys = Object.keys(builds);
  const seen = new Map<string, number>();
  const ids = monsters.map(({ monster }) => {
    const n = (seen.get(monster) ?? 0) + 1;
    seen.set(monster, n);
    return n === 1 ? monster : `${monster}-${n}`;
  });
  act(
    [],
    ...keys.map((character) => ({ type: "add_character", character, side: "party" }) as const),
    ...monsters.map((m) => ({ type: "add_monster", monster: m.monster, side: "enemies" }) as const),
    ...keys.flatMap((id) =>
      at[id] ? [{ type: "place", id, x: at[id][0], y: at[id][1] } as const] : [],
    ),
    ...monsters.flatMap((m, i) =>
      m.at ? [{ type: "place", id: ids[i] as string, x: m.at[0], y: m.at[1] } as const] : [],
    ),
    ...[...keys, ...ids].map((id, i) => ({ type: "set_initiative", id, value: 20 - i }) as const),
    { type: "start" },
  );
  const get = (id: string) => encounter.combatants.find((c) => c.id === id);
  return { act, notes, get, states, encounter: () => encounter, result: () => result };
}
const next = { type: "next_turn" } as const;
const feature = (id: string, name: string, extra: Partial<EncounterAction> = {}) =>
  ({ type: "feature", id, feature: name, ...extra }) as EncounterAction;

describe("Fighter: Indomitable", () => {
  it("a failed save rerolled with the Fighter level, a use spent; a decision in ask mode", () => {
    const brakka = level("fighter", 9, "Brakka", fighterBuild());
    const s = session({ brakka }, [{ monster: "goblin-warrior" }]);
    s.act([], { type: "set_decisions", id: "brakka", mode: "ask" }, next);
    // The goblin's shove: Brakka saves (Strength +3 or Dexterity) against DC 12, rolls a 1.
    s.act([1], {
      type: "unarmed",
      id: "goblin-warrior",
      target: "brakka",
      option: "shove",
      shove: "prone",
    });
    expect(s.encounter().pending?.kind).toBe("indomitable");
    expect(s.encounter().pending?.question).toMatch(/Reroll it with Indomitable \(\+9\)\?/);
    s.act([5], { type: "decide", use: true });
    const save = s.result() as SaveResult;
    expect(save).toMatchObject({ indomitable: true, success: true });
    expect(s.notes).toContain("Brakka rerolls the save with Indomitable.");
    const sheet = computePlaySheet(brakka, s.states.brakka as CharacterState, catalog);
    expect(sheet.play.uses.find((u) => u.key.endsWith(":indomitable"))?.spent).toBe(1);
  });
});

describe("Monk: Deflect Attacks and Stunning Strike", () => {
  it("Deflect Attacks takes 1d10 + Dex + Monk level off a hit, with the reaction", () => {
    const kai = level("monk", 3, "Kai");
    const s = session({ kai }, [{ monster: "goblin-warrior" }]);
    s.act([], next);
    // Hits (19 + 4) for 1d6 + 2 = 6; Deflect: 1 + Dex 3 + 3 = 7.
    s.act([19, 4, 1], { type: "attack", id: "goblin-warrior", target: "kai", attack: "Scimitar" });
    expect(s.notes.some((n) => n.startsWith("Kai uses Deflect Attacks: 6 damage less"))).toBe(true);
    expect(s.get("kai")?.used.reaction).toBe(true);
    expect(computePlaySheet(kai, s.states.kai as CharacterState, catalog).play.hp.current).toBe(
      computePlaySheet(kai, createState(kai, catalog), catalog).play.hp.max,
    );
  });

  it("Stunning Strike on a successful save: Speed halved and Advantage on the next attack", () => {
    const kai = level("monk", 5, "Kai");
    const s = session({ kai }, [{ monster: "goblin-warrior" }]);
    s.act([18, 3], {
      type: "attack",
      id: "kai",
      target: "goblin-warrior",
      attack: "Unarmed Strike",
    });
    s.act([20], feature("kai", "Stunning Strike", { target: "goblin-warrior" }));
    expect(s.notes).toContain(
      "Stunning Strike: Goblin Warrior's Speed is halved until the start of Kai's next turn.",
    );
    expect(
      s
        .encounter()
        .marks.map((m) => m.kind)
        .sort(),
    ).toEqual(["advantage_against", "speed_halved"]);
    s.act([], next);
    expect(() => s.act([], { type: "move", id: "goblin-warrior", feet: 20 })).toThrow(
      "Goblin Warrior can move 15 more feet this turn",
    );
  });
});

describe("Paladin: Lay On Hands' cure", () => {
  it("5 points from the pool end Poisoned", () => {
    const vera = autocomplete(classBuild("paladin", { name: "Vera" }));
    const s = session({ vera });
    s.act([], {
      type: "effects",
      id: "vera",
      actions: [{ type: "add_condition", condition: "poisoned" }],
    });
    s.act([], feature("vera", "Lay On Hands (cure Poisoned)"));
    expect(s.states.vera?.conditions).toEqual([]);
    expect(s.states.vera?.uses_spent).toMatchObject({ "paladin:lay-on-hands": 5 });
    expect(() => s.act([], next, feature("vera", "Lay On Hands (cure Poisoned)"))).toThrow(
      "Vera isn't Poisoned",
    );
  });
});

describe("Sorcerer: Innate Sorcery", () => {
  it("while active: spell save DC +1 and Advantage on spell attack rolls", () => {
    const sora = autocomplete(classBuild("sorcerer", { name: "Sora" }));
    const before = computePlaySheet(sora, createState(sora, catalog), catalog).spellcasting[0]
      ?.save_dc;
    const s = session({ sora }, [{ monster: "goblin-warrior" }]);
    s.act([], {
      type: "effects",
      id: "sora",
      actions: [{ type: "activate", key: "sorcerer:innate-sorcery" }],
    });
    const sheet = computePlaySheet(sora, s.states.sora as CharacterState, catalog);
    expect(sheet.spellcasting[0]?.save_dc).toBe((before as number) + 1);
    const cantrip = sheet.spells.find((x) => catalog.spells[x.id]?.mechanics?.attack);
    expect(cantrip).toBeDefined();
    s.act([3, 18, 5, 5], {
      type: "cast",
      id: "sora",
      spell: cantrip?.id as string,
      targets: ["goblin-warrior"],
    });
    expect((s.result() as SpellCastResult).targets[0]?.attack?.roll.mode).toBe("advantage");
  });
});

describe("Cleric: Channel Divinity", () => {
  it("Divine Spark heals or harms (Constitution save, half on a success), a use each", () => {
    const ilsa = level("cleric", 2, "Ilsa");
    const s = session({ ilsa, brakka: fighterBuild() }, [{ monster: "goblin-warrior" }]);
    s.act([], { type: "effects", id: "brakka", actions: [{ type: "damage", amount: 8 }] });
    s.act([5], feature("ilsa", "Divine Spark (heal)", { target: "brakka" }));
    expect(s.notes).toContain(`Brakka regains ${5 + 2} Hit Points.`);
    expect(() =>
      s.act(
        [],
        next,
        next,
        next,
        feature("ilsa", "Divine Spark (harm)", { target: "goblin-warrior" }),
      ),
    ).toThrow("Divine Spark (harm): choose the damage type (necrotic or radiant)");
    s.act(
      [6, 1],
      feature("ilsa", "Divine Spark (harm)", { target: "goblin-warrior", damage_type: "radiant" }),
    );
    expect(s.notes).toContainEqual(
      expect.stringMatching(/^Goblin Warrior fails \(\d+ vs DC 12\): 8 radiant\.$/),
    );
    expect(s.states.ilsa?.uses_spent).toMatchObject({ "cleric:channel-divinity": 2 });
  });

  it("Turn Undead: undead within 30 feet save or are Frightened and Incapacitated; damage ends it", () => {
    const ilsa = level("cleric", 2, "Ilsa");
    const s = session(
      { ilsa },
      [
        { monster: "zombie", at: [2, 0] },
        { monster: "zombie", at: [3, 0] },
        { monster: "goblin-warrior", at: [1, 1] },
        { monster: "zombie", at: [12, 0] },
      ],
      { ilsa: [0, 0] },
    );
    expect(() =>
      s.act([], feature("ilsa", "Turn Undead", { targets: ["goblin-warrior"] })),
    ).toThrow("Goblin Warrior isn't undead");
    expect(() => s.act([], feature("ilsa", "Turn Undead", { targets: ["zombie-3"] }))).toThrow(
      "Zombie 3 is 60 feet away: out of Turn Undead's range (30 ft)",
    );
    s.act([1, 20], feature("ilsa", "Turn Undead", { targets: ["zombie", "zombie-2"] }));
    expect(s.get("zombie")?.conditions.sort()).toEqual(["frightened", "incapacitated"]);
    expect(s.get("zombie-2")?.conditions).toEqual([]);
    s.act([], { type: "effects", id: "zombie", actions: [{ type: "damage", amount: 1 }] });
    expect(s.get("zombie")?.conditions).toEqual([]);
    expect(s.notes.some((n) => n.includes("Turn Undead: it took damage"))).toBe(true);
  });
});

describe("play: Lay On Hands' cure through the state", () => {
  it("is a feature with a fixed cost", () => {
    const vera = autocomplete(classBuild("paladin", { name: "Vera" }));
    const r = applyAction(vera, createState(vera, catalog), catalog, {
      type: "use_feature",
      key: "paladin:lay-on-hands-cure",
    });
    expect(r.state.uses_spent).toMatchObject({ "paladin:lay-on-hands": 5 });
  });
});
