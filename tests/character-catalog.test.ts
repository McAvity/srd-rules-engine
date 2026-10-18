import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  type Catalog,
  type CharacterBuild,
  type CharacterRef,
  type CharacterState,
  type ContentPack,
  catalogOf,
  checkAction,
  combatantOptions,
  computePlaySheet,
  createCatalog,
  createEncounter,
  createHistory,
  createState,
  type Encounter,
  type EncounterAction,
  recordAction,
  replayHistory,
  resolve,
  scriptedRng,
} from "../src/index";
import * as svc from "../src/services/builder";
import { srdPack } from "../src/srd";
import { classBuild } from "./helpers";

// Two versions of one invented pack (`source: test`): the spell, a patch to humans and a monster
// differ, so which catalog judged a step shows in the numbers. v1: a cantrip, 1d4 fire, humans
// resist fire, a 30 HP dummy. v2: a 1st-level spell, 2d4 fire, no resistance, a 40 HP dummy.
function testPack(v: 1 | 2): ContentPack {
  return {
    name: "test-versions",
    manifest: { id: "test-versions", version: `${v}.0.0`, source: "test", requires: ["srd-5.2.1"] },
    spells: [
      {
        id: "test-spark",
        name: "Test Spark",
        description: "An invented test spell.",
        level: v === 1 ? 0 : 1,
        school: "evocation",
        lists: ["wizard"],
        casting_time: "Action",
        range: "120 feet",
        components: "V, S",
        duration: "Instantaneous",
        mechanics: {
          attack: "ranged",
          damage: [{ dice: v === 1 ? "1d4" : "2d4", type: "fire" }],
          targets: 1,
          cantrip_scaling: v === 1 ? "dice" : null,
        },
      },
    ],
    monsters: [
      {
        id: "test-dummy",
        name: "Test Dummy",
        size: "Medium",
        creature_type: "Construct",
        alignment: "Unaligned",
        armor_class: 5,
        initiative: 0,
        hit_points: v === 1 ? 30 : 40,
        hit_dice: "4d8+12",
        speed: { walk: 0 },
        abilities: { str: 10, dex: 10, con: 10, int: 1, wis: 10, cha: 1 },
        saving_throws: { str: 0, dex: 0, con: 0, int: -5, wis: 0, cha: -5 },
        cr: "0",
        xp: 0,
        proficiency_bonus: 2,
        passive_perception: 10,
      },
    ],
    patches:
      v === 1
        ? [{ target: "species/human", op: "append", path: "grants.resistances", value: "fire" }]
        : [],
  };
}

const v1: Catalog = createCatalog(srdPack, testPack(1));
const v2: Catalog = createCatalog(srdPack, testPack(2));

/** A level 1 Human Wizard who knows Test Spark in its version (a cantrip in v1, prepared in v2). */
function wizard(cat: Catalog, name: string): CharacterBuild {
  let b = classBuild("wizard", { background: "sage", name });
  for (let i = 0; i < 200; i++) {
    const res = resolve(b, cat);
    const open = res.choices.find(
      (c) => c.fixed === null && res.selected(c).length < res.required(c),
    );
    if (!open) return b;
    const current = res.selected(open);
    const free = res.options(open).filter((o) => !o.unavailable && !current.includes(o.id));
    free.sort((a, x) => (a.id === "test-spark" ? -1 : x.id === "test-spark" ? 1 : 0));
    const next = free[0];
    if (!next) throw new Error(`no option for ${open.key}`);
    b = svc.setChoice(b, cat, open.key, [...current, next.id]).build;
  }
  throw new Error("choices didn't settle");
}

const wrenBuild = wizard(v1, "Wren");
const sableBuild = wizard(v2, "Sable");

/** The world is v1; Wren is on v1, Sable on v2; with `own`, each character carries its catalog. */
function duel(own: boolean) {
  const characters: Record<string, CharacterRef> = {
    wren: { build: wrenBuild, state: createState(wrenBuild, v1), ...(own ? { catalog: v1 } : {}) },
    sable: {
      build: sableBuild,
      state: createState(sableBuild, v2),
      ...(own ? { catalog: v2 } : {}),
    },
  };
  let encounter: Encounter = createEncounter();
  const run = (action: EncounterAction, dice: number[] = []) => {
    const r = applyEncounterAction(encounter, action, {
      catalog: v1,
      characters,
      rng: scriptedRng(dice),
    });
    encounter = r.encounter;
    // A caller carries the whole reference forward, its catalog included.
    for (const [k, state] of Object.entries(r.states)) {
      characters[k] = { ...(characters[k] as CharacterRef), state };
    }
    return r;
  };
  for (const a of [
    { type: "add_character", character: "wren", side: "a" },
    { type: "add_character", character: "sable", side: "b" },
    { type: "add_monster", monster: "test-dummy", side: "b" },
    { type: "set_initiative", id: "wren", value: 20 },
    { type: "set_initiative", id: "sable", value: 15 },
    { type: "set_initiative", id: "test-dummy", value: 1 },
    { type: "start" },
  ] as EncounterAction[])
    run(a);
  const hp = (k: string) =>
    computePlaySheet(
      (characters[k] as CharacterRef).build,
      (characters[k] as CharacterRef).state,
      own ? ((characters[k] as CharacterRef).catalog as Catalog) : v1,
    ).play.hp.current;
  return {
    characters,
    run,
    hp,
    encounter: () => encounter,
    ctx: () => ({ catalog: v1, characters }),
  };
}
const spark = (id: string, target: string, slot?: number): EncounterAction =>
  ({
    type: "cast",
    id,
    spell: "test-spark",
    targets: [target],
    ...(slot ? { slot_level: slot } : {}),
  }) as EncounterAction;
