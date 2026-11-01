import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  builder,
  type Catalog,
  type CharacterBuild,
  type CharacterState,
  computePlaySheet,
  createCatalog,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  type EncounterResult,
  type Rng,
  resolve,
  rollDamage,
  useEmpoweredSpell,
} from "../src/index";
import { planCastOptions } from "../src/rules/metamagic";
import { srdPack } from "../src/srd";
import { autocomplete, classBuild, levelUpIn } from "./helpers";

// kenli F-002 T12 B2b: Empowered Spell after the damage roll, invented test data only (`source:
// test`): the SRD Metamagic features get their cast options, Empowered Spell's with the explicit
// `effect: empowered`. SRD "Empowered Spell": "When you roll damage for a spell, you can spend 1
// Sorcery Point to reroll a number of the damage dice up to your Charisma modifier (minimum of
// one), and you must use the new rolls. You can use Empowered Spell even if you've already used a
// different Metamagic option during the casting of the spell."
const opt = (id: string, cost: number, effect: string | null, combinable = false) => ({
  target: `features/${id}`,
  op: "set",
  path: "grants.cast_options",
  value: [
    {
      id,
      name: id,
      cost,
      resource_class: "sorcerer",
      resource: "sorcery-points",
      combinable,
      effect,
    },
  ],
});
const pack = {
  manifest: { id: "test-b2b", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
  patches: [
    opt("distant-spell", 1, "distant"),
    opt("quickened-spell", 2, "quickened"),
    opt("careful-spell", 1, "careful"),
    opt("empowered-spell", 1, "empowered", true),
  ],
};
const cat: Catalog = createCatalog([srdPack, pack], {});
const SP = "sorcerer:sorcery-points";

function sorcerer(level: number, picks: string[]): CharacterBuild {
  let b = classBuild("sorcerer");
  b = builder.setChoice(b, cat, "class:sorcerer#cantrips", [
    "fire-bolt",
    "acid-splash",
    "light",
    "mage-hand",
  ]).build;
  b = builder.setChoice(b, cat, "class:sorcerer#prepared", [
    "burning-hands",
    "magic-missile",
  ]).build;
  b = autocomplete(b, cat);
  b = autocomplete(builder.levelUp(b, cat, "sorcerer", null).build, cat);
  const mm = resolve(b, cat).choices.find((c) => c.key === "class:sorcerer:2#metamagic");
  b = builder.setChoice(b, cat, mm?.key ?? "", picks).build;
  return level > 2 ? levelUpIn(autocomplete(b, cat), "sorcerer", level - 2, null, cat) : b;
}
const keyOf = (b: CharacterBuild, id: string) =>
  computePlaySheet(b, createState(b, cat), cat).cast_options.find((o) => o.key.endsWith(id))
    ?.key as string;
const sp = (s: CharacterState) => s.uses_spent[SP] ?? 0;

/** The given values in order, then `rest` (kept within each roll's range). */
function seq(values: readonly number[], rest = 3): Rng {
  let i = 0;
  return { int: (min, max) => Math.min(max, Math.max(min, values[i++] ?? rest)) };
}

function fight(build: CharacterBuild, monsters: string[], state?: CharacterState) {
  const nb = builder.setName(build, cat, "Me").build;
  const characters: Record<string, { build: CharacterBuild; state: CharacterState }> = {
    me: { build: nb, state: state ?? createState(nb, cat) },
  };
  let e: Encounter = createEncounter();
  const act = (a: EncounterAction, rolls: readonly number[] = []): EncounterResult => {
    const r = applyEncounterAction(e, a, { catalog: cat, characters, rng: seq(rolls) });
    e = r.encounter;
    for (const [id, x] of Object.entries(r.states))
      characters[id] = { ...(characters[id] as (typeof characters)[string]), state: x };
    return r;
  };
  act({ type: "add_character", character: "me" });
  for (const m of monsters) act({ type: "add_monster", monster: m });
  act({ type: "set_initiative", id: "me", value: 20 });
  for (const c of e.combatants)
    if (c.id !== "me") act({ type: "set_initiative", id: c.id, value: 1 });
  act({ type: "start" });
  const hp = (id: string) => e.combatants.find((c) => c.id === id)?.hp;
  return {
    act,
    me: () => characters.me as { build: CharacterBuild; state: CharacterState },
    enc: () => e,
    hp,
  };
}

describe("B2b Empowered Spell: the cast option", () => {
  it("named with the cast it's not paid (only asked for); a spell without damage refuses it", () => {
    const b = sorcerer(3, ["empowered-spell", "distant-spell"]);
    const sheet = computePlaySheet(b, createState(b, cat), cat);
    const E = keyOf(b, "empowered-spell");
    const D = keyOf(b, "distant-spell");
    const burning = cat.spells["burning-hands"];
    const fire = cat.spells["fire-bolt"];
    if (!burning || !fire) throw new Error("SRD spells");
    const plan = planCastOptions(sheet, fire, [E, D]);
    // Combinable with another option; only Distant's point with the cast.
    expect(plan.empowered?.key).toBe(E);
    expect(plan.empowered?.reroll_dice).toBe(Math.max(1, sheet.modifiers.cha));
    expect(plan.costs).toEqual([{ type: "use", key: SP, amount: 1 }]);
    expect(planCastOptions(sheet, burning, [E]).costs).toEqual([]);
    const light = cat.spells.light;
    if (!light) throw new Error("SRD spell");
    expect(() => planCastOptions(sheet, light, [E])).toThrow(
      "empowered-spell: Light rolls no damage",
    );
  });
});

describe("B2b Empowered Spell on a roll by hand (the sheet)", () => {
  const b = builder.setName(sorcerer(3, ["empowered-spell", "distant-spell"]), cat, "Me").build;
  const state = createState(b, cat);
  const cha = computePlaySheet(b, state, cat).modifiers.cha;
  // Burning Hands' 3d6 rolled 3, 2, 4 (total 9).
  const damage = rollDamage([{ dice: "3d6", bonus: 0, type: "fire" }], { rng: seq([3, 2, 4]) });

  it("rerolls the chosen dice, keeps the new rolls even lower, 1 Sorcery Point once", () => {
    expect(cha).toBeGreaterThanOrEqual(2);
    const r = useEmpoweredSpell(
      b,
      state,
      cat,
      [damage],
      {
        roll: 0,
        dice: [
          { part: 0, die: 0 },
          { part: 0, die: 1 },
        ],
      },
      { spell: "burning-hands", rng: seq([1, 6]) },
    );
    expect(r.damage.parts[0]?.rolls).toEqual([1, 6, 4]);
    expect(r.damage.total).toBe(11);
    expect(r.damage.rerolled?.dice).toEqual([
      { part: 0, die: 0, from: 3, to: 1 },
      { part: 0, die: 1, from: 2, to: 6 },
    ]);
    expect(sp(r.state)).toBe(1);
    expect(r.messages[0]?.text).toBe(
      "empowered-spell: dice rerolled (3 → 1, 2 → 6), damage 9 → 11",
    );
    // Once per cast: any roll of it already empowered refuses another.
    expect(() =>
      useEmpoweredSpell(
        b,
        r.state,
        cat,
        [r.damage],
        { roll: 0, dice: [{ part: 0, die: 2 }] },
        {
          spell: "burning-hands",
        },
      ),
    ).toThrow("empowered-spell: already used on this spell");
  });

  it("refuses too many, repeated, unknown or non-damage dice, no Sorcery Point, an unknown spell: nothing spent", () => {
    const pick = (dice: { part: number; die: number }[], roll = 0) => ({ roll, dice });
    const opts = { spell: "burning-hands", rng: seq([5, 5, 5, 5, 5]) };
    const tooMany = Array.from({ length: cha + 1 }, (_, i) => ({ part: 0, die: i % 3 }));
    const big = rollDamage([{ dice: "8d6", bonus: 0, type: "fire" }], { rng: seq([]) });
    expect(() =>
      useEmpoweredSpell(
        b,
        state,
        cat,
        [big],
        pick(tooMany.map((_, i) => ({ part: 0, die: i }))),
        opts,
      ),
    ).toThrow(`empowered-spell: at most ${cha} dice`);
    expect(() =>
      useEmpoweredSpell(
        b,
        state,
        cat,
        [damage],
        pick([
          { part: 0, die: 1 },
          { part: 0, die: 1 },
        ]),
        opts,
      ),
    ).toThrow("empowered-spell: each die once");
    expect(() =>
      useEmpoweredSpell(b, state, cat, [damage], pick([{ part: 0, die: 3 }]), opts),
    ).toThrow();
    expect(() =>
      useEmpoweredSpell(b, state, cat, [damage], pick([{ part: 0, die: 0 }], 1), opts),
    ).toThrow();
    expect(() =>
      useEmpoweredSpell(b, state, cat, [null], pick([{ part: 0, die: 0 }]), opts),
    ).toThrow();
    // A flat bonus is no die.
    const flat = rollDamage([{ dice: null, bonus: 4, type: "fire" }], { rng: seq([]) });
    expect(() =>
      useEmpoweredSpell(b, state, cat, [flat], pick([{ part: 0, die: 0 }]), opts),
    ).toThrow();
    expect(() =>
      useEmpoweredSpell(b, state, cat, [damage], pick([{ part: 0, die: 0 }]), {
        spell: "fireball",
      }),
    ).toThrow("Me can't cast fireball");
    const empty = { ...state, uses_spent: { ...state.uses_spent, [SP]: 3 } };
    expect(() =>
      useEmpoweredSpell(b, empty, cat, [damage], pick([{ part: 0, die: 0 }]), opts),
    ).toThrow(/Sorcery Points/);
    const plain = builder.setName(
      sorcerer(3, ["distant-spell", "quickened-spell"]),
      cat,
      "Me",
    ).build;
    expect(() =>
      useEmpoweredSpell(
        plain,
        createState(plain, cat),
        cat,
        [damage],
        pick([{ part: 0, die: 0 }]),
        opts,
      ),
    ).toThrow("Me has no Empowered Spell");
  });
});

describe("B2b Empowered Spell in an encounter (after the damage roll)", () => {
  const b = sorcerer(3, ["empowered-spell", "careful-spell"]);
  const E = keyOf(b, "empowered-spell");
  const C = keyOf(b, "careful-spell");
  // Burning Hands on two Goblin Warriors: their Dexterity saves (2, 3), then ONE 3d6 for both.
  const cast: EncounterAction = {
    type: "cast",
    id: "me",
    spell: "burning-hands",
    targets: ["goblin-warrior", "goblin-warrior-2"],
    options: [E],
  };

  it("an area's one damage roll: paused with nothing applied, the chosen dice rerolled once for every target", () => {
    const f = fight(b, ["goblin-warrior", "goblin-warrior"]);
    const before = f.enc();
    const r = f.act(cast, [2, 3, 1, 1, 6]);
    expect(r.pending?.kind).toBe("empowered_spell");
    expect(r.pending?.dice?.map((d) => d.value)).toEqual([1, 1, 6]);
    expect(r.pending?.max_dice).toBe(computePlaySheet(b, createState(b, cat), cat).modifiers.cha);
    // Nothing applied: no slot, no Sorcery Point, no damage, the turn's action unused.
    expect(r.states).toEqual({});
    expect(f.me().state.spell_slots_spent.reduce((a, x) => a + x, 0)).toBe(0);
    expect(sp(f.me().state)).toBe(0);
    expect(f.hp("goblin-warrior")).toBe(
      before.combatants.find((c) => c.id === "goblin-warrior")?.hp,
    );
    expect(f.enc().combatants.find((c) => c.id === "me")?.used.action).toBe(false);
    // Another action waits for the answer.
    expect(() => f.act({ type: "next_turn" })).toThrow(/Waiting for a decision/);
    // Too many, repeated, unknown dice or a bare yes: refused, still pending, nothing spent.
    expect(() => f.act({ type: "decide", use: true, dice: [0, 1, 2, 0] })).toThrow();
    expect(() => f.act({ type: "decide", use: true, dice: [0, 0] })).toThrow("each die once");
    expect(() => f.act({ type: "decide", use: true, dice: [7] })).toThrow();
    expect(() => f.act({ type: "decide", use: true })).toThrow("Choose up to");
    expect(f.enc().pending?.kind).toBe("empowered_spell");
    expect(sp(f.me().state)).toBe(0);
    // The two 1s rerolled (5, 4): the same saves, 5 + 4 + 6 = 15 fire for each Goblin (10 HP).
    const done = f.act({ type: "decide", use: true, dice: [0, 1] }, [5, 4]);
    expect(done.encounter.pending).toBeNull();
    expect(f.me().state.spell_slots_spent[0]).toBe(1);
    expect(f.me().state.spell_slots_spent.reduce((a, x) => a + x, 0)).toBe(1);
    expect(sp(f.me().state)).toBe(1);
    const res = done.result as unknown as {
      damage: { parts: { rolls: number[] }[]; total: number };
      targets: { save: { roll: { d20: number } } }[];
    };
    expect(res.damage.parts[0]?.rolls).toEqual([5, 4, 6]);
    expect(res.damage.total).toBe(15);
    expect(res.targets.map((t) => t.save.roll.d20)).toEqual([2, 3]);
    expect(f.hp("goblin-warrior")).toBe(0);
    expect(f.hp("goblin-warrior-2")).toBe(0);
    expect(
      done.notes.some((n) => n.startsWith("empowered-spell: dice rerolled (1 → 5, 1 → 4)")),
    ).toBe(true);
  });

  it("keep (use: false): the rolled damage, no Sorcery Point; Careful paid with the cast alongside", () => {
    const f = fight(b, ["goblin-warrior", "goblin-warrior"]);
    const r = f.act(
      { ...cast, options: [C, E], careful: ["goblin-warrior"] } as EncounterAction,
      [3, 1, 2, 1],
    );
    expect(r.pending?.kind).toBe("empowered_spell");
    expect(sp(f.me().state)).toBe(0);
    const done = f.act({ type: "decide", use: false });
    expect(done.encounter.pending).toBeNull();
    // Careful's point only; the second Goblin took 1 + 2 + 1 = 4 (failed at 3), the first none.
    expect(sp(f.me().state)).toBe(1);
    expect(f.hp("goblin-warrior")).toBe(10);
    expect(f.hp("goblin-warrior-2")).toBe(6);
  });

  it("a spell attack: asked at the damage of a hit; refused without a Sorcery Point left for it", () => {
    const f = fight(b, ["ogre"]);
    const bolt: EncounterAction = {
      type: "cast",
      id: "me",
      spell: "fire-bolt",
      targets: ["ogre"],
      options: [E],
    };
    // A miss rolls no damage: nothing to ask.
    const miss = f.act(bolt, [2]);
    expect(miss.encounter.pending).toBeNull();
    expect(sp(f.me().state)).toBe(0);
    const g = fight(b, ["ogre"]);
    const hit = g.act(bolt, [18, 2]);
    expect(hit.pending?.dice).toEqual([{ part: 0, die: 0, value: 2, sides: 10, type: "fire" }]);
    g.act({ type: "decide", use: true, dice: [0] }, [9]);
    expect(sp(g.me().state)).toBe(1);
    expect(g.hp("ogre")).toBe(68 - 9);
    const spent = { ...createState(b, cat), uses_spent: { [SP]: 3 } };
    const h = fight(b, ["ogre"], spent);
    expect(() => h.act(bolt, [18, 2])).toThrow(/Sorcery Points/);
  });
});

// kenli F-002 T12 B2b (D032): Cunning Strike's die costs and Devious Strikes (SRD Rogue 5/11/14),
// Brutal Strike once per turn and at Barbarian 17 (2d10, two different effects). Devious Strikes
// is named by the content (`devious_strikes`, a test patch here; f002-t09's for the plans).
const strikePack = {
  manifest: { id: "test-b2b-strikes", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
  patches: [
    { target: "classes/rogue", op: "set", path: "features.14.rules", value: ["devious_strikes"] },
  ],
};
const scat: Catalog = createCatalog([srdPack, strikePack], {});
const hero = (cls: string, n: number, name: string) =>
  builder.setName(
    levelUpIn(autocomplete(classBuild(cls, { name }), scat), cls, n - 1, null, scat),
    scat,
    name,
  ).build;

function strikeFight(build: CharacterBuild, id: string) {
  const characters: Record<string, { build: CharacterBuild; state: CharacterState }> = {
    [id]: { build, state: createState(build, scat) },
  };
  let e: Encounter = createEncounter();
  const act = (a: EncounterAction, rolls: readonly number[] = []): EncounterResult => {
    const r = applyEncounterAction(e, a, { catalog: scat, characters, rng: seq(rolls) });
    e = r.encounter;
    for (const [k, x] of Object.entries(r.states))
      characters[k] = { ...(characters[k] as (typeof characters)[string]), state: x };
    return r;
  };
  act({ type: "add_character", character: id, side: "party" });
  act({ type: "add_monster", monster: "ogre", side: "enemies" });
  act({ type: "set_initiative", id, value: 20 });
  act({ type: "set_initiative", id: "ogre", value: 1 });
  act({ type: "start" });
  const ogre = () => e.combatants.find((c) => c.id === "ogre");
  return { act, ogre, enc: () => e };
}
const stab = (cunning: string[], attack = "Dagger"): EncounterAction =>
  ({
    type: "attack",
    id: "rook",
    target: "ogre",
    attack,
    ally_adjacent: true,
    riders: [{ rider: "sneak-attack" }],
    cunning,
  }) as EncounterAction;
const sneakDice = (r: EncounterResult) =>
  (r.result as unknown as { damage: { parts: { dice: string | null }[] } }).damage.parts.map(
    (p) => p.dice,
  );

describe("B2b Cunning Strike: die costs, Improved (11) and Devious Strikes (14)", () => {
  it("Rogue 11: two effects, both paid (Sneak Attack 6d6 − 2d6 = 4d6); three refused; Daze needs Devious Strikes", () => {
    const f = strikeFight(hero("rogue", 11, "Rook"), "rook");
    expect(() => f.act(stab(["trip", "withdraw", "poison"]))).toThrow(
      "Rook can use 2 Cunning Strike effects",
    );
    expect(() => f.act(stab(["daze"]))).toThrow(
      "Daze, Knock Out and Obscure come with Devious Strikes",
    );
    // Hit 18, Dagger 1d4, 4d6, then the Ogre's Dexterity save (2): Prone; Withdraw's movement.
    const r = f.act(stab(["trip", "withdraw"]), [18, 4, 6, 6, 6, 6, 2]);
    expect(sneakDice(r)).toEqual(["1d4", "4d6"]);
    expect(f.ogre()?.conditions).toContain("prone");
    expect(f.enc().combatants.find((c) => c.id === "rook")).toMatchObject({
      extra_movement: 15,
      disengaged: true,
    });
  });

  it("Rogue 14: Knock Out costs 6d6 of 7d6, Unconscious until it takes damage; Obscure 3d6 Blinded; more dice than it has refused", () => {
    const k = strikeFight(hero("rogue", 14, "Rook"), "rook");
    const r = k.act(stab(["knock_out"]), [18, 4, 6, 2]);
    expect(sneakDice(r)).toEqual(["1d4", "1d6"]);
    expect(k.ogre()?.conditions).toContain("unconscious");
    const effect = k
      .enc()
      .effects.find((x) => x.target === "ogre" && x.condition === "unconscious");
    expect(effect).toMatchObject({ ends_on: ["damage"], repeat_save: { ability: "con" } });
    // Knock Out + Obscure = 9d6 > 7d6: refused before any die.
    expect(() => k.act(stab(["knock_out", "obscure"]))).toThrow();
    const o = strikeFight(hero("rogue", 14, "Rook"), "rook");
    const ro = o.act(stab(["obscure"]), [18, 4, 6, 6, 6, 6, 2]);
    expect(sneakDice(ro)).toEqual(["1d4", "4d6"]);
    expect(o.ogre()?.conditions).toContain("blinded");
    expect(o.enc().effects.find((x) => x.condition === "blinded")?.ends).toMatchObject({
      at: "end",
      of: "ogre",
      count: 1,
    });
    // Until the end of ITS next turn: still Blinded at the start of it, gone after it.
    o.act({ type: "next_turn" });
    expect(o.ogre()?.conditions).toContain("blinded");
    o.act({ type: "next_turn" });
    expect(o.ogre()?.conditions ?? []).not.toContain("blinded");
  });

  it("Daze (2d6, Constitution save): on its next turn only one of moving, an action or a Bonus Action", () => {
    const f = strikeFight(hero("rogue", 14, "Rook"), "rook");
    const r = f.act(stab(["daze"]), [18, 4, 6, 6, 6, 6, 6, 2]);
    expect(sneakDice(r)).toEqual(["1d4", "5d6"]);
    expect(f.enc().marks).toContainEqual(
      expect.objectContaining({ kind: "dazed", on: "ogre", by: "rook" }),
    );
    f.act({ type: "next_turn" });
    f.act({ type: "move", id: "ogre", feet: 10 });
    expect(() => f.act({ type: "use", id: "ogre", what: "action" })).toThrow("Ogre is Dazed");
    expect(() => f.act({ type: "use", id: "ogre", what: "bonus_action" })).toThrow("Ogre is Dazed");
    // Moving again is still the one thing it does.
    f.act({ type: "move", id: "ogre", feet: 10 });
    f.act({ type: "next_turn" });
    expect(f.enc().marks.some((m) => m.kind === "dazed")).toBe(false);
  });
});

describe("B2b Brutal Strike: once per turn; Barbarian 17 2d10 and two different effects", () => {
  const swing = (brutal: string[]): EncounterAction =>
    ({ type: "attack", id: "grom", target: "ogre", attack: "Greataxe", brutal }) as EncounterAction;
  it("Barbarian 9: one attack roll per turn, hit or miss", () => {
    const f = strikeFight(hero("barbarian", 9, "Grom"), "grom");
    f.act({
      type: "effects",
      id: "grom",
      actions: [{ type: "activate", key: "barbarian:reckless-attack" }],
    });
    // The chosen roll misses (2): Brutal Strike is used for this turn all the same.
    f.act(swing(["hamstring"]), [2]);
    expect(() => f.act(swing(["forceful"]), [18, 6, 5])).toThrow("already used Brutal Strike");
    // Extra Attack's second attack without it: Reckless Advantage, no 1d10.
    const r = f.act(swing([]), [18, 17, 6]);
    const hit = r.result as unknown as {
      roll: { mode: string };
      damage: { parts: { dice: string | null }[] };
    };
    expect(hit.roll.mode).toBe("advantage");
    expect(hit.damage.parts.map((p) => p.dice)).toEqual(["1d12"]);
    // Its next turn, again.
    f.act({ type: "next_turn" });
    f.act({ type: "next_turn" });
    f.act({
      type: "effects",
      id: "grom",
      actions: [{ type: "activate", key: "barbarian:reckless-attack" }],
    });
    const again = f.act(swing(["hamstring"]), [18, 6, 5]);
    expect(
      (
        again.result as unknown as { damage: { parts: { dice: string | null }[] } }
      ).damage.parts.map((p) => p.dice),
    ).toEqual(["1d12", "1d10"]);
  });

  it("Barbarian 17: 2d10 extra, two different effects (Hamstring + Staggering); the same twice refused; the next turn again", () => {
    const f = strikeFight(hero("barbarian", 17, "Grom"), "grom");
    f.act({
      type: "effects",
      id: "grom",
      actions: [{ type: "activate", key: "barbarian:reckless-attack" }],
    });
    expect(() => f.act(swing(["hamstring", "hamstring"]))).toThrow();
    expect(() => f.act(swing(["hamstring", "staggering", "sundering"]))).toThrow("Grom can use 2");
    const r = f.act(swing(["hamstring", "staggering"]), [18, 6, 5, 5]);
    const hit = r.result as unknown as {
      roll: { mode: string };
      damage: { parts: { dice: string | null }[] };
    };
    expect(hit.roll.mode).toBe("normal");
    expect(hit.damage.parts.map((p) => p.dice)).toContain("2d10");
    expect(
      f
        .enc()
        .marks.map((m) => m.kind)
        .sort(),
    ).toEqual(["hamstrung", "staggered"]);
    // Extra Attack: the second attack this turn can't use Brutal Strike again.
    expect(() => f.act(swing(["forceful"]), [18, 6, 5, 5])).toThrow("already used Brutal Strike");
  });
});

describe("B2b Improved Brutal Strike's marks, used by the next roll (SRD Barbarian 13)", () => {
  function party() {
    const grom = hero("barbarian", 13, "Grom");
    const rook = hero("rogue", 5, "Rook");
    const characters: Record<string, { build: CharacterBuild; state: CharacterState }> = {
      grom: { build: grom, state: createState(grom, scat) },
      rook: { build: rook, state: createState(rook, scat) },
    };
    let e: Encounter = createEncounter();
    const act = (a: EncounterAction, rolls: readonly number[] = []): EncounterResult => {
      const r = applyEncounterAction(e, a, { catalog: scat, characters, rng: seq(rolls) });
      e = r.encounter;
      for (const [k, x] of Object.entries(r.states))
        characters[k] = { ...(characters[k] as (typeof characters)[string]), state: x };
      return r;
    };
    for (const c of ["grom", "rook"]) act({ type: "add_character", character: c, side: "party" });
    act({ type: "add_monster", monster: "ogre", side: "enemies" });
    act({ type: "set_initiative", id: "grom", value: 20 });
    act({ type: "set_initiative", id: "rook", value: 15 });
    act({ type: "set_initiative", id: "ogre", value: 1 });
    act({ type: "start" });
    act({
      type: "effects",
      id: "grom",
      actions: [{ type: "activate", key: "barbarian:reckless-attack" }],
    });
    return { act, enc: () => e };
  }
  const swing = (brutal: string[]): EncounterAction =>
    ({ type: "attack", id: "grom", target: "ogre", attack: "Greataxe", brutal }) as EncounterAction;

  it("Staggering Blow: the target's next save with Disadvantage (Rook's Trip), then it's gone", () => {
    const p = party();
    p.act(swing(["staggering"]), [18, 6, 5]);
    expect(p.enc().marks.map((m) => m.kind)).toEqual(["staggered"]);
    p.act({ type: "next_turn" });
    // Rook's Trip: the Ogre's Dexterity save rolls two d20 and keeps the lower (19, 2).
    const r = p.act(stab(["trip"]), [18, 4, 6, 6, 19, 2]);
    expect(
      r.notes.some((n) => /^Cunning Strike \(Trip\): Ogre fails/.test(n) && /disadvantage/.test(n)),
    ).toBe(true);
    expect(p.enc().marks.some((m) => m.kind === "staggered")).toBe(false);
  });

  it("Sundering Blow: +5 to the next attack roll against it by another creature, once; ends at the start of Grom's next turn", () => {
    const p = party();
    p.act(swing(["sundering"]), [18, 6, 5]);
    expect(p.enc().marks.map((m) => m.kind)).toEqual(["sundered"]);
    p.act({ type: "next_turn" });
    // Rook's Dagger: d20 1 + its bonus + 5 against AC 11 (a natural 1 still misses), the mark used.
    const r = p.act(stab([]), [9, 4, 6, 6, 6]);
    const hit = r.result as unknown as { total: number; hit: boolean };
    expect(r.notes.some((n) => /\+5/.test(n) || /Sundering/.test(n))).toBe(true);
    expect(hit.total).toBeGreaterThanOrEqual(9 + 5);
    expect(p.enc().marks.some((m) => m.kind === "sundered")).toBe(false);
    // A new one, unused: gone at the start of Grom's next turn.
    const q = party();
    q.act(swing(["sundering"]), [18, 6, 5]);
    q.act({ type: "next_turn" });
    q.act({ type: "next_turn" });
    q.act({ type: "next_turn" });
    expect(q.enc().marks.some((m) => m.kind === "sundered")).toBe(false);
  });
});
