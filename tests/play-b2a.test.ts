import { describe, expect, it } from "vitest";
import {
  applyAction,
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
  fixedRng,
  resolve,
} from "../src/index";
import { srdPack } from "../src/srd";
import { autocomplete, classBuild, levelUpIn } from "./helpers";

// kenli F-002 T12 B2a: cast-time Metamagic in an encounter, invented test data only (`source:
// test`): each SRD Metamagic feature gets its cast option with an explicit `effect`, and the
// Sorcerer's level 7 a `cast_option_limit` (two while Innate Sorcery is active) and a
// `toggle_alternatives` entry (Innate Sorcery for 2 Sorcery Points when no use is left).
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
  manifest: { id: "test-b2a", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
  patches: [
    opt("distant-spell", 1, "distant"),
    opt("quickened-spell", 2, "quickened"),
    opt("subtle-spell", 1, "subtle"),
    opt("heightened-spell", 2, "heightened"),
    opt("careful-spell", 1, "careful"),
    opt("empowered-spell", 1, null, true),
    {
      target: "classes/sorcerer",
      op: "set",
      path: "features.7.cast_option_limit",
      value: { count: 2, while_active: "innate-sorcery" },
    },
    {
      target: "classes/sorcerer",
      op: "set",
      path: "features.7.toggle_alternatives",
      value: [
        {
          toggle: "innate-sorcery",
          resource_class: "sorcerer",
          resource: "sorcery-points",
          amount: 2,
        },
      ],
    },
  ],
};
const cat: Catalog = createCatalog([srdPack, pack], {});
const SP = "sorcerer:sorcery-points";
const INNATE = "sorcerer:innate-sorcery";

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
const key = (b: CharacterBuild, id: string) =>
  computePlaySheet(b, createState(b, cat), cat).cast_options.find((o) => o.key.endsWith(id))
    ?.key as string;

function fight(build: CharacterBuild, monsters: string[], gap = 0, state?: CharacterState) {
  const nb = builder.setName(build, cat, "Me").build;
  const characters: Record<string, { build: CharacterBuild; state: CharacterState }> = {
    me: { build: nb, state: state ?? createState(nb, cat) },
  };
  let e: Encounter = createEncounter();
  const act = (a: EncounterAction) => {
    const r = applyEncounterAction(e, a, { catalog: cat, characters, rng: fixedRng(10) });
    e = r.encounter;
    for (const [id, x] of Object.entries(r.states))
      characters[id] = { ...characters[id]!, state: x };
    return r;
  };
  act({ type: "add_character", character: "me" });
  for (const m of monsters) act({ type: "add_monster", monster: m });
  if (gap) {
    act({ type: "place", id: "me", x: 0, y: 0 });
    act({ type: "place", id: monsters[0]!, x: gap, y: 0 });
  }
  act({ type: "set_initiative", id: "me", value: 20 });
  for (const m of monsters) act({ type: "set_initiative", id: m, value: 1 });
  act({ type: "start" });
  return { act, me: () => characters.me!.state, enc: () => e };
}
const sp = (s: CharacterState) => s.uses_spent[SP] ?? 0;

