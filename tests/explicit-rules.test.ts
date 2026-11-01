import { describe, expect, it } from "vitest";
import {
  type AttackResult,
  applyAction,
  applyEncounterAction,
  builder,
  type CharacterBuild,
  type CharacterState,
  type CheckResult,
  combatantOptions,
  computePlaySheet,
  createCatalog,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  fixedRng,
  type Rng,
  scriptedRng,
} from "../src/index";
import { srdPack } from "../src/srd";
import { fighterBuild, levelUpIn } from "./helpers";

// kenli F-002 T08 (R09-02/03): named rules a pack opts into explicitly. The SRD's content stays as
// it is; a pack appends the rules with patches (as the P01 private pack does) or grants them in its
// own feats. Invented test content only.
const pack = {
  manifest: { id: "test-explicit", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
  feats: [
    {
      id: "test-breaker",
      name: "Test Breaker",
      category: "origin",
      grants: {
        rules: ["guarded_mind", "concentration_breaker"],
        resources: [
          { id: "guarded-mind", name: "Test Guard", max: { value: 1 }, recharge: "short" },
        ],
      },
    },
  ],
  patches: [
    { target: "classes/fighter", op: "append", path: "features.2.rules", value: "tactical_mind" },
    { target: "classes/fighter", op: "append", path: "features.5.rules", value: "tactical_shift" },
    { target: "classes/fighter", op: "append", path: "features.9.rules", value: "tactical_master" },
    {
      target: "classes/fighter",
      op: "append",
      path: "features.13.rules",
      value: "studied_attacks",
    },
    {
      target: "feats/savage-attacker",
      op: "append",
      path: "grants.rules",
      value: "savage_attacker",
    },
    {
      target: "feats/great-weapon-fighting",
      op: "append",
      path: "grants.rules",
      value: "great_weapon_fighting",
    },
  ],
};
const catalog = createCatalog([srdPack, pack], {});
const srd = createCatalog([srdPack], {});

/** Brakka (Soldier: Savage Attacker), Fighter `level`; `breaker`: Test Breaker as the Human feat. */
function brakka(level: number, breaker = false): CharacterBuild {
  let b = levelUpIn(fighterBuild(), "fighter", level - 1, null, catalog);
  if (breaker) {
    const choices = Object.fromEntries(
      Object.entries(b.choices).filter(([k]) => !k.startsWith("feat:skilled@")),
    );
    b = builder.setChoice({ ...b, choices }, catalog, "species:human#versatile", [
      "test-breaker",
    ]).build;
  }
  return b;
}

function session(b: CharacterBuild, monsters: string[] = ["goblin-warrior"], cat = catalog) {
  let state = createState(b, cat);
  let encounter: Encounter = createEncounter();
  const notes: string[] = [];
  let result: unknown = null;
  const ctx = () => ({ catalog: cat, characters: { brakka: { build: b, state } } });
  const act = (action: EncounterAction, rng: Rng = fixedRng(10)) => {
    const r = applyEncounterAction(encounter, action, { ...ctx(), rng });
    encounter = r.encounter;
    if (r.states.brakka) state = r.states.brakka;
    notes.push(...r.notes);
    result = r.result;
    return r;
  };
  act({ type: "add_character", character: "brakka" });
  for (const m of monsters) act({ type: "add_monster", monster: m });
  act({ type: "set_initiative", id: "brakka", value: 20 });
  monsters.forEach((m, i) => {
    act({ type: "set_initiative", id: i ? `${m}-${i + 1}` : m, value: 10 - i });
  });
  act({ type: "start" });
  return {
    act,
    notes,
    get state() {
      return state;
    },
    set state(s: CharacterState) {
      state = s;
    },
    get encounter() {
      return encounter;
    },
    result: () => result,
    get: (id: string) => encounter.combatants.find((c) => c.id === id),
    options: () => combatantOptions(encounter, "brakka", ctx()),
    spent: (ending: string) =>
      computePlaySheet(b, state, cat).play.uses.find((u) => u.key.endsWith(ending))?.spent ?? 0,
  };
}
const ask = { type: "set_decisions", id: "brakka", mode: "ask" } as const;
const next = { type: "next_turn" } as const;
const swing = (target = "goblin-warrior", extra: object = {}): EncounterAction =>
  ({ type: "attack", id: "brakka", target, attack: "Greatsword", ...extra }) as EncounterAction;

describe("explicit rules: opt-in only", () => {
  it("the SRD alone switches none of them on; the pack's patches do, at their levels", () => {
    const rules = (b: CharacterBuild, cat = catalog) =>
      computePlaySheet(b, createState(b, cat), cat).rules;
    const b13 = brakka(13);
    expect(rules(b13, srd)).not.toEqual(expect.arrayContaining(["tactical_mind"]));
    for (const r of ["tactical_mind", "savage_attacker"]) expect(rules(b13, srd)).not.toContain(r);
    expect(rules(b13)).toEqual(
      expect.arrayContaining([
        "tactical_mind",
        "tactical_shift",
        "tactical_master",
        "studied_attacks",
        "savage_attacker",
      ]),
    );
    expect(rules(brakka(1))).not.toContain("tactical_mind");
    expect(rules(brakka(4))).not.toContain("tactical_shift");
    expect(rules(brakka(8))).not.toContain("tactical_master");
    expect(rules(brakka(12))).not.toContain("studied_attacks");
  });
});

describe("Tactical Mind (C8)", () => {
  /** The check's bonus, from a check with no DC (no question). */
  const setup = () => {
    const s = session(brakka(2));
    s.act(ask);
    s.act({ type: "check", id: "brakka", skill: "athletics" }, scriptedRng([10]));
    const bonus = (s.result() as CheckResult).bonus;
    return { s, dc: 1 + bonus + 6 };
  };

  it("a failed check: +1d10; a success spends one Second Wind", () => {
    const { s, dc } = setup();
    s.act({ type: "check", id: "brakka", skill: "athletics", dc }, scriptedRng([1]));
    expect(s.encounter.pending?.kind).toBe("tactical_mind");
    s.act({ type: "decide", use: true }, scriptedRng([7]));
    expect(s.result()).toMatchObject({ success: true, tactical_mind: { roll: 7, spent: true } });
    expect(s.spent(":second-wind")).toBe(1);
  });

  it("still failed: nothing spent; declined: no d10; none left: no question", () => {
    const { s, dc } = setup();
    s.act({ type: "check", id: "brakka", skill: "athletics", dc }, scriptedRng([1]));
    s.act({ type: "decide", use: true }, scriptedRng([3]));
    expect(s.result()).toMatchObject({ success: false, tactical_mind: { roll: 3, spent: false } });
    expect(s.spent(":second-wind")).toBe(0);
    s.act({ type: "check", id: "brakka", skill: "athletics", dc }, scriptedRng([1]));
    s.act({ type: "decide", use: false });
    expect(s.result()).toMatchObject({ success: false, tactical_mind: null });
    for (let i = 0; i < 2; i++)
      s.state = applyAction(brakka(2), s.state, catalog, {
        type: "use",
        key: "fighter:second-wind",
      }).state;
    s.act({ type: "check", id: "brakka", skill: "athletics", dc }, scriptedRng([1, 9]));
    expect(s.encounter.pending).toBeNull();
    expect(s.result()).toMatchObject({ success: false, tactical_mind: null });
    expect(s.spent(":second-wind")).toBe(2);
  });
});

describe("Tactical Shift (5)", () => {
  it("Second Wind with a Bonus Action: half the Speed without Opportunity Attacks, noted; not at 4", () => {
    const s = session(brakka(5));
    s.act({ type: "feature", id: "brakka", feature: "Second Wind" } as EncounterAction);
    expect(s.get("brakka")?.used.bonus_action).toBe(true);
    expect(s.spent(":second-wind")).toBe(1);
    expect(s.notes.join("\n")).toMatch(
      /Tactical Shift: Brakka can move up to 15 feet \(half its Speed\) without provoking/,
    );
    const four = session(brakka(4));
    four.act({ type: "feature", id: "brakka", feature: "Second Wind" } as EncounterAction);
    expect(four.notes.join("\n")).not.toMatch(/Tactical Shift/);
  });
});

describe("Tactical Master (9)", () => {
  it("Push, Sap or Slow instead of the weapon's own mastery; offered on a mastered weapon only", () => {
    const s = session(brakka(9), ["ogre"]);
    const options = s.options().attacks;
    expect(
      options.find((o) => o.action.type === "attack" && o.label.startsWith("Greatsword"))
        ?.mastery_as,
    ).toEqual(["push", "sap", "slow"]);
    expect(options.find((o) => o.label.startsWith("Unarmed Strike"))?.mastery_as).toEqual([]);
    s.act(swing("ogre", { mastery_as: "sap" }), fixedRng(15));
    expect(s.notes.join("\n")).toMatch(/Brakka uses sap instead of Greatsword's mastery property/);
    expect(s.encounter.masteries.some((m) => m.mastery === "sap" && m.on === "ogre")).toBe(true);
    expect(() =>
      s.act({
        type: "attack",
        id: "brakka",
        target: "ogre",
        attack: "Unarmed Strike",
        mastery_as: "push",
      } as EncounterAction),
    ).toThrow(/needs a weapon whose mastery property it uses/);
    const eight = session(brakka(8));
    expect(eight.options().attacks.every((o) => o.mastery_as.length === 0)).toBe(true);
    expect(() => eight.act(swing("goblin-warrior", { mastery_as: "push" }))).toThrow(
      /has no Tactical Master/,
    );
  });
});

describe("Studied Attacks (13)", () => {
  it("a miss: Advantage on the next attack roll against that creature, not another; then gone", () => {
    const s = session(brakka(13), ["goblin-warrior", "goblin-warrior"]);
    s.act(swing(), fixedRng(2)); // a miss
    expect(s.encounter.marks.find((m) => m.kind === "studied")?.on).toBe("goblin-warrior");
    s.act(swing("goblin-warrior-2"), fixedRng(2)); // another creature: no Advantage
    expect((s.result() as AttackResult).roll.mode).toBe("normal");
    s.act(swing(), fixedRng(15));
    const studied = s.result() as AttackResult;
    expect(studied.roll.mode).toBe("advantage");
    expect(studied.reasons.join(" ")).toMatch(/Studied Attacks/);
    expect(s.encounter.marks.some((m) => m.kind === "studied" && m.on === "goblin-warrior")).toBe(
      false,
    );
    expect(session(brakka(12)).act(swing(), fixedRng(2)).encounter.marks).toEqual([]);
  });

  it("it lasts until the end of the attacker's next turn", () => {
    const s = session(brakka(13));
    s.act(swing(), fixedRng(2)); // a miss on Brakka's own turn
    s.act(next); // the goblin's turn
    expect(s.encounter.marks.some((m) => m.kind === "studied")).toBe(true);
    s.act(next); // Brakka's next turn
    expect(s.encounter.marks.some((m) => m.kind === "studied")).toBe(true);
    s.act(next); // its end
    expect(s.encounter.marks.some((m) => m.kind === "studied")).toBe(false);
  });
});

describe("Savage Attacker (Soldier's origin feat)", () => {
  it("a weapon hit: the weapon's dice again, the attacker picks; once per turn; not unarmed", () => {
    const s = session(brakka(5), ["ogre"]);
    s.act(ask);
    // Hit (18), Greatsword 2d6: 1+1; again: 6+6.
    s.act(swing("ogre"), scriptedRng([18, 1, 1, 6, 6]));
    expect(s.encounter.pending?.kind).toBe("savage_attacker");
    expect(s.encounter.pending?.question).toMatch(/damage dice rolled 5, then 15/);
    s.act({ type: "decide", use: true });
    const hit = s.result() as AttackResult;
    expect(hit.savage).toEqual({ first: [1, 1], second: [6, 6], used: true });
    expect(hit.damage?.parts[0]?.rolls).toEqual([6, 6]);
    expect(s.get("brakka")?.riders_used).toContain("savage_attacker");
    // The second hit this turn: no question, no extra dice.
    s.act(swing("ogre"), scriptedRng([18, 2, 2]));
    expect(s.encounter.pending).toBeNull();
    expect((s.result() as AttackResult).savage).toBeNull();
  });

  // kenli F-002 D002: "you can roll the weapon's damage dice twice and use either roll" — rolling
  // twice is the use (once per turn), whichever roll is kept.
  it("declined (the first roll kept), it's still used this turn; an Unarmed Strike isn't a weapon", () => {
    const s = session(brakka(5), ["ogre"]);
    s.act(ask);
    s.act(
      { type: "attack", id: "brakka", target: "ogre", attack: "Unarmed Strike" } as EncounterAction,
      scriptedRng([18]),
    );
    expect(s.encounter.pending).toBeNull();
    s.act(swing("ogre"), scriptedRng([18, 6, 6, 1, 1]));
    s.act({ type: "decide", use: false });
    expect((s.result() as AttackResult).savage).toEqual({
      first: [6, 6],
      second: [1, 1],
      used: false,
    });
    expect(s.get("brakka")?.riders_used).toContain("savage_attacker");
  });
});

describe("Mage Slayer-like: Guarded Mind and Concentration Breaker", () => {
  it("a failed Wisdom save succeeds instead (one use); none left: no question", () => {
    const s = session(brakka(4, true), ["cultist-fanatic"]);
    s.act(ask);
    s.act(next); // the fanatic's turn
    s.act(
      { type: "cast", id: "cultist-fanatic", spell: "hold-person", targets: ["brakka"] },
      fixedRng(1),
    );
    expect(s.encounter.pending?.kind).toBe("guarded_mind");
    s.act({ type: "decide", use: true }, fixedRng(1));
    expect(s.notes.join("\n")).toMatch(/Brakka succeeds instead with Guarded Mind/);
    expect(s.spent(":guarded-mind")).toBe(1);
    expect(s.get("brakka")?.conditions ?? []).not.toContain("paralyzed");
  });

  it("damaged by it, a concentrating creature saves with Disadvantage", () => {
    const s = session(brakka(4, true), ["cultist-fanatic"]);
    s.act(next);
    s.act(
      { type: "cast", id: "cultist-fanatic", spell: "hold-person", targets: ["brakka"] },
      fixedRng(20),
    );
    expect(s.get("cultist-fanatic")?.concentration).toBe("Hold Person");
    s.act(next); // Brakka's turn
    s.act(swing("cultist-fanatic"), fixedRng(18));
    expect(s.notes.join("\n")).toMatch(/Concentration Breaker/);
    const plain = session(brakka(4), ["cultist-fanatic"]);
    plain.act(next);
    plain.act(
      { type: "cast", id: "cultist-fanatic", spell: "hold-person", targets: ["brakka"] },
      fixedRng(20),
    );
    plain.act(next);
    plain.act(swing("cultist-fanatic"), fixedRng(18));
    expect(plain.notes.join("\n")).not.toMatch(/Concentration Breaker/);
  });
});

describe("Great Weapon Fighting", () => {
  const gwf = (cat = catalog) =>
    builder.setChoice(brakka(1), cat, "class:fighter#fighting_style", ["great-weapon-fighting"])
      .build;
  const hit = (b: CharacterBuild, attack: string, cat = catalog) => {
    const s = session(b, ["ogre"], cat);
    // Hit (18); the weapon's dice 1 and 2 (Flail: 1); Savage Attacker's second roll 1, 1.
    s.act(swing("ogre", { attack }), scriptedRng([18, 1, 2, 1, 1]));
    return { s, hit: s.result() as AttackResult };
  };

  it("two hands: a 1 or 2 on the damage dice counts as 3 (noted); one hand or no rule: not", () => {
    const { s, hit: two } = hit(gwf(), "Greatsword");
    expect(two.damage?.parts[0]).toMatchObject({ rolls: [3, 3], raw_rolls: [1, 2] });
    expect(s.notes.join("\n")).toMatch(
      /Great Weapon Fighting: Brakka's damage dice 1, 2 count as 3/,
    );
    // One hand (Flail): Savage Attacker's second roll (2) is used (automatic decisions), not a 3.
    const one = hit(gwf(), "Flail").hit;
    expect(one.savage).toEqual({ first: [1], second: [2], used: true });
    expect(one.damage?.parts[0]?.rolls).toEqual([2]);
    expect(one.damage?.parts[0]?.raw_rolls).toBeUndefined();
    const plain = hit(gwf(srd), "Greatsword", srd).hit;
    expect(plain.damage?.parts[0]?.rolls).toEqual([1, 2]);
  });
});
