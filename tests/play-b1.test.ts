import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyEncounterAction,
  builder,
  type Catalog,
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
  rollByHand,
} from "../src/index";
import { srdPack } from "../src/srd";
import { autocomplete, classBuild, levelUpIn } from "./helpers";

// kenli F-002 T12 batch B1 (D021/D022/D024), invented test content only (`source: test`):
// - a form's attacks dealing another damage type (`attack_damage_types` lines "shape"), an ability
//   added to a save while in a form (`shape_saves`), a once-per-turn rider on form attacks only
//   (`applies_to.lines`): Improved Circle Forms / Lunar Form-like;
// - a slot for a use only when none is left, once per turn (`restores_when_empty`), and a use for
//   a level 1 slot once per Long Rest (`also_spends`, `restores_slot`): Wild Resurgence-like;
// - a companion's strike: another damage type, a free action only after the command
//   (`after_feature`), two strikes per command at 11, a once-per-turn rider with class-level dice
//   (`scaling`), a rider with a condition and no save up to a size (`conditions`), and one Attack
//   action attack given up for the strike.
const cr = (l: number) => (l >= 8 ? 1 : l >= 4 ? 0.5 : 0.25);
const strikeName = "Test Strike";
const pack = {
  manifest: { id: "test-b1", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
  subclasses: [
    {
      id: "test-moon",
      name: "Test Moon",
      class: "druid",
      features: {
        "3": { shape_cr_divisor: 3, shape_ac: { base: 13, ability: "wis" }, shape_casting: true },
        "6": {
          shape_saves: [{ save: "con", ability: "wis" }],
          attack_damage_types: [{ lines: "shape", types: ["radiant"] }],
        },
        "14": {
          damage_riders: [
            {
              id: "lunar",
              name: "Test Lunar",
              damage: "2d10",
              type: "radiant",
              applies_to: { lines: "shape" },
              once_per_turn: true,
            },
          ],
        },
      },
    },
    {
      id: "test-beasts",
      name: "Test Beasts",
      class: "ranger",
      features: {
        "3": {
          attack_lines: [
            {
              name: strikeName,
              to_hit: "spell",
              damage: { dice: "1d8", bonus: 2, ability: "wis", type: "piercing" },
            },
          ],
          companions: [
            {
              name: "Test Beast",
              size: "Medium",
              hp: { base: 5, per_class_level: 5 },
              ac: { base: 13, ability: "wis" },
              speed: "40 ft.",
              attack: strikeName,
            },
          ],
          actions: [
            {
              id: "command",
              name: "Test Command",
              economy: "bonus_action",
              attacks: { attack: strikeName, count: 1 },
            },
          ],
          damage_riders: [
            {
              id: "charge",
              name: "Test Charge",
              damage: "1d6",
              applies_to: { lines: "companion" },
              conditions: { names: ["prone"], max_size: "large" },
            },
          ],
          at_class_level: [
            {
              level: 7,
              grants: {
                attack_damage_types: [{ lines: "companion", types: ["force"] }],
                actions: [
                  {
                    id: "beast-bonus",
                    name: "Test Beast's Bonus Action",
                    economy: "free",
                    once_per_turn: true,
                    after_feature: "command",
                  },
                ],
              },
            },
            {
              level: 11,
              grants: {
                actions: [
                  {
                    id: "command",
                    name: "Test Command (two)",
                    economy: "bonus_action",
                    attacks: { attack: strikeName, count: 2 },
                  },
                ],
                damage_riders: [
                  {
                    id: "fury",
                    name: "Test Fury",
                    damage: "1d6",
                    scaling: [{ level: 20, dice: "1d10" }],
                    type: "force",
                    applies_to: { lines: "companion" },
                    once_per_turn: true,
                  },
                ],
              },
            },
          ],
        },
      },
    },
  ],
  patches: [
    {
      target: "classes/druid",
      op: "append",
      path: "features.2.choices",
      value: {
        id: "forms",
        label: "Test forms",
        kind: "option",
        count: 2,
        rest_change: "long",
        scaling: {
          count: Array.from({ length: 20 }, (_, i) => (i < 1 ? 0 : 2)),
          max_cr: Array.from({ length: 20 }, (_, i) => cr(i + 1)),
        },
        fly_from: 8,
        options: [
          { id: "wolf", name: "Wolf", monster: "wolf", cr: 0.25 },
          { id: "rat", name: "Rat", monster: "rat", cr: 0 },
        ],
      },
    },
    {
      target: "classes/druid",
      op: "append",
      path: "features.2.actions",
      value: {
        id: "shape",
        name: "Test Shape",
        economy: "bonus_action",
        uses: "wild-shape",
        shape: { choice: "forms" },
      },
    },
    {
      target: "classes/druid",
      op: "append",
      path: "features.5.resources",
      value: {
        id: "resurgence-slot",
        name: "Test Resurgence Slot",
        max: { value: 1 },
        recharge: "long",
      },
    },
    {
      target: "classes/druid",
      op: "append",
      path: "features.5.actions",
      value: {
        id: "resurgence",
        name: "Test Resurgence",
        economy: "free",
        restores: "wild-shape",
        restores_when_empty: true,
        slot_payment: "required",
        once_per_turn: true,
      },
    },
    {
      target: "classes/druid",
      op: "append",
      path: "features.5.actions",
      value: {
        id: "resurgence-slot",
        name: "Test Resurgence (slot)",
        economy: "free",
        uses: "resurgence-slot",
        also_spends: "wild-shape",
        restores_slot: 1,
      },
    },
  ],
};
const cat: Catalog = createCatalog([srdPack, pack], {});

const druid = (level: number) => {
  let b = autocomplete(classBuild("druid"), cat);
  b = autocomplete(builder.levelUp(b, cat, "druid", null).build, cat);
  b = builder.setChoice(b, cat, "class:druid:2#forms", ["wolf", "rat"]).build;
  for (let l = 3; l <= level; l++) {
    b = builder.levelUp(b, cat, "druid", null).build;
    if (l === 3) b = builder.setChoice(b, cat, "class:druid:3#subclass", ["test-moon"]).build;
    b = autocomplete(b, cat);
  }
  return b;
};
const ranger = (level: number) => {
  let b = levelUpIn(autocomplete(classBuild("ranger"), cat), "ranger", 2, null, cat);
  b = builder.setChoice(b, cat, "class:ranger:3#subclass", ["test-beasts"]).build;
  return levelUpIn(autocomplete(b, cat), "ranger", level - 3, null, cat);
};
const shaped = (b: CharacterBuild) =>
  applyAction(b, createState(b, cat), cat, {
    type: "use_feature",
    key: "druid:shape",
    form: "wolf",
  }).state;
const BITE = "Bite (Wolf)";

function fight(build: CharacterBuild, state: CharacterState, monster = "ogre", rng = 15) {
  const nb = builder.setName(build, cat, "Me").build;
  const characters: Record<string, { build: CharacterBuild; state: CharacterState }> = {
    me: { build: nb, state },
  };
  let e: Encounter = createEncounter();
  const one = (a: EncounterAction) => {
    const r = applyEncounterAction(e, a, { catalog: cat, characters, rng: fixedRng(rng) });
    e = r.encounter;
    for (const [id, x] of Object.entries(r.states))
      characters[id] = { ...characters[id]!, state: x };
    return r;
  };
  const act = (a: EncounterAction | EncounterAction[]) => {
    const list = Array.isArray(a) ? a : [a];
    let r = one(list[0]!);
    for (const x of list.slice(1)) r = one(x);
    return r;
  };
  act([
    { type: "add_character", character: "me" },
    { type: "add_monster", monster },
    { type: "set_initiative", id: "me", value: 20 },
    { type: "set_initiative", id: monster, value: 1 },
    { type: "start" },
  ]);
  return { act, me: () => characters.me!.state, enc: () => e, target: monster };
}
const nextOwnTurn = (f: ReturnType<typeof fight>) =>
  f.act([{ type: "next_turn" }, { type: "next_turn" }]);

describe("D021: Improved Circle Forms and Lunar Form (Moon 6/14-like)", () => {
  it("Moon 6: a form's attack can deal Radiant (chosen per attack); Moon 5 can't; another type refused", () => {
    const b5 = druid(5);
    const b6 = druid(6);
    const l5 = computePlaySheet(b5, shaped(b5), cat).attacks.find((a) => a.name === BITE);
    const l6 = computePlaySheet(b6, shaped(b6), cat).attacks.find((a) => a.name === BITE);
    expect(l5?.damage_types).toBeUndefined();
    expect(l6?.damage_types).toEqual(["piercing", "radiant"]);
    const s = shaped(b6);
    const roll = (damage_type?: string) =>
      rollByHand(
        combatantFromCharacter(b6, s, cat),
        { type: "attack", attack: BITE, ...(damage_type ? { damage_type } : {}) } as never,
        { catalog: cat, character: { build: b6, state: s }, rng: fixedRng(12) },
      );
    expect(roll("radiant").rolls.attacks[0]?.damage?.parts.every((p) => p.type === "radiant")).toBe(
      true,
    );
    expect(roll().rolls.attacks[0]?.damage?.parts[0]?.type).toBe("piercing");
    expect(() => roll("fire")).toThrow(/can't deal fire damage/);
    // a weapon attack outside the form has no Radiant option
    const out = computePlaySheet(b6, createState(b6, cat), cat).attacks;
    expect(out.every((a) => !a.damage_types)).toBe(true);
  });
  it("Moon 6: Wisdom added to Constitution saves only while in a form", () => {
    const b6 = druid(6);
    const out = computePlaySheet(b6, createState(b6, cat), cat);
    const inForm = computePlaySheet(b6, shaped(b6), cat);
    expect(inForm.saving_throws.con.modifier).toBe(
      out.saving_throws.con.modifier + out.modifiers.wis,
    );
    const b5 = druid(5);
    expect(computePlaySheet(b5, shaped(b5), cat).saving_throws.con.modifier).toBe(
      computePlaySheet(b5, createState(b5, cat), cat).saving_throws.con.modifier,
    );
  });
  it("Moon 14: +2d10 Radiant on a form's hit, once per turn; not on other attacks; not at 13", () => {
    const b14 = druid(14);
    const sheet = computePlaySheet(b14, shaped(b14), cat);
    expect(sheet.attacks.find((a) => a.name === BITE)?.riders.map((r) => r.id)).toContain("lunar");
    expect(
      sheet.attacks
        .filter((a) => a.name !== BITE)
        .every((a) => !a.riders.some((r) => r.id === "lunar")),
    ).toBe(true);
    const b13 = druid(13);
    expect(
      computePlaySheet(b13, shaped(b13), cat).attacks.find((a) => a.name === BITE)?.riders,
    ).toEqual([]);
    const f = fight(b14, shaped(b14), "hill-giant", 15);
    const hit = f.act({
      type: "attack",
      id: "me",
      target: "hill-giant",
      attack: BITE,
      riders: [{ rider: "lunar" }],
    });
    expect(JSON.stringify(hit.result)).toContain("2d10");
    // Extra Attack isn't a druid's: the next attack this turn is refused anyway; next turn the rider is back.
    nextOwnTurn(f);
    expect(() =>
      f.act({
        type: "attack",
        id: "me",
        target: "hill-giant",
        attack: BITE,
        riders: [{ rider: "lunar" }],
      }),
    ).not.toThrow();
  });
});

describe("D021: Wild Resurgence (Druid 5-like)", () => {
  const KEY = "druid:resurgence";
  const BACK = "druid:resurgence-slot";
  const WS = "druid:wild-shape";
  const empty = (b: CharacterBuild) => {
    const max = computePlaySheet(b, createState(b, cat), cat).play.uses.find(
      (u) => u.key === WS,
    )!.max;
    return applyAction(b, createState(b, cat), cat, { type: "use", key: WS, amount: max }).state;
  };
  it("not before Druid 5; with a use left refused; with none left a slot gives one, no action", () => {
    const b4 = druid(4);
    expect(computePlaySheet(b4, createState(b4, cat), cat).actions.some((a) => a.key === KEY)).toBe(
      false,
    );
    const b = druid(5);
    const s0 = createState(b, cat);
    expect(() =>
      applyAction(b, s0, cat, {
        type: "use_feature",
        key: KEY,
        payment: { type: "slot", level: 1 },
      }),
    ).toThrow(/only when no Wild Shape is left/);
    const e = empty(b);
    expect(() => applyAction(b, e, cat, { type: "use_feature", key: KEY })).toThrow(/slot/);
    const r = applyAction(b, e, cat, {
      type: "use_feature",
      key: KEY,
      payment: { type: "slot", level: 3 },
    });
    expect(r.state.uses_spent[WS]).toBe((e.uses_spent[WS] ?? 0) - 1);
    expect(r.state.spell_slots_spent[2]).toBe(1);
  });
  it("in an encounter: once on each of its turns (free), again on its next turn", () => {
    const b = druid(5);
    const f = fight(b, empty(b));
    f.act({ type: "feature", id: "me", feature: KEY, payment: { type: "slot", level: 1 } });
    // again this turn (the use regained is there, so it's refused either way): once per turn first
    expect(() =>
      f.act({ type: "feature", id: "me", feature: KEY, payment: { type: "slot", level: 1 } }),
    ).toThrow(/already used/);
    nextOwnTurn(f);
    // its next turn: the use taken (a form), none left again → allowed once more
    f.act({ type: "feature", id: "me", feature: "druid:shape", form: "wolf" });
    expect(f.me().shape).toBe("wolf");
    expect(() =>
      f.act({ type: "feature", id: "me", feature: KEY, payment: { type: "slot", level: 1 } }),
    ).not.toThrow();
  });
  it("a Wild Shape use for a level 1 slot: once per Long Rest, only with a level 1 slot spent", () => {
    const b = druid(5);
    let s = createState(b, cat);
    expect(() => applyAction(b, s, cat, { type: "use_feature", key: BACK })).toThrow(/level 1/);
    s = applyAction(b, s, cat, { type: "spend_slot", level: 1 }).state;
    const r = applyAction(b, s, cat, { type: "use_feature", key: BACK });
    expect(r.state.spell_slots_spent[0] ?? 0).toBe(0);
    expect(r.state.uses_spent[WS]).toBe(1);
    const again = applyAction(b, r.state, cat, { type: "spend_slot", level: 1 }).state;
    expect(() => applyAction(b, again, cat, { type: "use_feature", key: BACK })).toThrow(/left/);
    const rested = applyAction(b, again, cat, { type: "long_rest" }).state;
    const s2 = applyAction(b, rested, cat, { type: "spend_slot", level: 1 }).state;
    expect(() => applyAction(b, s2, cat, { type: "use_feature", key: BACK })).not.toThrow();
  });
});

describe("D022/D024: the companion's strike and commands (Beast Master-like)", () => {
  it("Ranger 7: Force as its damage type; the beast's Bonus Action only after the command, once", () => {
    const b6 = ranger(6);
    const b7 = ranger(7);
    expect(
      computePlaySheet(b6, createState(b6, cat), cat).attacks.find((a) => a.name === strikeName)
        ?.damage_types,
    ).toBeUndefined();
    expect(
      computePlaySheet(b7, createState(b7, cat), cat).attacks.find((a) => a.name === strikeName)
        ?.damage_types,
    ).toEqual(["piercing", "force"]);
    const f = fight(b7, createState(b7, cat));
    expect(() => f.act({ type: "feature", id: "me", feature: "ranger:beast-bonus" })).toThrow(
      /only after Test Command/,
    );
    f.act({ type: "feature", id: "me", feature: "ranger:command" });
    const r = f.act({
      type: "attack",
      id: "me",
      target: "ogre",
      attack: strikeName,
      granted: true,
      damage_type: "force",
    });
    expect(JSON.stringify(r.result)).toContain("force");
    f.act({ type: "feature", id: "me", feature: "ranger:beast-bonus" });
    expect(() => f.act({ type: "feature", id: "me", feature: "ranger:beast-bonus" })).toThrow(
      /already used/,
    );
    // a second command this turn: the Bonus Action is spent
    expect(() => f.act({ type: "feature", id: "me", feature: "ranger:command" })).toThrow(
      /bonus action/i,
    );
  });
  it("Ranger 11: two strikes per command, a third refused; reset on its next turn", () => {
    const b = ranger(11);
    const f = fight(b, createState(b, cat), "hill-giant");
    f.act({ type: "feature", id: "me", feature: "ranger:command" });
    const strike = {
      type: "attack" as const,
      id: "me",
      target: "hill-giant",
      attack: strikeName,
      granted: true,
    };
    f.act(strike);
    f.act(strike);
    expect(() => f.act(strike)).toThrow(/no granted attacks left|granted/i);
    nextOwnTurn(f);
    expect(() => f.act(strike)).toThrow();
    f.act({ type: "feature", id: "me", feature: "ranger:command" });
    expect(() => f.act(strike)).not.toThrow();
  });
  it("one Attack action attack given up for the strike; a second strike that way refused", () => {
    const b = ranger(5);
    const f = fight(b, createState(b, cat), "hill-giant");
    const strike = { type: "attack" as const, id: "me", target: "hill-giant", attack: strikeName };
    f.act(strike);
    expect(() => f.act(strike)).toThrow(/already given up an attack/);
  });
  it("Bestial Fury: 1d6 Force at 11, 1d10 at 20, once per turn, on the strike only", () => {
    const r11 = computePlaySheet(ranger(11), createState(ranger(11), cat), cat).attacks;
    expect(
      r11.find((a) => a.name === strikeName)?.riders.find((r) => r.id === "fury"),
    ).toMatchObject({ dice: "1d6", type: "force", once_per_turn: true });
    expect(
      r11.filter((a) => a.name !== strikeName).some((a) => a.riders.some((r) => r.id === "fury")),
    ).toBe(false);
    const b20 = ranger(20);
    expect(
      computePlaySheet(b20, createState(b20, cat), cat)
        .attacks.find((a) => a.name === strikeName)
        ?.riders.find((r) => r.id === "fury")?.dice,
    ).toBe("1d10");
  });
  it("Charge: on a hit +1d6 and Prone without a save (Large); a Huge target isn't knocked Prone", () => {
    const b = ranger(5);
    const f = fight(b, createState(b, cat), "ogre", 18);
    const r = f.act({
      type: "attack",
      id: "me",
      target: "ogre",
      attack: strikeName,
      riders: [{ rider: "charge" }],
    });
    expect(r.messages.some((m) => m.code === "attack.rider_save")).toBe(false);
    expect(f.enc().combatants.find((c) => c.id === "ogre")?.conditions ?? []).toContain("prone");
    const g = fight(b, createState(b, cat), "hill-giant", 18);
    const r2 = g.act({
      type: "attack",
      id: "me",
      target: "hill-giant",
      attack: strikeName,
      riders: [{ rider: "charge" }],
    });
    expect(r2.messages.some((m) => m.code === "attack.rider_condition_size")).toBe(true);
    expect(g.enc().combatants.find((c) => c.id === "hill-giant")?.conditions ?? []).not.toContain(
      "prone",
    );
  });
});
