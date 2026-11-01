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
  fixedRng,
  parseEncounter,
  type RollWhat,
  rollByHand,
  rollCheck,
  scriptedRng,
  useAfterFailedRoll,
} from "../src/index";
import { srdPack } from "../src/srd";
import { autocomplete, classBuild, levelUpIn } from "./helpers";

// kenli F-002 T12 batch A: generic play hooks, with invented test content only.
// - C14: an encounter written before `used_until_turn` reads back to the same document.
// - D011 `free_casts[].at_will`: cast without a slot, nothing spent; a slot still upcasts.
// - D012 `spell_ranges`: flat / per class level / chosen spell / attack-roll-only; Distant doubles it.
// - D015 effect target `attack.melee_weapon`: melee weapons only.
// - D016 encounter `cast.triggers`; D018 a full pool gains nothing, the cast stays legal.
// - D026 `free_casts[].line`: the spell on the sheet only through its free cast (`free_only`).
// - D029 a tool's listed cost ("35 GP, 2 lb." in the SRD tools table) is its price.
const pack = {
  manifest: { id: "test-t12", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
  subclasses: [
    {
      id: "test-ranger-mage",
      name: "Test Ranger Mage",
      class: "wizard",
      features: {
        "3": {
          cantrips: ["fire-bolt"],
          spells: ["shield", "magic-missile", "counterspell"],
          resources: [
            { id: "ward", name: "Test Ward", max: { value: 5 }, recharge: "long", tracked: true },
            { id: "focus", name: "Test Focus", max: { value: 2 }, recharge: "short" },
            { id: "spark", name: "Test Spark", max: { value: 3 }, recharge: "long" },
            { id: "verve", name: "Test Verve", max: { value: 1 }, recharge: "long" },
          ],
          cast_triggers: [
            {
              id: "ward",
              name: "Test Ward",
              school: "abjuration",
              resource: "ward",
              create: true,
              restore_per_slot_level: 2,
            },
          ],
          free_casts: [
            { at_will: true, spells: ["magic-missile"] },
            { uses: "focus", spells: ["darkness"], line: true },
          ],
          spell_ranges: [
            { name: "Test Reach", feet: 60, attack_roll: true, min_feet: 10 },
            {
              name: "Test Spear",
              per_class_level: { class: "wizard", feet: 30 },
              spell: "fire-bolt",
            },
          ],
          initiative_regain: [{ uses: "spark", to: 2 }],
          actions: [
            {
              id: "peer",
              name: "Test Peerless",
              economy: "free",
              uses: "verve",
              roll: { dice: "1d10" },
              after_failed_roll: { kinds: ["check", "attack"], spend: "on_success" },
            },
          ],
          slot_refund: { name: "Test Recall", die: "1d4", max_level: 4 },
          toggles: [
            {
              id: "blade",
              name: "Test Blade",
              grants: { effects: [{ target: "attack.melee_weapon", value: 2 }] },
            },
          ],
        },
      },
    },
  ],
};
const cat: Catalog = createCatalog([srdPack, pack], {});

/** Wizard 6 with the test subclass (INT 17). */
function mage(level = 6): CharacterBuild {
  let b = autocomplete(
    classBuild("wizard", { background: "sage", bonus: { int: 2, wis: 1 } }),
    cat,
  );
  b = levelUpIn(b, "wizard", 2, null, cat);
  b = builder.setChoice(b, cat, "class:wizard:3#subclass", ["test-ranger-mage"]).build;
  return levelUpIn(autocomplete(b, cat), "wizard", level - 3, null, cat);
}
function cast(
  b: CharacterBuild,
  s: CharacterState,
  what: Omit<Extract<RollWhat, { type: "cast" }>, "type">,
) {
  const r = rollByHand(
    combatantFromCharacter(b, s, cat),
    { type: "cast", ...what },
    { catalog: cat, character: { build: b, state: s }, rng: fixedRng(10) },
  );
  let state = s;
  for (const c of r.costs)
    if (c.type === "play") state = applyAction(b, state, cat, c.action).state;
  return { state, roll: r };
}
const slots = (s: CharacterState) => s.spell_slots_spent.reduce((a, n) => a + n, 0);
const line = (b: CharacterBuild, s: CharacterState, id: string) =>
  computePlaySheet(b, s, cat).spells.find((x) => x.id === id);

describe("C14: encounters written before an optional field read back unchanged", () => {
  it("no `used_until_turn` added by parsing; a fresh encounter has none", () => {
    const e = createEncounter({ name: "x" } as never) as unknown as Record<string, unknown>;
    const back = parseEncounter(JSON.parse(JSON.stringify(e)));
    expect(JSON.stringify(back)).toBe(JSON.stringify(e));
    for (const c of (back.combatants ?? []) as Record<string, unknown>[])
      expect("used_until_turn" in c).toBe(false);
  });
});

describe("D011: an at-will free cast (Spell Mastery-like)", () => {
  const b = mage();
  const s0 = createState(b, cat);
  it("offered on the line, at its own level, nothing spent; again and again", () => {
    const free = line(b, s0, "magic-missile")?.free.find((f) => f.at_will);
    expect(free).toMatchObject({ at_will: true, available: true });
    let { state } = cast(b, s0, {
      spell: "magic-missile",
      payment: { type: "free", use: free?.use as string },
    });
    ({ state } = cast(b, state, {
      spell: "magic-missile",
      payment: { type: "free", use: free?.use as string },
    }));
    expect(slots(state)).toBe(0);
    expect(state.uses_spent).toEqual(s0.uses_spent);
  });
  it("not higher than its level without a slot; a slot upcasts and is spent", () => {
    const use = line(b, s0, "magic-missile")?.free.find((f) => f.at_will)?.use as string;
    expect(() =>
      cast(b, s0, { spell: "magic-missile", slot_level: 2, payment: { type: "free", use } }),
    ).toThrow(/level/);
    expect(slots(cast(b, s0, { spell: "magic-missile", slot_level: 2 }).state)).toBe(1);
  });
});

describe("D026: a free cast with `line` (Shadow Arts-like Darkness)", () => {
  const b = mage();
  const s0 = createState(b, cat);
  it("the spell is on the sheet, without slots; its free cast spends the use; a slot is refused", () => {
    const l = line(b, s0, "darkness");
    expect(l?.slots).toEqual([]);
    expect(l?.grants.every((g) => g.free_only)).toBe(true);
    const use = l?.free[0]?.use as string;
    const { state } = cast(b, s0, { spell: "darkness", payment: { type: "free", use } });
    expect(state.uses_spent[use]).toBe(1);
    expect(slots(state)).toBe(0);
    expect(() => cast(b, s0, { spell: "darkness", slot_level: 2 })).toThrow(/only through/);
    // Exhausted: both uses spent, the next one refused.
    const twice = cast(b, state, { spell: "darkness", payment: { type: "free", use } }).state;
    expect(() => cast(b, twice, { spell: "darkness", payment: { type: "free", use } })).toThrow();
  });
});

describe("D012: spell ranges", () => {
  it("Fire Bolt 120 + 60 (attack roll) + 30 × Wizard 6 = 360; Shield (Self) unchanged; Distant doubles the result", () => {
    const b = mage();
    const s0 = createState(b, cat);
    expect(line(b, s0, "fire-bolt")).toMatchObject({
      range: "360 feet",
      range_from: ["Test Reach", "Test Spear"],
    });
    expect(line(b, s0, "shield")?.range).toBeUndefined();
    // Magic Missile has no attack roll: only Test Spear would apply, and it names Fire Bolt only.
    expect(line(b, s0, "magic-missile")?.range).toBeUndefined();
    const w7 = mage(7);
    expect(line(w7, createState(w7, cat), "fire-bolt")?.range).toBe("390 feet");
  });
});

describe("D015: attack.melee_weapon applies to melee weapons only", () => {
  it("a dagger gains +2, a light crossbow doesn't", () => {
    const b = mage();
    let s = createState(b, cat);
    for (const item of ["dagger", "light-crossbow"])
      s = applyAction(b, s, cat, { type: "add_item", item }).state;
    for (const i of s.inventory)
      s = applyAction(b, s, cat, { type: "equip", id: i.id, equipped: true }).state;
    const hit = (st: CharacterState, name: string) =>
      computePlaySheet(b, st, cat).attacks.find((a) => a.name === name)?.attack_bonus;
    const d0 = hit(s, "Dagger");
    const c0 = hit(s, "Light Crossbow");
    const on = applyAction(b, s, cat, { type: "activate", key: "wizard:blade" }).state;
    expect(hit(on, "Dagger")).toBe((d0 as number) + 2);
    expect(hit(on, "Light Crossbow")).toBe(c0);
  });
});

describe("D018 / D016: Ward-like pool triggers", () => {
  const b = mage();
  const W = "wizard:ward";
  const created = cast(b, createState(b, cat), {
    spell: "shield",
    slot_level: 1,
    triggers: [{ key: W, mode: "create" }],
  }).state;
  it("D018: at its maximum a restore cast is still legal: the slot spent, the pool unchanged, a note", () => {
    const { state, roll } = cast(b, created, {
      spell: "counterspell",
      slot_level: 3,
      triggers: [{ key: W, mode: "restore" }],
    });
    expect(slots(state)).toBe(slots(created) + 1);
    expect(state.pools?.[W]).toBe(5);
    expect(roll.costs.some((c) => c.type === "play" && c.action.type === "cast_trigger")).toBe(
      true,
    );
  });
  it("D016: an encounter cast creates it with its slot; a cantrip with a trigger is refused", () => {
    const nb = builder.setName(b, cat, "Me").build;
    const characters: Record<string, { build: CharacterBuild; state: CharacterState }> = {
      me: { build: nb, state: createState(nb, cat) },
    };
    let e: Encounter = createEncounter();
    const ctx = () => ({ catalog: cat, characters, rng: fixedRng(10) });
    const act = (a: Parameters<typeof applyEncounterAction>[1]) => {
      const r = applyEncounterAction(e, a, ctx());
      e = r.encounter;
      for (const [id, st] of Object.entries(r.states))
        characters[id] = { ...characters[id]!, state: st };
    };
    act({ type: "add_character", character: "me" });
    act({ type: "add_monster", monster: "goblin-warrior" });
    act({ type: "set_initiative", id: "me", value: 20 });
    act({ type: "set_initiative", id: "goblin-warrior", value: 1 });
    act({ type: "start" });
    const before = e;
    expect(() =>
      applyEncounterAction(
        before,
        {
          type: "cast",
          id: "me",
          spell: "fire-bolt",
          targets: ["goblin-warrior"],
          triggers: [{ key: W, mode: "create" }],
        } as never,
        ctx(),
      ),
    ).toThrow(/spell slot/);
    act({
      type: "cast",
      id: "me",
      spell: "shield",
      slot_level: 1,
      triggers: [{ key: W, mode: "create" }],
    } as never);
    expect(characters.me?.state.pools?.[W]).toBe(5);
    expect(slots(characters.me?.state as CharacterState)).toBe(1);
  });
});

describe("D029: a tool's listed price", () => {
  it("a Lute (35 GP, 2 lb.) is bought for 35 GP once; without the coins refused, nothing changed", () => {
    const b = mage();
    let s = createState(b, cat);
    s = applyAction(b, s, cat, { type: "adjust_currency", changes: { gp: 40 } }).state;
    const gp0 = s.currency.gp;
    const bought = applyAction(b, s, cat, { type: "buy", item: "lute" }).state;
    expect(bought.currency.gp).toBe(gp0 - 35);
    expect(bought.inventory.filter((i) => i.item === "lute").length).toBe(1);
    expect(() =>
      applyAction(b, { ...bought, currency: { cp: 0, sp: 0, ep: 0, gp: 1, pp: 0 } }, cat, {
        type: "buy",
        item: "lute",
      }),
    ).toThrow(/coins/);
  });
});

describe("D017: Spell Recall-like slot refund and Superior Inspiration-like Initiative regain", () => {
  const b = mage();
  const s0 = createState(b, cat);
  const castWith = (rng: ReturnType<typeof scriptedRng>, slot: number) => {
    const r = rollByHand(
      combatantFromCharacter(b, s0, cat),
      { type: "cast", spell: "shield", slot_level: slot },
      { catalog: cat, character: { build: b, state: s0 }, rng },
    );
    let st = s0;
    for (const c of r.costs) if (c.type === "play") st = applyAction(b, st, cat, c.action).state;
    return { st, r };
  };
  it("the d4 equal to the slot's level keeps it; otherwise spent; stated either way", () => {
    const kept = castWith(scriptedRng([1]), 1);
    expect(slots(kept.st)).toBe(0);
    expect(kept.r.messages.some((m) => m.code === "cast.slot_kept")).toBe(true);
    const spent = castWith(scriptedRng([3]), 1);
    expect(slots(spent.st)).toBe(1);
    expect(spent.r.messages.some((m) => m.code === "cast.slot_not_kept")).toBe(true);
  });
  it("rolling Initiative brings the use back to 2 when fewer are left, never above", () => {
    const nb = builder.setName(b, cat, "Me").build;
    let st = createState(nb, cat);
    st = applyAction(nb, st, cat, { type: "use", key: "wizard:spark", amount: 3 }).state;
    const characters: Record<string, { build: CharacterBuild; state: CharacterState }> = {
      me: { build: nb, state: st },
    };
    let e: Encounter = createEncounter();
    const ctx = () => ({ catalog: cat, characters, rng: fixedRng(10) });
    const act = (a: Parameters<typeof applyEncounterAction>[1]) => {
      const r = applyEncounterAction(e, a, ctx());
      e = r.encounter;
      for (const [id, x] of Object.entries(r.states))
        characters[id] = { ...characters[id]!, state: x };
      return r;
    };
    act({ type: "add_character", character: "me" });
    const r = act({ type: "roll_initiative", ids: ["me"] });
    expect(characters.me?.state.uses_spent["wizard:spark"]).toBe(1);
    expect(r.messages.some((m) => m.code === "initiative.regained")).toBe(true);
    // Already 2 left: nothing more.
    act({ type: "set_initiative", id: "me", value: 5 });
    act({ type: "roll_initiative", ids: ["me"] });
    expect(characters.me?.state.uses_spent["wizard:spark"]).toBe(1);
  });
});

describe("R14-02/R14-03: encounter casts — free/at-will payment and the character's own range", () => {
  const W = mage();
  function fight(build: CharacterBuild, state?: CharacterState, gap = 40) {
    const nb = builder.setName(build, cat, "Me").build;
    const characters: Record<string, { build: CharacterBuild; state: CharacterState }> = {
      me: { build: nb, state: state ?? createState(nb, cat) },
    };
    let e: Encounter = createEncounter();
    const ctx = () => ({ catalog: cat, characters, rng: fixedRng(1) });
    const act = (a: Parameters<typeof applyEncounterAction>[1]) => {
      const r = applyEncounterAction(e, a, ctx());
      e = r.encounter;
      for (const [id, x] of Object.entries(r.states))
        characters[id] = { ...characters[id]!, state: x };
      return r;
    };
    act({ type: "add_character", character: "me" });
    act({ type: "add_monster", monster: "ogre" });
    act({ type: "place", id: "me", x: 0, y: 0 });
    act({ type: "place", id: "ogre", x: gap, y: 0 });
    act({ type: "set_initiative", id: "me", value: 20 });
    act({ type: "set_initiative", id: "ogre", value: 1 });
    act({ type: "start" });
    return { act, me: () => characters.me!.state, enc: () => e, ctx };
  }
  it("Fire Bolt at 200 ft: inside its 360 ft (Test Reach + Test Spear), cast; at 400 ft refused, nothing changed", () => {
    const f = fight(W, undefined, 40);
    expect(() =>
      f.act({ type: "cast", id: "me", spell: "fire-bolt", targets: ["ogre"] }),
    ).not.toThrow();
    const far = fight(W, undefined, 80);
    const before = JSON.stringify(far.me());
    expect(() =>
      far.act({ type: "cast", id: "me", spell: "fire-bolt", targets: ["ogre"] }),
    ).toThrow(/out of Fire Bolt's range \(360 feet\)/);
    expect(JSON.stringify(far.me())).toBe(before);
  });
  it("another wizard without the range features: 200 ft is out of its 120 ft (no global change)", () => {
    let b = autocomplete(
      classBuild("wizard", { background: "sage", bonus: { int: 2, wis: 1 } }),
      cat,
    );
    b = levelUpIn(b, "wizard", 5, null, cat);
    const f = fight(b, undefined, 40);
    expect(() => f.act({ type: "cast", id: "me", spell: "fire-bolt", targets: ["ogre"] })).toThrow(
      /\(120 feet\)/,
    );
  });
  it("at will in an encounter: no slot spent twice; upcast or a trigger with the free payment refused", () => {
    const use = line(W, createState(W, cat), "magic-missile")?.free.find((x) => x.at_will)
      ?.use as string;
    const f = fight(W, undefined, 4);
    f.act({
      type: "cast",
      id: "me",
      spell: "magic-missile",
      targets: ["ogre"],
      payment: { type: "free", use },
    } as never);
    expect(slots(f.me())).toBe(0);
    f.act({ type: "next_turn" });
    f.act({ type: "next_turn" });
    f.act({
      type: "cast",
      id: "me",
      spell: "magic-missile",
      targets: ["ogre"],
      payment: { type: "free", use },
    } as never);
    expect(slots(f.me())).toBe(0);
    const g = fight(W, undefined, 4);
    expect(() =>
      g.act({
        type: "cast",
        id: "me",
        spell: "magic-missile",
        targets: ["ogre"],
        slot_level: 2,
        payment: { type: "free", use },
      } as never),
    ).toThrow(/level/);
    expect(() =>
      g.act({ type: "cast", id: "me", spell: "shield", payment: { type: "free", use } } as never),
    ).toThrow();
    expect(slots(g.me())).toBe(0);
  });
  it("a free-only spell (Darkness for Test Focus): its use once per cast, Concentration, no slot; exhausted refused; without payment refused", () => {
    const use = line(W, createState(W, cat), "darkness")?.free[0]?.use as string;
    const f = fight(W, undefined, 4);
    expect(() =>
      f.act({ type: "cast", id: "me", spell: "darkness", targets: [] } as never),
    ).toThrow(/only through/);
    f.act({
      type: "cast",
      id: "me",
      spell: "darkness",
      targets: [],
      payment: { type: "free", use },
    } as never);
    expect(f.me().uses_spent[use]).toBe(1);
    expect(f.me().concentration).toBe("Darkness");
    expect(slots(f.me())).toBe(0);
    const spent = { ...createState(W, cat), uses_spent: { [use]: 2 } };
    const g = fight(W, spent, 4);
    expect(() =>
      g.act({
        type: "cast",
        id: "me",
        spell: "darkness",
        targets: [],
        payment: { type: "free", use },
      } as never),
    ).toThrow();
    expect(g.me().uses_spent[use]).toBe(2);
  });
});

describe("R14-01: a feature used on the failed roll itself (Peerless Skill-like)", () => {
  const b = mage();
  const s0 = createState(b, cat);
  const KEY = "wizard:peer";
  const check = (d20: number, dc?: number) =>
    rollCheck(b, s0, cat, { skill: "arcana" }, {
      rng: scriptedRng([d20]),
      ...(dc !== undefined ? { dc } : {}),
    } as never);
  it("a failed check that succeeds with the die: the die on the roll, its total and success, one use spent", () => {
    const failed = check(2, 15);
    expect(failed.success).toBe(false);
    const r = useAfterFailedRoll(b, s0, cat, failed, KEY, { rng: scriptedRng([10]) });
    expect(r.roll.bonus_dice.at(-1)).toMatchObject({ label: "Test Peerless", total: 10 });
    expect(r.roll.total).toBe(failed.total + 10);
    expect(r.success).toBe(true);
    expect(r.spent).toBe(true);
    expect(r.state.uses_spent[KEY.replace("peer", "verve")]).toBe(1);
  });
  it("still a failure: the die shown, nothing spent", () => {
    const failed = check(2, 25);
    const r = useAfterFailedRoll(b, s0, cat, failed, KEY, { rng: scriptedRng([1]) });
    expect(r.success).toBe(false);
    expect(r.spent).toBe(false);
    expect(r.state).toEqual(s0);
    expect(r.messages[0]?.code).toBe("after_roll.still_fails");
  });
  it("no DC known: refused until the table states it; then decided against it", () => {
    const noDc = check(2);
    expect(() => useAfterFailedRoll(b, s0, cat, noDc, KEY, { rng: scriptedRng([10]) })).toThrow(
      /give the DC/,
    );
    expect(
      useAfterFailedRoll(b, s0, cat, noDc, KEY, { dc: 12, rng: scriptedRng([10]) }).success,
    ).toBe(true);
  });
  it("a save, a roll that didn't fail, and no use left are refused, nothing changed", () => {
    const save = rollCheck(b, s0, cat, { save: "wis" }, { rng: scriptedRng([2]), dc: 15 } as never);
    expect(() => useAfterFailedRoll(b, s0, cat, save, KEY, { rng: scriptedRng([10]) })).toThrow(
      /ability check or attack/,
    );
    expect(() =>
      useAfterFailedRoll(b, s0, cat, check(20, 10), KEY, { rng: scriptedRng([10]) }),
    ).toThrow(/didn't fail/);
    const none = applyAction(b, s0, cat, { type: "use", key: "wizard:verve" }).state;
    expect(() =>
      useAfterFailedRoll(b, none, cat, check(2, 15), KEY, { rng: scriptedRng([10]) }),
    ).toThrow(/No uses/);
  });
  it("an attack roll by hand against the AC the table states", () => {
    const r = rollByHand(
      combatantFromCharacter(b, s0, cat),
      { type: "attack", attack: "Unarmed Strike" } as never,
      { catalog: cat, character: { build: b, state: s0 }, rng: scriptedRng([3, 1, 1, 1]) },
    );
    const a = r.rolls.attacks[0]!;
    const ok = useAfterFailedRoll(b, s0, cat, a, KEY, { dc: a.total + 2, rng: scriptedRng([5]) });
    expect(ok.success).toBe(true);
    expect(ok.spent).toBe(true);
  });
});

describe("R14-04: a pack's automation for features the character already has (gated, no definition changed)", () => {
  const auto = {
    manifest: {
      id: "test-auto",
      version: "1.0.0",
      source: "test-auto",
      requires: ["srd-5.2.1", "test-t12"],
    },
    automation: [
      {
        id: "t-late",
        name: "Test Late Reaction",
        when: { class: "wizard", class_level: 7 },
        grants: {
          actions: [{ id: "late", name: "Test Late Reaction", economy: "reaction", uses: "spark" }],
        },
      },
      {
        id: "t-sub",
        name: "Test Sub Regain",
        when: { subclass: "test-ranger-mage", class_level: 6 },
        grants: { initiative_regain: [{ uses: "verve", to: 1 }] },
      },
      {
        id: "t-feat",
        name: "Test Feat Action",
        when: { feat: "magic-initiate" },
        grants: { actions: [{ id: "featx", name: "Test Feat Action", economy: "free" }] },
      },
    ],
  };
  const cat2: Catalog = createCatalog([srdPack, pack, auto], {});
  const build = (level: number) => {
    let b = autocomplete(
      classBuild("wizard", { background: "sage", bonus: { int: 2, wis: 1 } }),
      cat2,
    );
    b = levelUpIn(b, "wizard", 2, null, cat2);
    b = builder.setChoice(b, cat2, "class:wizard:3#subclass", ["test-ranger-mage"]).build;
    return levelUpIn(autocomplete(b, cat2), "wizard", level - 3, null, cat2);
  };
  const sheetOf = (b: CharacterBuild, c: Catalog) => computePlaySheet(b, createState(b, c), c);
  it("the class gate: the action at Wizard 7, absent at 6; its uses are the class's", () => {
    expect(sheetOf(build(6), cat2).actions.some((a) => a.key === "wizard:late")).toBe(false);
    const at7 = sheetOf(build(7), cat2).actions.find((a) => a.key === "wizard:late");
    expect(at7).toMatchObject({ uses: "wizard:spark", economy: "reaction" });
  });
  it("the subclass gate (with its class level) and the feat gate", () => {
    expect(
      sheetOf(build(5), cat2).initiative_regain.some((r) => r.name === "Test Sub Regain"),
    ).toBe(false);
    expect(sheetOf(build(6), cat2).initiative_regain).toContainEqual({
      use: "wizard:verve",
      to: 1,
      name: "Test Sub Regain",
    });
    expect(sheetOf(build(6), cat2).actions.some((a) => a.key === "automation:t-feat:featx")).toBe(
      true,
    );
  });
  it("the same build without the pack, or with its source filtered out: nothing added, the sheet as before", () => {
    const b = build(7);
    const plain = sheetOf(b, cat);
    expect(plain.actions.some((a) => a.key === "wizard:late")).toBe(false);
    const filtered = createCatalog([srdPack, pack, auto], { sources: ["srd-5.2.1", "test"] });
    expect(sheetOf(b, filtered).actions.some((a) => a.key === "wizard:late")).toBe(false);
  });
  it("an automation can't add a choice or a feat", () => {
    const bad = {
      ...auto,
      manifest: { ...auto.manifest, id: "test-bad" },
      automation: [
        { id: "x", name: "X", when: { class: "wizard" }, grants: { feats: [{ feat: "alert" }] } },
      ],
    };
    expect(() => createCatalog([srdPack, pack, bad], {})).toThrow();
  });
});

describe("R14-05: a redundant pick on a skill grant with nothing left to give", () => {
  const allSkills = {
    manifest: { id: "test-skills", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
    feats: [
      {
        id: "test-every-skill",
        name: "Test Every Skill",
        category: "general",
        description: "Every skill (test).",
        grants: {
          skills: [
            "acrobatics",
            "animal-handling",
            "arcana",
            "athletics",
            "deception",
            "history",
            "insight",
            "intimidation",
            "investigation",
            "medicine",
            "nature",
            "perception",
            "performance",
            "persuasion",
            "religion",
            "sleight-of-hand",
            "stealth",
            "survival",
          ],
        },
      },
    ],
    patches: [
      {
        target: "species/human",
        op: "append",
        path: "grants.feats",
        value: { feat: "test-every-skill" },
      },
    ],
  };
  const catS: Catalog = createCatalog([srdPack, allSkills], {});
  const fighter = () =>
    autocomplete(classBuild("fighter", { background: "soldier", bonus: { str: 2, con: 1 } }), catS);
  it("the Fighter's skill choice has nothing to give: its pick is a note, not an error; still 18 skills", () => {
    const b = fighter();
    const key =
      Object.keys(b.choices).find((k) => k === "class:fighter#skills") ?? "class:fighter#skills";
    const set = builder.setChoice(b, catS, key, ["athletics", "perception"]);
    const v = builder.evaluate(set.build, catS);
    const own = v.resolution.choice(key);
    expect(own && v.resolution.selected(own)).toEqual(["athletics", "perception"]);
    expect(v.report.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(JSON.stringify(v.report.issues)).toContain("issue.redundant_pick");
    expect(v.sheet.skills.filter((s) => s.proficient_from).length).toBe(18);
    expect(v.sheet.skills.filter((s) => s.expertise).length).toBe(0);
  });
  it("without the exhausted grant (the plain SRD), an already-known pick is still refused", () => {
    let b = autocomplete(
      classBuild("fighter", { background: "soldier", bonus: { str: 2, con: 1 } }),
      cat,
    );
    const v0 = builder.evaluate(b, cat);
    const ch0 = v0.resolution.choice("class:fighter#skills");
    const ch = ch0 ? { selected: v0.resolution.selected(ch0) } : undefined;
    const known = v0.sheet.skills.find(
      (s) => s.proficient_from && s.proficient_from !== "Fighter",
    )?.skill;
    expect(ch && known).toBeTruthy();
    expect(() =>
      builder.setChoice(b, cat, "class:fighter#skills", [
        known as string,
        ...(ch?.selected.slice(1) ?? []),
      ]),
    ).toThrow();
    b = builder.setChoice(b, cat, "class:fighter#skills", ch?.selected ?? []).build;
  });
});
