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
  scriptedRng,
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
