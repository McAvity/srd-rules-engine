import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyEncounterAction,
  builder,
  type CharacterBuild,
  type CharacterState,
  combatantFromCharacter,
  computePlaySheet,
  createCatalog,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  fixedRng,
  type Rng,
  type RollWhat,
  rollByHand,
  scriptedRng,
} from "../src/index";
import { srdPack } from "../src/srd";
import { classBuild, fighterBuild } from "./helpers";

// Invented test content only. A 2-use pool and riders that spend it, one exclusive group (one
// "trick" per attack), a rider with a target save, a rider with a once-per-turn alternative die,
// a rider that needs its own bonus action first, a weapon strike after the Attack action, a
// feat needing light armor training and an option that needs a save you lack.
const pack = {
  manifest: { id: "test-paid-riders", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
  feats: [
    {
      id: "test-focus-strike",
      name: "Test Focus Strike",
      category: "origin",
      grants: {
        resources: [{ id: "test-focus", name: "Test Focus", max: { value: 2 }, recharge: "short" }],
        actions: [
          {
            id: "test-dash",
            name: "Test Dash",
            economy: "bonus_action",
            uses: "test-focus",
            also: ["dash"],
          },
          {
            id: "test-pole",
            name: "Test Pole",
            economy: "bonus_action",
            after_attack_action: true,
            attacks: { attack: "Test Butt", count: 1 },
          },
        ],
        weapon_strikes: [
          {
            name: "Test Butt",
            die: "1d4",
            damage_type: "bludgeoning",
            properties: ["heavy", "two-handed"],
          },
        ],
        damage_riders: [
          {
            id: "test-focus-strike",
            name: "Test Focus Strike",
            damage: "1d6",
            applies_to: { weapon: true },
            uses: "test-focus",
          },
          {
            id: "test-trip",
            name: "Test Trip",
            damage: "1d6",
            applies_to: { weapon: true },
            uses: "test-focus",
            exclusive: "trick",
            save: { ability: "str", dc_ability: "str", conditions: ["prone"] },
            alternative: { dice: "1d8", label: "Test Relentless" },
          },
          {
            id: "test-shove",
            name: "Test Shove",
            damage: "1d6",
            applies_to: { weapon: true },
            uses: "test-focus",
            exclusive: "trick",
          },
          {
            id: "test-lunge",
            name: "Test Lunge",
            damage: "1d6",
            applies_to: { weapon: true },
            exclusive: "trick",
            requires_feature: "test-dash",
          },
          { id: "test-free", name: "Test Free", damage: "1d4", applies_to: { weapon: true } },
        ],
      },
    },
    {
      id: "test-armored",
      name: "Test Armored",
      category: "general",
      prerequisite: { level: 4, armor_training: ["light"] },
      grants: { armor_training: ["medium"] },
    },
    {
      id: "test-resilient",
      name: "Test Resilient",
      category: "general",
      prerequisite: { level: 4 },
      grants: {
        choices: [
          {
            id: "ability",
            label: "Test Resilient",
            kind: "option",
            count: 1,
            options: ["con", "wis"].map((a) => ({
              id: a,
              name: a,
              requires_lacking_saves: true,
              grants: { saving_throws: [a] },
            })),
          },
        ],
      },
    },
  ],
};
const catalog = createCatalog([srdPack, pack], {});
const key = "feat:test-focus-strike@species:human#versatile:test-focus";
const noDice: Rng = {
  int: () => {
    throw new Error("rolled a die");
  },
};

function brakka(): CharacterBuild {
  const b = fighterBuild();
  const choices = Object.fromEntries(
    Object.entries(b.choices).filter(([k]) => !k.startsWith("feat:skilled@")),
  );
  return builder.setChoice({ ...b, choices }, catalog, "species:human#versatile", [
    "test-focus-strike",
  ]).build;
}
const spend = (b: CharacterBuild, s: CharacterState, n: number) => {
  let st = s;
  for (let i = 0; i < n; i++) st = applyAction(b, st, catalog, { type: "use", key }).state;
  return st;
};
const byHand = (b: CharacterBuild, s: CharacterState, what: RollWhat, rng: Rng) =>
  rollByHand(combatantFromCharacter(b, s, catalog), what, {
    catalog,
    character: { build: b, state: s },
    rng,
  });

describe("rider sheet lines", () => {
  it("lists uses, group, the save with its DC, the alternative and the needed feature", () => {
    const b = brakka();
    const sword = computePlaySheet(b, createState(b, catalog), catalog).attacks.find(
      (a) => a.name === "Greatsword",
    );
    const trip = sword?.riders.find((r) => r.id === "test-trip");
    expect(trip).toMatchObject({
      uses: key,
      exclusive: "trick",
      alternative: { dice: "1d8", label: "Test Relentless" },
    });
    expect(trip?.save).toEqual({ ability: "str", dc: 8 + 2 + 3, conditions: ["prone"] });
    expect(sword?.riders.find((r) => r.id === "test-lunge")?.requires_feature).toMatch(
      /:test-dash$/,
    );
    expect(sword?.riders.find((r) => r.id === "test-free")).not.toHaveProperty("uses");
  });

  it("a weapon strike is a line from a carried qualifying weapon, its die and type replaced", () => {
    const b = brakka();
    const sheet = computePlaySheet(b, createState(b, catalog), catalog);
    const butt = sheet.attacks.find((a) => a.name === "Test Butt");
    const sword = sheet.attacks.find((a) => a.name === "Greatsword");
    expect(butt?.damage_parts[0]).toMatchObject({
      dice: "1d4",
      type: "bludgeoning",
      bonus: sword?.damage_parts[0]?.bonus,
    });
    expect(butt?.attack_bonus).toBe(sword?.attack_bonus);
    const unarmedOnly = computePlaySheet(b, { ...createState(b, catalog), inventory: [] }, catalog);
    expect(unarmedOnly.attacks.find((a) => a.name === "Test Butt")).toBeUndefined();
  });
});

describe("rolled by hand: costs computed, not enforced (the app's planner pays or forces)", () => {
  it("a paid rider is a use cost even with none left; the alternative costs nothing", () => {
    const b = brakka();
    const empty = spend(b, createState(b, catalog), 2);
    const r = byHand(
      b,
      empty,
      { type: "attack", attack: "Greatsword", riders: [{ rider: "test-focus-strike" }] },
      fixedRng(3),
    );
    expect(r.costs).toEqual([{ type: "play", action: { type: "use", key } }]);
    const alt = byHand(
      b,
      empty,
      { type: "attack", attack: "Greatsword", riders: [{ rider: "test-trip", alternative: true }] },
      fixedRng(3),
    );
    expect(alt.costs).toEqual([]);
    expect(alt.rolls.save).toEqual({ ability: "str", dc: 13 });
    expect(alt.rolls.attacks[0]?.damage?.parts.some((p) => p.dice === "1d8")).toBe(true);
  });

  it("the same rider twice, or two of one group, is refused before any die", () => {
    const b = brakka();
    const s = createState(b, catalog);
    expect(() =>
      byHand(
        b,
        s,
        {
          type: "attack",
          attack: "Greatsword",
          riders: [{ rider: "test-trip" }, { rider: "test-trip" }],
        },
        noDice,
      ),
    ).toThrow("once per attack");
    expect(() =>
      byHand(
        b,
        s,
        {
          type: "attack",
          attack: "Greatsword",
          riders: [{ rider: "test-trip" }, { rider: "test-shove" }],
        },
        noDice,
      ),
    ).toThrow("can't be added with");
    // Riders of no group still combine with one of the group: one cost each.
    const r = byHand(
      b,
      s,
      {
        type: "attack",
        attack: "Greatsword",
        riders: [{ rider: "test-trip" }, { rider: "test-focus-strike" }, { rider: "test-free" }],
      },
      fixedRng(3),
    );
    expect(r.costs).toHaveLength(2);
  });
});

function session(b: CharacterBuild, state: CharacterState) {
  const characters: Record<string, { build: CharacterBuild; state: CharacterState }> = {
    brakka: { build: b, state },
  };
  let encounter: Encounter = createEncounter();
  const act = (action: EncounterAction, rng: Rng = fixedRng(10)) => {
    const r = applyEncounterAction(encounter, action, { catalog, characters, rng });
    encounter = r.encounter;
    for (const [k, st] of Object.entries(r.states)) {
      const c = characters[k];
      if (c) characters[k] = { ...c, state: st };
    }
    return r;
  };
  act({ type: "add_character", character: "brakka" });
  act({ type: "add_monster", monster: "ogre" });
  act({ type: "set_initiative", id: "brakka", value: 20 });
  act({ type: "set_initiative", id: "ogre", value: 10 });
  act({ type: "start" });
  return {
    act,
    characters,
    get encounter() {
      return encounter;
    },
  };
}
const swing = (
  riders: { rider: string; alternative?: boolean }[],
  extra: object = {},
): EncounterAction =>
  ({
    type: "attack",
    id: "brakka",
    target: "ogre",
    attack: "Greatsword",
    riders,
    ...extra,
  }) as EncounterAction;

describe("in an encounter", () => {
  it("an exhausted or over-asked pool is refused before any die, nothing applied", () => {
    const b = brakka();
    const s = session(b, spend(b, createState(b, catalog), 2));
    const before = s.encounter;
    expect(() => s.act(swing([{ rider: "test-focus-strike" }]), noDice)).toThrow(
      "Test Focus: 0 left",
    );
    expect(s.encounter).toBe(before);
    const one = session(b, spend(b, createState(b, catalog), 1));
    expect(() =>
      one.act(swing([{ rider: "test-focus-strike" }, { rider: "test-trip" }]), noDice),
    ).toThrow("Test Focus: 1 left");
  });

  it("forced by the GM, the attack goes on and the use isn't spent (noted)", () => {
    const b = brakka();
    const s = session(b, spend(b, createState(b, catalog), 2));
    const r = s.act(swing([{ rider: "test-focus-strike" }], { force: true }));
    expect(r.result).toMatchObject({ hit: true });
    expect(s.characters.brakka?.state.uses_spent[key]).toBe(2);
    expect(r.notes.join(" ")).toMatch(/0 left/);
  });

  it("a hit spends once; a miss spends nothing; the rider's save is rolled by the target", () => {
    const b = brakka();
    const s = session(b, createState(b, catalog));
    s.act(swing([{ rider: "test-trip" }]), scriptedRng([2]));
    expect(s.characters.brakka?.state.uses_spent[key] ?? 0).toBe(0);
    s.act({ type: "next_turn" });
    s.act({ type: "next_turn" });
    const hit = s.act(swing([{ rider: "test-trip" }]), fixedRng(10));
    expect(s.characters.brakka?.state.uses_spent[key]).toBe(1);
    expect(hit.notes.join(" ")).toMatch(/Test Trip: Ogre (succeeds|fails)/);
  });

  it("the alternative is free, once per turn", () => {
    const b = brakka();
    const s = session(b, createState(b, catalog));
    s.act(swing([{ rider: "test-trip", alternative: true }]));
    expect(s.characters.brakka?.state.uses_spent[key] ?? 0).toBe(0);
    expect(() =>
      s.act(swing([{ rider: "test-trip", alternative: true }], { reaction: true }), noDice),
    ).toThrow("already used Test Relentless");
  });

  it("a rider that needs its bonus action, and a strike that needs the Attack action", () => {
    const b = brakka();
    const s = session(b, createState(b, catalog));
    expect(() => s.act(swing([{ rider: "test-lunge" }]), noDice)).toThrow("needs test-dash");
    expect(() => s.act({ type: "feature", id: "brakka", feature: "Test Pole" }, noDice)).toThrow(
      "follows the Attack action",
    );
    s.act({ type: "feature", id: "brakka", feature: "Test Dash" });
    expect(s.characters.brakka?.state.uses_spent[key]).toBe(1);
    s.act(swing([{ rider: "test-lunge" }]));
    expect(s.characters.brakka?.state.uses_spent[key]).toBe(1); // the Dash paid for it
  });
});

describe("prerequisites", () => {
  it("armor training: a Wizard without Light armor training can't take it; a Fighter can", () => {
    const wizard = classBuild("wizard");
    const ok = (b: CharacterBuild) => {
      const lv = builder.levelUp(
        builder.levelUp(
          builder.levelUp(b, catalog, b.class_id ?? "").build,
          catalog,
          b.class_id ?? "",
        ).build,
        catalog,
        b.class_id ?? "",
      ).build;
      const keyOf = builder
        .evaluate(lv, catalog)
        .resolution.choicesForLevel(4)
        .map((c) => c.key)
        .find((k) => k.endsWith(":4#feat")) as string;
      try {
        builder.setChoice(lv, catalog, keyOf, ["test-armored"]);
        return true;
      } catch {
        return false;
      }
    };
    expect(ok(wizard)).toBe(false);
    expect(ok(fighterBuild())).toBe(true);
  });

  it("an option granting a save you already have is unavailable; picking one you lack stays valid", () => {
    let b = fighterBuild();
    for (let i = 0; i < 3; i++) b = builder.levelUp(b, catalog, "fighter").build;
    b = builder.setChoice(b, catalog, "class:fighter:4#feat", ["test-resilient"]).build;
    const k = "feat:test-resilient@class:fighter:4#feat#ability";
    expect(() => builder.setChoice(b, catalog, k, ["con"])).toThrow(
      "already proficient in Constitution",
    );
    const wis = builder.setChoice(b, catalog, k, ["wis"]).build;
    const after = builder.levelUp(wis, catalog, "fighter").build;
    expect(
      builder.evaluate(after, catalog).report.issues.filter((i) => i.choice_key === k),
    ).toEqual([]);
  });
});
