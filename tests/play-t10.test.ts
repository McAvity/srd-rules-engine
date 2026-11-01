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
  type RollWhat,
  rollByHand,
} from "../src/index";
import { speedOf } from "../src/services/encounter";
import { srdPack } from "../src/srd";
import { autocomplete, classBuild, fighterBuild, levelUpIn } from "./helpers";

// kenli F-002 T10: play hooks of the 2024 plans, with invented test content only.
// - H2 (Arcane Ward-like): a `tracked` pool (current kept, absent until created, ended by a Long
//   Rest), created/restored by a `cast_triggers` entry on a slotted cast of its school, restored by a
//   Bonus Action with a slot (`restores_per_slot_level`), spent by a reaction (`pool`).
// - H3 (Wild Shape-like): a feature action's `temp_hp` per class level.
// - D001 (Halt after Dash) on the SRD rules; D002 (Savage Attacker kept-first) in explicit-rules.test.ts.
const pack = {
  manifest: { id: "test-t10", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
  subclasses: [
    {
      id: "test-warder",
      name: "Test Warder",
      class: "wizard",
      features: {
        "3": {
          spells: ["shield", "counterspell", "alarm", "magic-missile"],
          resources: [
            {
              id: "ward",
              name: "Test Ward",
              max: { per_class_level: 2, plus_ability: "int" },
              recharge: "long",
              tracked: true,
            },
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
          actions: [
            {
              id: "ward-restore",
              name: "Test Ward: restore",
              economy: "bonus_action",
              restores: "ward",
              restores_per_slot_level: 2,
              slot_payment: "required",
            },
          ],
        },
        "6": {
          actions: [
            {
              id: "ward-project",
              name: "Test Ward: project",
              economy: "reaction",
              uses: "ward",
              pool: true,
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
      path: "features.2.actions",
      value: {
        id: "shape",
        name: "Test Shape",
        economy: "bonus_action",
        uses: "wild-shape",
        temp_hp: { per_class_level: 1 },
      },
    },
  ],
};
const cat: Catalog = createCatalog([srdPack, pack], {});

/** Wizard 6 (INT 17: +3), Test Warder at 3: the pool's maximum is 2 × 6 + 3 = 15. */
function warder(level = 6): CharacterBuild {
  let b = autocomplete(
    classBuild("wizard", { background: "sage", bonus: { int: 2, wis: 1 } }),
    cat,
  );
  b = levelUpIn(b, "wizard", 2, null, cat);
  b = builder.setChoice(b, cat, "class:wizard:3#subclass", ["test-warder"]).build;
  return levelUpIn(autocomplete(b, cat), "wizard", level - 3, null, cat);
}
const KEY = "wizard:ward";
const pool = (b: CharacterBuild, s: CharacterState) =>
  computePlaySheet(b, s, cat).play.uses.find((u) => u.key === KEY);
/** A cast by hand, its costs paid in order (the Table's sheet path): the state after, or the refusal. */
function cast(
  b: CharacterBuild,
  s: CharacterState,
  what: Omit<Extract<RollWhat, { type: "cast" }>, "type">,
) {
  const r = rollByHand(
    combatantFromCharacter(b, s, cat),
    { type: "cast", ...what },
    {
      catalog: cat,
      character: { build: b, state: s },
      rng: fixedRng(10),
    },
  );
  let state = s;
  for (const c of r.costs)
    if (c.type === "play") state = applyAction(b, state, cat, c.action).state;
  return state;
}
const slotsSpent = (s: CharacterState) => s.spell_slots_spent.reduce((a, n) => a + n, 0);

describe("H2: a tracked pool created and restored by casting (Arcane Ward)", () => {
  const b = warder();
  const fresh = createState(b, cat);

  it("W1: after a Long Rest it isn't there; its maximum shows (2 × level + INT)", () => {
    const s = applyAction(b, fresh, cat, { type: "long_rest" }).state;
    expect(pool(b, s)).toMatchObject({ tracked: true, created: false, current: 0, max: 15 });
    expect(s.pools).toBeUndefined();
  });

  it("W2: a ritual (no slot) neither creates nor restores it, and costs nothing", () => {
    expect(() =>
      cast(b, fresh, {
        spell: "alarm",
        payment: { type: "ritual" },
        triggers: [{ key: KEY, mode: "create" }],
      }),
    ).toThrow(/needs a abjuration spell cast with a spell slot/);
    expect(pool(b, fresh)?.created).toBe(false);
  });

  it("W3: a slotted Abjuration cast creates it at its maximum, once until a Long Rest", () => {
    const s = cast(b, fresh, {
      spell: "shield",
      slot_level: 1,
      triggers: [{ key: KEY, mode: "create" }],
    });
    expect(pool(b, s)).toMatchObject({ created: true, current: 15 });
    expect(slotsSpent(s)).toBe(1);
    expect(() =>
      cast(b, s, { spell: "shield", slot_level: 1, triggers: [{ key: KEY, mode: "create" }] }),
    ).toThrow(/already created/);
    // An Evocation spell can't create it.
    expect(() =>
      cast(b, fresh, {
        spell: "magic-missile",
        slot_level: 1,
        triggers: [{ key: KEY, mode: "create" }],
      }),
    ).toThrow(/needs a abjuration spell/);
  });

  it("W4–W7: absorb (use amount), restore by an upcast slot (+2 per slot level, capped), 0 still restorable", () => {
    let s = cast(b, fresh, {
      spell: "shield",
      slot_level: 1,
      triggers: [{ key: KEY, mode: "create" }],
    });
    s = applyAction(b, s, cat, { type: "use", key: KEY, amount: 15 }).state; // absorbed 15: 0 left
    expect(pool(b, s)).toMatchObject({ created: true, current: 0 });
    expect(() => applyAction(b, s, cat, { type: "use", key: KEY, amount: 1 })).toThrow(
      /has 0 left/,
    );
    s = cast(b, s, {
      spell: "counterspell",
      slot_level: 3,
      triggers: [{ key: KEY, mode: "restore" }],
    });
    expect(pool(b, s)?.current).toBe(6);
    s = cast(b, s, {
      spell: "counterspell",
      slot_level: 3,
      triggers: [{ key: KEY, mode: "restore" }],
    });
    s = cast(b, s, {
      spell: "counterspell",
      slot_level: 3,
      triggers: [{ key: KEY, mode: "restore" }],
    });
    expect(pool(b, s)?.current).toBe(15); // 6 + 6 + 3 (capped)
    expect(() =>
      cast(b, s, { spell: "shield", slot_level: 1, triggers: [{ key: KEY, mode: "restore" }] }),
    ).toThrow(/is full/);
  });

  it("W5: Bonus Action + a slot restores 2 × the slot's level, paid once; no slot → refused, nothing spent", () => {
    let s = cast(b, fresh, {
      spell: "shield",
      slot_level: 1,
      triggers: [{ key: KEY, mode: "create" }],
    });
    s = applyAction(b, s, cat, { type: "use", key: KEY, amount: 10 }).state;
    const before = slotsSpent(s);
    s = applyAction(b, s, cat, {
      type: "use_feature",
      key: "wizard:ward-restore",
      payment: { type: "slot", level: 2 },
    }).state;
    expect(pool(b, s)?.current).toBe(9);
    expect(slotsSpent(s)).toBe(before + 1);
    expect(() =>
      applyAction(b, s, cat, { type: "use_feature", key: "wizard:ward-restore" }),
    ).toThrow(/needs a spell slot/);
    const empty = { ...s, spell_slots_spent: [4, 3, 3] };
    expect(() =>
      applyAction(b, empty, cat, {
        type: "use_feature",
        key: "wizard:ward-restore",
        payment: { type: "slot", level: 2 },
      }),
    ).toThrow(/level 2 spell slots|no level 2/i);
    // Not created: refused, no slot spent.
    expect(() =>
      applyAction(b, fresh, cat, {
        type: "use_feature",
        key: "wizard:ward-restore",
        payment: { type: "slot", level: 1 },
      }),
    ).toThrow(/isn't there/);
  });

  it("W8: a Long Rest ends it (not refilled); it can be created again", () => {
    let s = cast(b, fresh, {
      spell: "shield",
      slot_level: 1,
      triggers: [{ key: KEY, mode: "create" }],
    });
    s = applyAction(b, s, cat, { type: "use", key: KEY, amount: 4 }).state;
    s = applyAction(b, s, cat, { type: "long_rest" }).state;
    expect(pool(b, s)).toMatchObject({ created: false, current: 0 });
    s = cast(b, s, { spell: "shield", slot_level: 1, triggers: [{ key: KEY, mode: "create" }] });
    expect(pool(b, s)?.current).toBe(15);
  });

  it("W9: a level-up raises the maximum and leaves the current value as it is", () => {
    let s = cast(b, fresh, {
      spell: "shield",
      slot_level: 1,
      triggers: [{ key: KEY, mode: "create" }],
    });
    s = applyAction(b, s, cat, { type: "use", key: KEY, amount: 5 }).state; // 10 of 15
    const up = levelUpIn(b, "wizard", 1, null, cat);
    expect(pool(up, s)).toMatchObject({ created: true, current: 10, max: 17 });
  });

  it("W10: the reaction spends from the pool once (an amount), refused beyond what's left", () => {
    let s = cast(b, fresh, {
      spell: "shield",
      slot_level: 1,
      triggers: [{ key: KEY, mode: "create" }],
    });
    s = applyAction(b, s, cat, {
      type: "use_feature",
      key: "wizard:ward-project",
      amount: 7,
    }).state;
    expect(pool(b, s)?.current).toBe(8);
    expect(() =>
      applyAction(b, s, cat, { type: "use_feature", key: "wizard:ward-project", amount: 9 }),
    ).toThrow(/has 8 left/);
    // Below 6 the reaction isn't there.
    const five = warder(5);
    expect(
      computePlaySheet(five, createState(five, cat), cat).actions.some(
        (a) => a.key === "wizard:ward-project",
      ),
    ).toBe(false);
  });

  it("an older state without pools keeps its bytes; reconcile drops a pool the sheet no longer has", () => {
    const s = createState(b, cat);
    expect("pools" in s).toBe(false);
  });
});

describe("H3: a feature's Temporary Hit Points (Wild Shape)", () => {
  it("one use spent, THP = class level, higher ones kept; no use left → refused", () => {
    const d = levelUpIn(autocomplete(classBuild("druid"), cat), "druid", 3, null, cat);
    let s = createState(d, cat);
    s = applyAction(d, s, cat, { type: "use_feature", key: "druid:shape" }).state;
    expect(s.hp.temp).toBe(4);
    expect(s.uses_spent["druid:wild-shape"]).toBe(1);
    s = applyAction(d, { ...s, hp: { ...s.hp, temp: 9 } }, cat, {
      type: "use_feature",
      key: "druid:shape",
    }).state;
    expect(s.hp.temp).toBe(9);
    const out = { ...s, uses_spent: { "druid:wild-shape": 2 } };
    expect(() => applyAction(d, out, cat, { type: "use_feature", key: "druid:shape" })).toThrow(
      /left/,
    );
  });
});

describe("D001: Halt (Speed 0) after a Dash", () => {
  it("no movement left, whatever the Dash added", () => {
    const halt = createCatalog(
      [
        srdPack,
        {
          manifest: { id: "t-halt", source: "test", requires: ["srd-5.2.1"] },
          feats: [
            { id: "t-halt", name: "Test Halt", category: "origin", grants: { rules: ["halt"] } },
          ],
        },
      ],
      {},
    );
    let build = fighterBuild();
    build = {
      ...build,
      choices: Object.fromEntries(
        Object.entries(build.choices).filter(([k]) => !k.startsWith("feat:skilled@")),
      ),
    };
    build = builder.setChoice(build, halt, "species:human#versatile", ["t-halt"]).build;
    build = builder.setName(build, halt, "A").build;
    const characters: Record<string, { build: CharacterBuild; state: CharacterState }> = {
      a: { build, state: createState(build, halt) },
    };
    let e: Encounter = createEncounter();
    const ctx = () => ({ catalog: halt, characters, rng: fixedRng(15) });
    const act = (a: EncounterAction) => {
      const r = applyEncounterAction(e, a, ctx());
      e = r.encounter;
      for (const [id, st] of Object.entries(r.states))
        characters[id] = { ...characters[id]!, state: st };
    };
    act({ type: "add_character", character: "a" });
    act({ type: "add_monster", monster: "ogre" });
    act({ type: "place", id: "a", x: 0, y: 0 });
    act({ type: "place", id: "ogre", x: 1, y: 0 });
    act({ type: "set_initiative", id: "ogre", value: 20 });
    act({ type: "set_initiative", id: "a", value: 10 });
    act({ type: "start" });
    act({ type: "dash", id: "ogre" });
    // Before the hit, the Dash gives it twice its Speed.
    expect(() =>
      applyEncounterAction(e, { type: "move", id: "ogre", feet: 45 }, ctx()),
    ).not.toThrow();
    act({ type: "attack", id: "a", target: "ogre", attack: "Greatsword", opportunity: true });
    const ogre = () => e.combatants.find((x) => x.id === "ogre")!;
    expect(speedOf(ctx(), ogre(), e)).toBe(0);
    expect(() => act({ type: "move", id: "ogre", feet: 5 })).toThrow();
    expect(ogre().moved).toBe(0);
  });
});

describe("optional grant lists merged at a class's first level (mergeGrants)", () => {
  it("a class patch adding cast_triggers to features.1 resolves (the list absent from its core grants)", () => {
    const c = createCatalog(
      [
        srdPack,
        {
          manifest: { id: "t-merge", source: "test", requires: ["srd-5.2.1"] },
          patches: [
            {
              target: "classes/wizard",
              op: "set",
              path: "features.1.cast_triggers",
              value: [{ id: "x", name: "X", school: "abjuration", resource: "x" }],
            },
          ],
        },
      ],
      {},
    );
    const b = autocomplete(classBuild("wizard"), c);
    expect(computePlaySheet(b, createState(b, c), c).cast_triggers.map((t) => t.key)).toEqual([
      "wizard:x",
    ]);
  });
});