const slots = (s: CharacterState) => s.spell_slots_spent;

describe("CharacterRef.catalog: each character on its own content, the world on the encounter's", () => {
  it("per document: the two versions differ (resistance, spell level)", () => {
    expect(computePlaySheet(wrenBuild, createState(wrenBuild, v1), v1).resistances).toEqual([
      "fire",
    ]);
    expect(computePlaySheet(sableBuild, createState(sableBuild, v2), v2).resistances).toEqual([]);
    expect(
      computePlaySheet(wrenBuild, createState(wrenBuild, v1), v1).spells.find(
        (s) => s.id === "test-spark",
      )?.level,
    ).toBe(0);
    expect(
      computePlaySheet(sableBuild, createState(sableBuild, v2), v2).spells.find(
        (s) => s.id === "test-spark",
      )?.level,
    ).toBe(1);
  });

  it("the actor's spell and cost, the target's defences, the world's monster", () => {
    const d = duel(true);
    expect(d.encounter().combatants.find((c) => c.id === "test-dummy")?.hp).toBe(30); // world v1
    d.run(spark("wren", "test-dummy"), [15, 3]); // v1 cantrip 1d4
    expect(d.encounter().combatants.find((c) => c.id === "test-dummy")?.hp).toBe(27);
    expect(slots((d.characters.wren as CharacterRef).state)).toEqual([]);
    d.run({ type: "next_turn" });
    const before = d.hp("wren") as number;
    d.run(spark("sable", "wren", 1), [15, 3, 3]); // v2: 1st-level slot, 2d4 = 6; Wren (v1) resists
    expect(slots((d.characters.sable as CharacterRef).state)).toEqual([1]);
    expect(before - (d.hp("wren") as number)).toBe(3);
  });

  it("self-target: the cost and then the effect on the same character keep its catalog", () => {
    const d = duel(true);
    d.run({ type: "next_turn" });
    const before = d.hp("sable") as number;
    d.run(spark("sable", "sable", 1), [15, 3, 3]);
    expect(slots((d.characters.sable as CharacterRef).state)).toEqual([1]);
    expect(before - (d.hp("sable") as number)).toBe(6); // v2: no fire resistance
  });

  it("a later action of the same caller still uses the character's catalog (batch)", () => {
    const d = duel(true);
    d.run({ type: "next_turn" });
    d.run(spark("sable", "wren", 1), [15, 3, 3]);
    for (let i = 0; i < 3; i++) d.run({ type: "next_turn" });
    d.run(spark("sable", "sable", 1), [15, 3, 3]);
    expect(slots((d.characters.sable as CharacterRef).state)).toEqual([2]);
  });

  it("replayHistory with the same references gives the live result", () => {
    const d = duel(true);
    const start = d.encounter();
    const initial = Object.fromEntries(Object.entries(d.characters).map(([k, r]) => [k, { ...r }]));
    let history = createHistory(
      start,
      Object.fromEntries(Object.entries(initial).map(([k, r]) => [k, r.state])),
    );
    for (const [a, dice] of [
      [{ type: "next_turn" }, []],
      [spark("sable", "sable", 1), [15, 3, 3]],
    ] as [EncounterAction, number[]][]) {
      history = recordAction(history, a, d.run(a, dice));
    }
    const replayed = replayHistory(history, { catalog: v1, characters: initial });
    expect(replayed.states.sable).toEqual((d.characters.sable as CharacterRef).state);
    expect(replayed.encounter).toEqual(d.encounter());
  });

  it("options and checks list the actor's version", () => {
    const d = duel(true);
    d.run({ type: "next_turn" });
    const options = combatantOptions(d.encounter(), "sable", d.ctx());
    const entry = options.spells.find(
      (s) => (s.action as { spell?: string }).spell === "test-spark",
    );
    expect(entry?.action).toMatchObject({ slot_level: 1 });
    expect(checkAction(d.encounter(), spark("sable", "wren", 1), d.ctx()).ok).toBe(true);
    // The same check with the world's catalog for everyone refuses: the v1 spell is a cantrip.
    const plain = {
      catalog: v1,
      characters: Object.fromEntries(
        Object.entries(d.characters).map(([k, r]) => [k, { build: r.build, state: r.state }]),
      ),
    };
    expect(checkAction(d.encounter(), spark("sable", "wren", 1), plain).ok).toBe(false);
  });

  it("catalogOf: a character's own catalog, else the encounter's", () => {
    const d = duel(true);
    const e = d.encounter();
    const c = (id: string) =>
      e.combatants.find((x) => x.id === id) as Encounter["combatants"][number];
    expect(catalogOf(d.ctx(), c("sable"))).toBe(v2);
    expect(catalogOf(d.ctx(), c("test-dummy"))).toBe(v1);
    const plain = {
      catalog: v1,
      characters: { sable: { build: sableBuild, state: createState(sableBuild, v2) } },
    };
    expect(catalogOf(plain, c("sable"))).toBe(v1);
  });

  it("without CharacterRef.catalog nothing changes: every character uses the encounter's catalog", () => {
    const d = duel(false);
    d.run({ type: "next_turn" });
    expect(() => d.run(spark("sable", "wren", 1), [15, 3, 3])).toThrow(/cantrip/);
  });
});