describe("B2a Distant Spell in an encounter", () => {
  it("doubles the range for the target check (Fire Bolt 120 → 240 ft); beyond it refused, nothing spent; Self refused", () => {
    const b = sorcerer(3, ["distant-spell", "quickened-spell"]);
    const D = key(b, "distant-spell");
    const cast = { type: "cast" as const, id: "me", spell: "fire-bolt", targets: ["ogre"] };
    expect(() => fight(b, ["ogre"], 40).act(cast)).toThrow(/out of Fire Bolt's range \(120 feet\)/);
    const f = fight(b, ["ogre"], 40);
    f.act({ ...cast, options: [D] });
    expect(sp(f.me())).toBe(1);
    const far = fight(b, ["ogre"], 52);
    expect(() => far.act({ ...cast, options: [D] })).toThrow(/240 feet/);
    expect(sp(far.me())).toBe(0);
    const self = fight(b, ["ogre"]);
    expect(() =>
      self.act({ type: "cast", id: "me", spell: "burning-hands", targets: ["ogre"], options: [D] }),
    ).toThrow(/range/);
  });
});

describe("B2a Quickened Spell: a Bonus Action, and the level 1+ spell turn rule", () => {
  const b = sorcerer(3, ["distant-spell", "quickened-spell"]);
  const Q = key(b, "quickened-spell");
  const fb = { type: "cast" as const, id: "me", spell: "fire-bolt", targets: ["ogre"] };
  const mm = { type: "cast" as const, id: "me", spell: "magic-missile", targets: ["ogre"] };
  it("a quickened cantrip uses the Bonus Action (the Action stays); then no level 1+ spell this turn; next turn again", () => {
    const f = fight(b, ["ogre"]);
    f.act({ ...fb, options: [Q] });
    expect(sp(f.me())).toBe(2);
    expect(f.enc().combatants.find((c) => c.id === "me")?.used.bonus_action).toBe(true);
    expect(f.enc().combatants.find((c) => c.id === "me")?.used.action).toBe(false);
    expect(() => f.act(mm)).toThrow(/no level 1\+ spell on a turn Quickened Spell was used/);
    f.act(fb); // a cantrip with the Action is fine
    f.act({ type: "next_turn" });
    f.act({ type: "next_turn" });
    expect(() => f.act(mm)).not.toThrow();
  });
  it("after a level 1+ spell this turn Quickened is refused, nothing spent", () => {
    const f = fight(b, ["ogre"]);
    f.act(mm);
    expect(() => f.act({ ...fb, options: [Q] })).toThrow(/after a level 1\+ spell this turn/);
    expect(sp(f.me())).toBe(0);
  });
});

describe("B2a Heightened and Careful Spell: the chosen targets' saves", () => {
  const b = sorcerer(3, ["heightened-spell", "careful-spell"]);
  const H = key(b, "heightened-spell");
  const C = key(b, "careful-spell");
  const bh = {
    type: "cast" as const,
    id: "me",
    spell: "burning-hands",
    targets: ["ogre", "goblin-warrior"],
  };
  it("Heightened: one chosen target saves with Disadvantage, the other normally; 2 points", () => {
    const f = fight(b, ["ogre", "goblin-warrior"]);
    const r = f.act({ ...bh, options: [H], heightened: "ogre" });
    const res = r.result as unknown as {
      targets: { target: number; save: { roll: { mode: string } } | null }[];
    };
    expect(res.targets[0]?.save?.roll.mode).toBe("disadvantage");
    expect(res.targets[1]?.save?.roll.mode).toBe("normal");
    expect(sp(f.me())).toBe(2);
    expect(() =>
      fight(b, ["ogre", "goblin-warrior"]).act({ ...bh, options: [H], heightened: "me" }),
    ).toThrow(/choose one of the spell's targets/);
    expect(() =>
      fight(b, ["ogre"]).act({
        type: "cast",
        id: "me",
        spell: "fire-bolt",
        targets: ["ogre"],
        options: [H],
        heightened: "ogre",
      }),
    ).toThrow(/forces no saving throw/);
  });
  it("Careful: up to CHA modifier creatures succeed automatically and take no damage (half otherwise); too many refused", () => {
    const f = fight(b, ["ogre", "goblin-warrior"]);
    const r = f.act({ ...bh, options: [C], careful: ["goblin-warrior"] });
    const res = r.result as unknown as {
      targets: {
        save: { success: boolean; automatic_success?: string } | null;
        actions: { type: string }[];
      }[];
    };
    expect(res.targets[1]?.save).toMatchObject({
      success: true,
      automatic_success: expect.any(String),
    });
    expect(res.targets[1]?.actions.some((a) => a.type === "damage")).toBe(false);
    expect(res.targets[0]?.save?.automatic_success).toBeUndefined();
    expect(sp(f.me())).toBe(1);
    const cha = Math.max(1, computePlaySheet(b, createState(b, cat), cat).modifiers.cha);
    const many = Array.from({ length: cha + 1 }, () => ["ogre", "goblin-warrior"]).flat();
    expect(() =>
      fight(b, ["ogre", "goblin-warrior"]).act({ ...bh, options: [C], careful: many }),
    ).toThrow(/up to/);
  });
  it("one option per spell; Heightened + Careful together refused without Sorcery Incarnate", () => {
    expect(() =>
      fight(b, ["ogre", "goblin-warrior"]).act({
        ...bh,
        options: [H, C],
        heightened: "ogre",
        careful: ["goblin-warrior"],
      }),
    ).toThrow(/Only one/);
  });
});

describe("B2a Subtle Spell", () => {
  it("states the cast without components and keeps a costly Material component", () => {
    const b = sorcerer(3, ["subtle-spell", "distant-spell"]);
    const S = key(b, "subtle-spell");
    const r = fight(b, ["ogre"]).act({
      type: "cast",
      id: "me",
      spell: "fire-bolt",
      targets: ["ogre"],
      options: [S],
    });
    expect(r.messages.some((m) => m.code === "cast.subtle")).toBe(true);
    expect(r.notes.join(" ")).not.toMatch(/still needed/);
  });
});

describe("B2a Sorcery Incarnate (Sorcerer 7): two options while Innate Sorcery; Innate for 2 points", () => {
  it("two options refused without Innate Sorcery, allowed with it; Innate with no use left costs 2 Sorcery Points", () => {
    const b = sorcerer(7, ["distant-spell", "quickened-spell"]);
    const D = key(b, "distant-spell");
    const Q = key(b, "quickened-spell");
    const both = {
      type: "cast" as const,
      id: "me",
      spell: "fire-bolt",
      targets: ["ogre"],
      options: [D, Q],
    };
    expect(() => fight(b, ["ogre"]).act(both)).toThrow(/Only one/);
    let s = createState(b, cat);
    s = applyAction(b, s, cat, { type: "activate", key: INNATE }).state;
    const f = fight(b, ["ogre"], 0, s);
    f.act(both);
    expect(sp(f.me())).toBe(3);
    // no Innate use left: 2 Sorcery Points instead
    let t = createState(b, cat);
    t = applyAction(b, t, cat, { type: "use", key: INNATE, amount: 2 }).state;
    const r = applyAction(b, t, cat, { type: "activate", key: INNATE });
    expect(r.state.uses_spent[SP]).toBe(2);
    expect(r.state.active).toContain(INNATE);
    const broke = applyAction(b, t, cat, {
      type: "use",
      key: SP,
      amount: computePlaySheet(b, t, cat).play.uses.find((u) => u.key === SP)!.max - 1,
    }).state;
    expect(() => applyAction(b, broke, cat, { type: "activate", key: INNATE })).toThrow(/needed/);
  });
  it("before Sorcerer 7: no second option even with Innate Sorcery, no 2-point activation", () => {
    const b = sorcerer(6, ["distant-spell", "quickened-spell"]);
    let s = createState(b, cat);
    s = applyAction(b, s, cat, { type: "activate", key: INNATE }).state;
    expect(() =>
      fight(b, ["ogre"], 0, s).act({
        type: "cast",
        id: "me",
        spell: "fire-bolt",
        targets: ["ogre"],
        options: [key(b, "distant-spell"), key(b, "quickened-spell")],
      }),
    ).toThrow(/Only one/);
    let t = createState(b, cat);
    t = applyAction(b, t, cat, { type: "use", key: INNATE, amount: 2 }).state;
    expect(() => applyAction(b, t, cat, { type: "activate", key: INNATE })).toThrow(
      /no uses|left/i,
    );
  });
});

describe("B2a Subtle Spell's Material exception", () => {
  it("a costly or consumed Material component is kept; ordinary components aren't", async () => {
    const { costlyMaterial } = await import("../src/rules/metamagic");
    const spell = (id: string) => cat.spells[id as keyof typeof cat.spells] as never;
    expect(costlyMaterial(spell("chromatic-orb"))).toMatch(/diamond worth 50\+ GP/);
    expect(costlyMaterial(spell("fire-bolt"))).toBeNull();
  });
});
