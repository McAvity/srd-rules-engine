import { describe, expect, it } from "vitest";
import {
  type AttackDice,
  addAdvantageDie,
  applyAction,
  applyEncounterAction,
  type Catalog,
  type CharacterBuild,
  type CharacterState,
  type ContentPack,
  checkCosts,
  combatantFromCharacter,
  computePlaySheet,
  createCatalog,
  createEncounter,
  createState,
  type DeclaredResult,
  type Encounter,
  type EncounterAction,
  FeatureActionSchema,
  GrantsSchema,
  type PlayAction,
  PlayError,
  parseState,
  ResourceSchema,
  RollWhatSchema,
  RuleError,
  rerollDie,
  roll,
  rollByHand,
  rollCheck,
  scriptedRng,
  setCritical,
} from "../src/index";
import * as svc from "../src/services/builder";
import { srdPack } from "../src/srd";
import { autocomplete, classBuild, levelUpIn, catalog as srd } from "./helpers";

// F-005 player actions: feature payments (Font of Inspiration, a slot instead of a use), a
// feature's own die, free casts and rituals, the GM's additions to D20 Tests and attacks, rolls
// changed afterwards (Luck-like late Advantage, Heroic Inspiration, a Critical Hit decided at the
// table), armor without training and the Grapple/Shove texts. The private features these model
// (found only in packs) are invented `source: test` ones
// here: humans get them through a patch.

const testPack: ContentPack = {
  name: "test-actions",
  manifest: { id: "test-actions", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
  patches: [
    // Font of Inspiration and Magic Initiate's free cast as a pack gives them: the bundled SRD data
    // stays byte for byte (documents pin it by its hash, F-008).
    {
      target: "classes/bard",
      op: "append",
      path: "features.5.actions",
      value: {
        id: "font-of-inspiration",
        name: "Font of Inspiration",
        economy: "free",
        restores: "bardic-inspiration",
        slot_payment: "required",
      },
    },
    {
      target: "feats/magic-initiate",
      op: "append",
      path: "grants.free_casts",
      value: { uses: "free-cast", choice: "spell" },
    },
    {
      target: "species/human",
      op: "append",
      path: "grants.resources",
      value: { id: "test-word", name: "Test Word", max: { value: 1 }, recharge: "long" },
    },
    {
      target: "species/human",
      op: "append",
      path: "grants.resources",
      value: { id: "test-spur", name: "Test Spur", max: { value: 2 }, recharge: "long" },
    },
    {
      target: "species/human",
      op: "append",
      path: "grants.resources",
      value: {
        id: "test-luck",
        name: "Test Luck",
        max: { value: 3 },
        recharge: "long",
        spend_for: ["d20_advantage", "impose_disadvantage"],
      },
    },
    {
      target: "species/human",
      op: "append",
      path: "grants.actions",
      value: {
        id: "test-word",
        name: "Test Word",
        economy: "action",
        uses: "test-word",
        slot_payment: "instead",
      },
    },
    {
      target: "species/human",
      op: "append",
      path: "grants.actions",
      value: {
        id: "test-taunt",
        name: "Test Taunt",
        economy: "bonus_action",
        uses: "test-spur",
        target: "other",
        roll: { dice: "1d8" },
      },
    },
    {
      target: "species/human",
      op: "set",
      path: "grants.d20_floors",
      value: [
        {
          min: 10,
          kind: "check",
          skills: ["persuasion", "deception"],
          abilities: ["cha"],
          label: "Test Tongue",
        },
      ],
    },
  ],
};
const cat: Catalog = createCatalog(srdPack, testPack);

const act = (build: CharacterBuild, state: CharacterState, c: Catalog, ...actions: PlayAction[]) =>
  actions.reduce((s, a) => applyAction(build, s, c, a).state, state);
const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof PlayError) return e.details[0]?.code ?? null;
    if (e instanceof RuleError) return e.detail.code;
    throw e;
  }
};

/** SYN-BARD5 of the F-005 contract: SRD Bard 5 (Magic Initiate at 4), both BI spent, a 1st slot. */
function bard(c: Catalog = srd) {
  const build = levelUpIn(
    autocomplete(classBuild("bard", { name: "Syn Bard" }), c),
    "bard",
    4,
    null,
    c,
  );
  const state = act(
    build,
    createState(build, c),
    c,
    { type: "use", key: "bard:bardic-inspiration", amount: 2 },
    { type: "spend_slot", level: 1 },
  );
  return { build, state };
}
/** SYN-FIGHTER3: SRD Fighter 3 (Champion: critical on 19), Second Wind spent, 12 damage. */
function fighter() {
  const build = levelUpIn(
    autocomplete(classBuild("fighter", { name: "Syn Fighter" })),
    "fighter",
    2,
  );
  const state = act(
    build,
    createState(build, srd),
    srd,
    { type: "use", key: "fighter:second-wind", amount: 2 },
    { type: "damage", amount: 12 },
  );
  return { build, state };
}
/** SYN-WIZARD1-RAY: SRD Wizard 1 with Ray of Sickness prepared and Heroic Inspiration. */
function wizard() {
  let build = autocomplete(classBuild("wizard", { name: "Syn Wizard" }));
  const book = (build.choices["class:wizard#spellbook"] ?? []).filter(
    (x) => x !== "comprehend-languages",
  );
  build = svc.setChoice(build, srd, "class:wizard#spellbook", [...book, "ray-of-sickness"]).build;
  const prepared = (build.choices["class:wizard#prepared"] ?? []).filter(
    (x) => x !== "chromatic-orb",
  );
  build = autocomplete(
    svc.setChoice(build, srd, "class:wizard#prepared", [...prepared, "ray-of-sickness"]).build,
  );
  const state = act(build, createState(build, srd), srd, { type: "set_inspiration", value: true });
  return { build, state };
}
/** The wizard in Chain Mail it isn't trained with. */
function armored() {
  const w = wizard();
  let state = act(w.build, w.state, srd, { type: "add_item", item: "chain-mail" });
  const mail = state.inventory.find((i) => i.item === "chain-mail")?.id as string;
  state = act(w.build, state, srd, { type: "equip", id: mail, equipped: true });
  return { ...w, state, mail };
}
const byHand = (
  d: { build: CharacterBuild; state: CharacterState },
  what: unknown,
  dice: number[],
  c: Catalog = srd,
) =>
  rollByHand(combatantFromCharacter(d.build, d.state, c), RollWhatSchema.parse(what), {
    catalog: c,
    character: d,
    rng: scriptedRng(dice),
  });
const pay = (
  d: { build: CharacterBuild; state: CharacterState },
  r: { costs: readonly unknown[] },
  c: Catalog = srd,
) =>
  (r.costs as { type: string; action: PlayAction }[]).reduce(
    (s, x) => (x.type === "play" ? applyAction(d.build, s, c, x.action).state : s),
    d.state,
  );

describe("feature payments (AC-01)", () => {
  const b = bard(cat);
  const font: PlayAction = {
    type: "use_feature",
    key: "bard:font-of-inspiration",
    payment: { type: "slot", level: 3 },
  };

  it("Font of Inspiration: one slot of any level gives one Bardic Inspiration use back", () => {
    const r = applyAction(b.build, b.state, cat, font);
    expect(r.state.spell_slots_spent).toEqual([1, 0, 1]);
    expect(r.state.uses_spent["bard:bardic-inspiration"]).toBe(1);
    expect(r.messages.map((m) => m.code)).toContain("play.feature_restores");
    const line = computePlaySheet(b.build, b.state, cat).actions.find(
      (a) => a.key === "bard:font-of-inspiration",
    );
    expect(line).toMatchObject({
      economy: "free",
      restores: "bard:bardic-inspiration",
      slot_payment: "required",
    });
  });

  it("refused before any change: a full pool, no payment, no slot left, a payment it doesn't take", () => {
    const full = act(b.build, b.state, cat, {
      type: "restore_use",
      key: "bard:bardic-inspiration",
      amount: 2,
    });
    expect(code(() => applyAction(b.build, full, cat, font))).toBe("refusal.nothing_to_restore");
    expect(
      code(() =>
        applyAction(b.build, b.state, cat, {
          type: "use_feature",
          key: "bard:font-of-inspiration",
        }),
      ),
    ).toBe("refusal.payment_required");
    const noThird = act(
      b.build,
      b.state,
      cat,
      { type: "spend_slot", level: 3 },
      { type: "spend_slot", level: 3 },
    );
    expect(code(() => applyAction(b.build, noThird, cat, font))).toBe(
      "refusal.no_level_spell_slots",
    );
    expect(
      code(() => applyAction(b.build, b.state, cat, { ...font, payment: { type: "pact" } })),
    ).toBe("refusal.no_pact_magic_slots");
    const bi: PlayAction = {
      type: "use_feature",
      key: "bard:bardic-inspiration",
      payment: { type: "slot", level: 1 },
    };
    expect(code(() => applyAction(b.build, full, cat, bi))).toBe("refusal.payment_not_accepted");
    // The state given is never changed (`applyAction` returns a new one).
    expect(full.spell_slots_spent).toEqual([1]);
  });

  it("a slot instead of a spent use (a pack's slot-instead feature): the use is left as it is", () => {
    const t = bard(cat);
    const word: PlayAction = { type: "use_feature", key: "species:human:test-word" };
    const once = act(t.build, t.state, cat, word);
    expect(once.uses_spent["species:human:test-word"]).toBe(1);
    expect(() => applyAction(t.build, once, cat, word)).toThrow(PlayError);
    try {
      applyAction(t.build, once, cat, word);
    } catch (e) {
      expect((e as PlayError).details[0]).toMatchObject({
        code: "refusal.uses_left_count",
        params: { slot_payment: true },
      });
    }
    const slot = applyAction(t.build, once, cat, {
      ...word,
      payment: { type: "slot", level: 2 },
    }).state;
    expect(slot.spell_slots_spent).toEqual([1, 1]);
    expect(slot.uses_spent["species:human:test-word"]).toBe(1);
  });

  it("Incapacitated refuses an action, Bonus Action or reaction feature; force is the GM's override; Font stays usable", () => {
    const restored = act(b.build, b.state, cat, {
      type: "restore_use",
      key: "bard:bardic-inspiration",
    });
    const down = act(b.build, restored, cat, { type: "add_condition", condition: "incapacitated" });
    const give: PlayAction = { type: "use_feature", key: "bard:bardic-inspiration" };
    expect(code(() => applyAction(b.build, down, cat, give))).toBe("refusal.incapacitated_feature");
    const forced = applyAction(b.build, down, cat, { ...give, force: true });
    expect(forced.state.uses_spent["bard:bardic-inspiration"]).toBe(2);
    expect(forced.messages.map((m) => m.code)).toContain("play.forced");
    expect(
      applyAction(b.build, down, cat, font).state.uses_spent["bard:bardic-inspiration"] ?? 0,
    ).toBe(0);
  });

  it("a feature's own die (a pack's die feature): its use spent once by the costs, the die rolled, the effect the table's", () => {
    const t = bard(cat);
    const r = byHand(t, { type: "feature", feature: "species:human:test-taunt" }, [2], cat);
    expect(r.rolls.die).toMatchObject({ dice_expression: "1d8", rolls: [2], total: 2 });
    expect(r.costs).toEqual([
      {
        type: "play",
        action: { type: "use_feature", key: "species:human:test-taunt", manual: true },
      },
    ]);
    expect(r.messages.map((m) => m.code)).toEqual(["feature.manual_effect"]);
    const spent = act(t.build, t.state, cat, {
      type: "use",
      key: "species:human:test-spur",
      amount: 2,
    });
    const unpaid = checkCosts(r.costs, {
      catalog: cat,
      name: "Syn Bard",
      character: { build: t.build, state: spent },
    });
    expect(unpaid[0]?.payable).toBe(false);
    // A feature without a die has no `die` (its result is unchanged).
    expect(
      "die" in byHand(b, { type: "feature", feature: "bard:bardic-inspiration" }, [], cat).rolls,
    ).toBe(false);
  });
});

describe("free casts and rituals (AC-02)", () => {
  const b = bard(cat);
  const mi = "feat:magic-initiate@class:bard:4#feat:free-cast";

  it("the play sheet lists the free cast and the ritual tag; a spent free cast says why", () => {
    const sheet = computePlaySheet(b.build, b.state, cat);
    const bless = sheet.spells.find((s) => s.id === "bless");
    expect(bless?.free).toEqual([
      {
        use: mi,
        name: "Magic Initiate (free level 1 spell)",
        spellcasting: "Magic Initiate",
        left: 1,
        available: true,
        reason: null,
      },
    ]);
    const spent = act(b.build, b.state, cat, { type: "use", key: mi });
    const again = computePlaySheet(b.build, spent, cat).spells.find((s) => s.id === "bless");
    expect(again?.free[0]).toMatchObject({
      left: 0,
      available: false,
      reason: { message: { code: "refusal.free_cast_spent" } },
    });
    const w = wizard();
    const alarm = computePlaySheet(w.build, w.state, cat).spells.find((s) => s.id === "alarm");
    expect(alarm?.ritual).toBe(true);
  });

  it("a free cast spends the use, not a slot, at the spell's level with its source's line", () => {
    const r = byHand(
      b,
      { type: "cast", spell: "bless", payment: { type: "free", use: mi } },
      [],
      cat,
    );
    expect(r.slot_level).toBe(1);
    expect(r.costs).toEqual([
      { type: "play", action: { type: "use", key: mi } },
      { type: "play", action: { type: "set_concentration", spell: "Bless" } },
    ]);
    const paid = pay(b, r, cat);
    expect(paid.spell_slots_spent).toEqual(b.state.spell_slots_spent);
    expect(paid.uses_spent[mi]).toBe(1);
    // Spent: the use can't be paid (the slot is still offered by the sheet).
    const unpaid = checkCosts(r.costs, {
      catalog: cat,
      name: "Syn Bard",
      character: { build: b.build, state: paid },
    });
    expect(unpaid[0]?.payable).toBe(false);
  });

  it("free cast refusals: upcast, another line, a use that doesn't cast it, a cantrip", () => {
    const free = { type: "free", use: mi };
    expect(
      code(() =>
        byHand(b, { type: "cast", spell: "bless", slot_level: 2, payment: free }, [], cat),
      ),
    ).toBe("refusal.free_cast_base_level");
    expect(
      code(() =>
        byHand(b, { type: "cast", spell: "bless", spellcasting: "Bard", payment: free }, [], cat),
      ),
    ).toBe("refusal.free_cast_source");
    expect(code(() => byHand(b, { type: "cast", spell: "command", payment: free }, [], cat))).toBe(
      "refusal.free_cast_not_for_spell",
    );
    expect(code(() => byHand(b, { type: "cast", spell: "light", payment: free }, [], cat))).toBe(
      "refusal.free_cast_not_for_spell",
    );
  });

  it("a ritual takes no slot and says it's 10 minutes longer; refused with a slot or for a spell without the tag", () => {
    const w = wizard();
    const r = byHand(w, { type: "cast", spell: "alarm", payment: { type: "ritual" } }, [], cat);
    expect(r.costs).toEqual([]);
    expect(r.slot_level).toBe(1);
    expect(r.messages.map((m) => m.code)).toContain("cast.ritual");
    expect(
      code(() =>
        byHand(
          w,
          { type: "cast", spell: "alarm", slot_level: 1, payment: { type: "ritual" } },
          [],
          cat,
        ),
      ),
    ).toBe("refusal.ritual_no_slot");
    expect(
      code(() =>
        byHand(w, { type: "cast", spell: "burning-hands", payment: { type: "ritual" } }, [], cat),
      ),
    ).toBe("refusal.not_ritual");
    // The default is still a slot.
    expect(byHand(w, { type: "cast", spell: "alarm" }, [], cat).costs).toEqual([
      { type: "play", action: { type: "spend_slot", level: 1 } },
    ]);
  });
});

describe("D20 Tests: Initiative, the GM's additions, floors (AC-03)", () => {
  const f = fighter();

  it("Initiative is a Dexterity check with the sheet's Initiative bonus and its modes", () => {
    const sheet = computePlaySheet(f.build, f.state, srd);
    const r = rollCheck(f.build, f.state, srd, { initiative: true }, { rng: scriptedRng([11]) });
    expect(r).toMatchObject({
      kind: "check",
      label: "Initiative",
      ability: "dex",
      skill: null,
      initiative: true,
    });
    expect(r.total).toBe(11 + sheet.initiative.total);
    const unseen = act(f.build, f.state, srd, { type: "add_condition", condition: "invisible" });
    expect(
      rollCheck(f.build, unseen, srd, { initiative: true }, { rng: scriptedRng([3, 12]) }).roll
        .mode,
    ).toBe("advantage");
  });

  it("modifiers and bonus dice are added and listed; the override replaces the computed mode", () => {
    const r = rollCheck(
      f.build,
      f.state,
      srd,
      { skill: "athletics" },
      {
        rng: scriptedRng([7, 3]),
        modifiers: [{ value: 2, label: "DM" }],
        bonus_dice: [{ dice: "1d4", label: "Bless" }],
      },
    );
    expect(r.total).toBe(7 + r.bonus + 2 + 3);
    expect(r.modifiers).toEqual([{ label: "DM", value: 2 }]);
    expect(r.bonus_dice).toEqual([{ label: "Bless", dice: "1d4", sign: 1, rolls: [3], total: 3 }]);
    expect(r.resolution.bonus).toBe(r.bonus + 2);
    const poisoned = act(f.build, f.state, srd, { type: "add_condition", condition: "poisoned" });
    const asked = rollCheck(
      f.build,
      poisoned,
      srd,
      { skill: "athletics" },
      { rng: scriptedRng([15]), mode: "advantage" },
    );
    expect(asked.roll.mode).toBe("normal");
    const over = rollCheck(
      f.build,
      poisoned,
      srd,
      { skill: "athletics" },
      {
        rng: scriptedRng([15, 4]),
        mode: "advantage",
        mode_override: { mode: "advantage", reason: "DM" },
      },
    );
    expect(over.roll).toMatchObject({
      mode: "advantage",
      rolls: [15, 4],
      kept: 0,
      natural: 15,
      d20: 15,
    });
    expect(over.computed_mode).toBe("normal");
    expect(over.resolution.override).toEqual({ mode: "advantage", reason: "DM" });
    expect(
      code(() =>
        rollCheck(f.build, f.state, srd, { skill: "athletics" }, { damage_modifiers: [] } as never),
      ),
    ).toBe("refusal.dm_roll_not_applicable");
  });

  it("a d20 floor (a pack's floor) on Persuasion and Deception with Charisma only; raw and counted dice both kept", () => {
    const t = bard(cat);
    const per = rollCheck(
      t.build,
      t.state,
      cat,
      { skill: "persuasion" },
      { rng: scriptedRng([3]) },
    );
    expect(per.roll).toMatchObject({ rolls: [3], natural: 3, d20: 10 });
    expect(per.floors).toEqual([{ label: "Test Tongue", from: 3, to: 10 }]);
    expect(per.total).toBe(10 + per.bonus);
    expect(
      rollCheck(t.build, t.state, cat, { skill: "deception" }, { rng: scriptedRng([3]) }).roll.d20,
    ).toBe(10);
    expect(
      rollCheck(t.build, t.state, cat, { skill: "intimidation" }, { rng: scriptedRng([3]) }).roll
        .d20,
    ).toBe(3);
    expect(
      rollCheck(t.build, t.state, cat, { save: "cha" }, { rng: scriptedRng([3]) }).roll.d20,
    ).toBe(3);
    expect(
      rollCheck(t.build, t.state, cat, { initiative: true }, { rng: scriptedRng([3]) }).roll.d20,
    ).toBe(3);
    // Unused at first, still in the resolution (a reroll needs it).
    const high = rollCheck(
      t.build,
      t.state,
      cat,
      { skill: "persuasion" },
      { rng: scriptedRng([15]) },
    );
    expect(high.floors).toEqual([]);
    expect(high.resolution.floors).toEqual([{ min: 10, label: "Test Tongue" }]);
    // The same bard without the pack has no floor.
    const plain = bard();
    expect(
      rollCheck(plain.build, plain.state, srd, { skill: "persuasion" }, { rng: scriptedRng([3]) })
        .roll.d20,
    ).toBe(3);
  });

  it("the uses that can give a roll Advantage are listed (a luck-style resource)", () => {
    const t = bard(cat);
    const r = rollCheck(t.build, t.state, cat, { skill: "persuasion" }, { rng: scriptedRng([15]) });
    expect(r.resources).toEqual([{ use: "species:human:test-luck", for: "d20_advantage" }]);
    expect(
      "resources" in
        rollCheck(f.build, f.state, srd, { skill: "athletics" }, { rng: scriptedRng([15]) }),
    ).toBe(false);
  });

  it("spend_inspiration spends Heroic Inspiration, and is refused without it", () => {
    const w = wizard();
    expect(
      applyAction(w.build, w.state, srd, { type: "spend_inspiration" }).state.heroic_inspiration,
    ).toBe(false);
    expect(code(() => applyAction(f.build, f.state, srd, { type: "spend_inspiration" }))).toBe(
      "refusal.no_heroic_inspiration",
    );
  });
});

describe("attacks by hand with the GM's additions (AC-03, AC-04)", () => {
  const f = fighter();

  it("weapon: GM Disadvantage, a −2, a Bless die on the roll and 1d4 necrotic damage, each listed", () => {
    const r = byHand(
      f,
      {
        type: "attack",
        attack: "Greatsword",
        dm: {
          modes: [{ mode: "disadvantage", label: "DM: heavy fog" }],
          modifiers: [{ value: -2, label: "DM" }],
          bonus_dice: [{ dice: "1d4", label: "Bless" }],
          damage_bonus_dice: [{ dice: "1d4", type: "necrotic", label: "DM" }],
        },
      },
      [17, 4, 3, 3, 5, 2],
    );
    const a = r.rolls.attacks[0] as AttackDice;
    expect(a.roll).toMatchObject({ mode: "disadvantage", rolls: [17, 4], kept: 1, natural: 4 });
    expect(a.bonus).toBe(3);
    expect(a.total).toBe(4 + 3 + 3);
    expect(a.damage?.parts.map((p) => [p.dice, p.type, p.rolls, p.label])).toEqual([
      ["2d6", "slashing", [3, 5], undefined],
      ["1d4", "necrotic", [2], "DM"],
    ]);
    expect(a.damage?.total).toBe(13);
    expect(a.resolution).toMatchObject({
      kind: "attack",
      critical_on: 19,
      bonus: 3,
      sources: [{ mode: "disadvantage", label: "DM: heavy fog" }],
    });
    expect(r.costs).toEqual([]);
  });

  it("weapon: the GM's flat damage counts once on a Critical Hit; extra dice are doubled", () => {
    const r = byHand(
      f,
      {
        type: "attack",
        attack: "Greatsword",
        dm: {
          damage_modifiers: [{ value: 2, label: "DM" }],
          damage_bonus_dice: [{ dice: "1d4", type: "necrotic", label: "DM" }],
        },
      },
      [20, 3, 5, 2, 6, 2, 4],
    );
    const a = r.rolls.attacks[0] as AttackDice;
    expect(a.critical_hit).toBe(true);
    expect(a.damage?.parts.map((p) => [p.rolls, p.bonus, p.critical_from])).toEqual([
      [[3, 5, 2, 6], 5, 2],
      [[2, 4], 0, 1],
    ]);
    expect(a.damage?.total).toBe(3 + 5 + 2 + 6 + 5 + 2 + 4);
  });

  it("spell: the GM's Advantage now reaches a spell attack by hand; attack-roll additions on a save spell are refused", () => {
    const w = wizard();
    const r = byHand(
      w,
      {
        type: "cast",
        spell: "ray-of-sickness",
        dm: { modes: [{ mode: "advantage", label: "DM" }] },
      },
      [9, 15, 2, 3],
    );
    expect((r.rolls.attacks[0] as AttackDice).roll).toMatchObject({
      mode: "advantage",
      rolls: [9, 15],
      natural: 15,
    });
    expect(r.costs).toEqual([{ type: "play", action: { type: "spend_slot", level: 1 } }]);
    const b = bard();
    expect(
      code(() =>
        byHand(
          b,
          { type: "cast", spell: "charm-person", dm: { modifiers: [{ value: 1, label: "DM" }] } },
          [],
        ),
      ),
    ).toBe("refusal.dm_roll_not_applicable");
  });

  it("Grapple and Shove say what the save decides (the table's)", () => {
    const g = byHand(f, { type: "unarmed", option: "grapple" }, []);
    const s = byHand(f, { type: "unarmed", option: "shove" }, []);
    expect(g.rolls.save).toEqual({ ability: null, dc: 13 });
    expect(g.messages).toMatchObject([{ code: "unarmed.grapple", params: { dc: 13 } }]);
    expect(s.messages).toMatchObject([{ code: "unarmed.shove", params: { dc: 13 } }]);
    expect(g.costs).toEqual([]);
  });
});

describe("armor without training (D-03)", () => {
  const a = armored();

  it("no spellcasting: by hand refused, the sheet says why, the combatant can't cast", () => {
    expect(code(() => byHand(a, { type: "cast", spell: "acid-splash" }, []))).toBe(
      "refusal.armor_untrained_no_spellcasting",
    );
    const sheet = computePlaySheet(a.build, a.state, srd);
    expect(sheet.armor_untrained).toBe("Chain Mail");
    expect(sheet.spells[0]?.blocked?.message.code).toBe("refusal.armor_untrained_no_spellcasting");
    expect(combatantFromCharacter(a.build, a.state, srd).no_spells).toBe(true);
    const off = act(a.build, a.state, srd, { type: "equip", id: a.mail, equipped: false });
    expect(
      byHand({ ...a, state: off }, { type: "cast", spell: "acid-splash" }, [3, 4]).rolls.save,
    ).toMatchObject({ ability: "dex" });
    expect(computePlaySheet(a.build, off, srd).spells[0]?.blocked).toBeNull();
  });

  it("Disadvantage on Strength and Dexterity D20 Tests, not on others", () => {
    const mode = (request: Parameters<typeof rollCheck>[3]) =>
      rollCheck(a.build, a.state, srd, request, { rng: scriptedRng([15, 4]) }).roll.mode;
    expect(mode({ skill: "acrobatics" })).toBe("disadvantage");
    expect(mode({ skill: "athletics" })).toBe("disadvantage");
    expect(mode({ save: "dex" })).toBe("disadvantage");
    expect(mode({ initiative: true })).toBe("disadvantage");
    expect(mode({ save: "con" })).toBe("normal");
    expect(mode({ skill: "arcana" })).toBe("normal");
    const r = rollCheck(
      a.build,
      a.state,
      srd,
      { skill: "acrobatics" },
      { rng: scriptedRng([15, 4]) },
    );
    expect(r.reasons).toEqual(["Disadvantage: Syn Wizard wears Chain Mail without training"]);
  });
});

describe("contract examples X1–X12 on the engine (rolls changed afterwards)", () => {
  const f = fighter();
  const w = wizard();
  const attack = (dice: number[]) =>
    byHand(f, { type: "attack", attack: "Greatsword" }, dice).rolls.attacks[0] as AttackDice;

  it("X1: a floor unused at first (15), Heroic → 3: counted as 10", () => {
    const t = bard(cat);
    const r = rollCheck(t.build, t.state, cat, { skill: "persuasion" }, { rng: scriptedRng([15]) });
    expect(r.bonus).toBe(3);
    const x = rerollDie({ kind: "d20", roll: r, die: 0 }, { value: 3 });
    expect(x.roll).toMatchObject({ rolls: [3], natural: 3, d20: 10 });
    expect(x.floors).toEqual([{ label: "Test Tongue", from: 3, to: 10 }]);
    expect(x.total).toBe(13);
  });

  it("X2: Champion 12 → 19 is a Critical Hit: the rolled dice stay, one more set is added", () => {
    const x = rerollDie(
      { kind: "d20", roll: attack([12, 3, 5]), die: 0 },
      { value: 19 },
      { values: [2, 6] },
    );
    expect(x).toMatchObject({ total: 24, critical_hit: true });
    expect(x.roll.natural).toBe(19);
    expect(x.damage).toMatchObject({
      critical: true,
      total: 19,
      parts: [{ rolls: [3, 5, 2, 6], critical_from: 2, total: 19 }],
    });
  });

  it("X3: a natural 20 rerolled to 7: the added set is dropped, nothing rerolled", () => {
    const x = rerollDie({ kind: "d20", roll: attack([20, 3, 5, 2, 6]), die: 0 }, { value: 7 });
    expect(x).toMatchObject({ total: 12, critical_hit: false });
    expect(x.damage?.parts[0]).toEqual({
      dice: "2d6",
      bonus: 3,
      type: "slashing",
      rolls: [3, 5],
      total: 11,
    });
    expect(x.damage?.total).toBe(11);
  });

  const dmAttack = () =>
    byHand(
      f,
      {
        type: "attack",
        attack: "Greatsword",
        dm: {
          modes: [{ mode: "disadvantage", label: "DM: heavy fog" }],
          modifiers: [{ value: -2, label: "DM" }],
          bonus_dice: [{ dice: "1d4", label: "Bless" }],
          damage_bonus_dice: [{ dice: "1d4", type: "necrotic", label: "DM" }],
        },
      },
      [17, 4, 3, 3, 5, 2],
    ).rolls.attacks[0] as AttackDice;

  it("X4: late Advantage on GM Disadvantage: normal, the first die kept, damage unchanged", () => {
    const before = dmAttack();
    expect([before.roll.rolls, before.roll.natural, before.total, before.damage?.total]).toEqual([
      [17, 4],
      4,
      10,
      13,
    ]);
    const x = addAdvantageDie(before, null, "Test Luck");
    expect(x.roll).toMatchObject({ mode: "normal", kept: 0, natural: 17 });
    expect(x).toMatchObject({ total: 23, critical_hit: false });
    expect(x.damage?.total).toBe(13);
    expect(x.reasons.at(-1)).toBe("Advantage: Test Luck");
  });

  it("X5: late Advantage on a normal attack: a second d20 (19) kept → Critical Hit", () => {
    const x = addAdvantageDie(attack([12, 3, 5]), { value: 19 }, "Test Luck", { values: [2, 6] });
    expect(x.roll).toMatchObject({ mode: "advantage", rolls: [12, 19], kept: 1, natural: 19 });
    expect(x).toMatchObject({ total: 24, critical_hit: true });
    expect(x.damage?.total).toBe(19);
  });

  const ray = () => {
    const r = byHand(w, { type: "cast", spell: "ray-of-sickness" }, [9, 2, 3]);
    return { r, attack: r.rolls.attacks[0] as AttackDice, paid: pay(w, r) };
  };

  it("X6: a paid spell attack 9 → 19 isn't a Critical Hit (spells: 20); the slot stays spent once", () => {
    const { r, attack: a, paid } = ray();
    expect(r.costs).toEqual([{ type: "play", action: { type: "spend_slot", level: 1 } }]);
    expect(paid.spell_slots_spent).toEqual([1]);
    expect(a.resolution.critical_on).toBe(20);
    const x = rerollDie({ kind: "d20", roll: a, die: 0 }, { value: 19 });
    expect(x).toMatchObject({ total: 23, critical_hit: false });
    expect(x.damage?.total).toBe(5);
    const after = applyAction(w.build, paid, srd, { type: "spend_inspiration" }).state;
    expect(after.spell_slots_spent).toEqual([1]);
    expect(after.heroic_inspiration).toBe(false);
  });

  it("X7: 9 → 20: Critical Hit, 2d8 gains one set, no second slot", () => {
    const { attack: a } = ray();
    const x = rerollDie({ kind: "d20", roll: a, die: 0 }, { value: 20 }, { values: [7, 8] });
    expect(x).toMatchObject({ total: 24, critical_hit: true });
    expect(x.damage).toMatchObject({
      critical: true,
      total: 20,
      parts: [{ rolls: [2, 3, 7, 8], critical_from: 2 }],
    });
  });

  it("X8: a die of a Critical Hit's added set", () => {
    const x = rerollDie(
      { kind: "damage", roll: attack([20, 3, 5, 2, 6]), part: 0, die: 3 },
      { value: 1 },
    );
    expect(x.damage).toMatchObject({
      critical: true,
      total: 14,
      parts: [{ rolls: [3, 5, 2, 1], critical_from: 2, total: 14 }],
    });
  });

  it("X9: a bonus die (Bless 1d4) of an attack roll", () => {
    const x = rerollDie({ kind: "bonus_die", roll: dmAttack(), group: 0, die: 0 }, { value: 1 });
    expect(x.total).toBe(8);
    expect(x.bonus_dice).toEqual([{ label: "Bless", dice: "1d4", sign: 1, rolls: [1], total: 1 }]);
  });

  it("X10: a feature's die (a pack's die feature) 2 → 7: the use isn't spent again", () => {
    const t = bard(cat);
    const r = byHand(t, { type: "feature", feature: "species:human:test-taunt" }, [2], cat);
    const x = rerollDie({ kind: "single", roll: r.rolls.die as never, die: 0 }, { value: 7 });
    expect(x).toMatchObject({ rolls: [7], total: 7 });
    expect(pay(t, r, cat).uses_spent["species:human:test-spur"]).toBe(1);
  });

  it("X11: a Hit Die rolled in a rest dialog 1 → 8, then one Short Rest with it", () => {
    const x = rerollDie(
      { kind: "single", roll: roll("1d10", scriptedRng([1])), die: 0 },
      { value: 8 },
    );
    expect(x.total).toBe(8);
    const rested = act(f.build, f.state, srd, {
      type: "short_rest",
      hit_dice: [{ die: 10, roll: x.total }],
    });
    expect(computePlaySheet(f.build, rested, srd).play.hp.current).toBe(22);
  });

  it("X12: refusals: Luck on Advantage, modes that cancel, a value out of range, an automatic failure", () => {
    const adv = addAdvantageDie(attack([12, 3, 5]), { value: 19 }, "Test Luck", { values: [2, 6] });
    expect(code(() => addAdvantageDie(adv, { value: 3 }, "Test Luck"))).toBe(
      "refusal.roll_not_applicable",
    );
    const poisoned = act(f.build, f.state, srd, { type: "add_condition", condition: "poisoned" });
    const cancelled = rollCheck(
      f.build,
      poisoned,
      srd,
      { skill: "athletics" },
      { rng: scriptedRng([9]), mode: "advantage" },
    );
    expect(code(() => addAdvantageDie(cancelled, { value: 3 }, "Test Luck"))).toBe(
      "refusal.roll_not_applicable",
    );
    expect(
      code(() => rerollDie({ kind: "d20", roll: attack([12, 3, 5]), die: 0 }, { value: 21 })),
    ).toBe("refusal.roll_between");
    const paralyzed = act(f.build, f.state, srd, { type: "add_condition", condition: "paralyzed" });
    const failed = rollCheck(f.build, paralyzed, srd, { save: "dex" }, { rng: scriptedRng([]) });
    expect(failed.automatic_failure).not.toBeNull();
    expect(code(() => rerollDie({ kind: "d20", roll: failed, die: 0 }, { value: 5 }))).toBe(
      "refusal.roll_not_applicable",
    );
    expect(
      code(() => rerollDie({ kind: "d20", roll: attack([12, 3, 5]), die: 1 }, { value: 5 })),
    ).toBe("refusal.reroll_die_unknown");
    // A new Critical Hit without its dice is refused, not invented.
    expect(
      code(() => rerollDie({ kind: "d20", roll: attack([12, 3, 5]), die: 0 }, { value: 19 })),
    ).toBe("refusal.dice_missing");
  });

  it("other dice never change; setCritical adds or drops only the second set", () => {
    const a = attack([12, 3, 5]);
    const crit = setCritical(a, true, { values: [6, 6] });
    expect(crit.damage?.parts[0]).toMatchObject({
      rolls: [3, 5, 6, 6],
      critical_from: 2,
      total: 23,
    });
    expect(crit.roll).toEqual(a.roll);
    const back = setCritical(crit, false, { values: [] });
    expect(back.damage).toEqual(a.damage);
    const damageOnly = rerollDie({ kind: "damage", roll: a, part: 0, die: 0 }, { value: 6 });
    expect(damageOnly.roll).toEqual(a.roll);
    expect(damageOnly.damage?.parts[0]?.rolls).toEqual([6, 5]);
  });
});

describe("compatibility (N2) and each document's catalog (N6)", () => {
  it("the bundled SRD has no new field: Font of Inspiration and free casts come from packs", () => {
    const bard5 = srd.classes.bard?.features["5"];
    expect(bard5?.actions ?? []).toEqual([]);
    expect("free_casts" in (srd.feats["magic-initiate"]?.grants ?? {})).toBe(false);
  });

  it("old content parses to the same objects: no new key is added", () => {
    const action = FeatureActionSchema.parse({ id: "x", name: "X", economy: "free" });
    expect(["restores", "slot_payment", "roll"].some((k) => k in action)).toBe(false);
    expect(
      "spend_for" in ResourceSchema.parse({ id: "x", name: "X", max: {}, recharge: "long" }),
    ).toBe(false);
    const grants = GrantsSchema.parse({});
    expect("free_casts" in grants || "d20_floors" in grants).toBe(false);
  });

  it("saved states parse to themselves; the new actions don't add fields to states", () => {
    const f = fighter();
    expect(parseState(JSON.parse(JSON.stringify(f.state)))).toEqual(f.state);
    const b = bard(cat);
    const after = act(b.build, b.state, cat, {
      type: "use_feature",
      key: "bard:font-of-inspiration",
      payment: { type: "slot", level: 2 },
    });
    expect(Object.keys(after).sort()).toEqual(Object.keys(b.state).sort());
  });

  it("a character's own catalog decides: the pack's feature by hand, alone and in an encounter on SRD", () => {
    const t = bard(cat);
    expect(
      code(() => byHand(t, { type: "feature", feature: "species:human:test-taunt" }, [2], srd)),
    ).toBe("refusal.no_feature");
    const characters = { syn: { build: t.build, state: t.state, catalog: cat } };
    const ctx = { catalog: srd, characters, rng: scriptedRng([]) };
    let encounter: Encounter = applyEncounterAction(
      createEncounter(),
      { type: "add_character", character: "syn", side: "party" },
      ctx,
    ).encounter;
    const id = encounter.combatants[0]?.id as string;
    for (const action of [
      { type: "set_initiative", id, value: 10 },
      { type: "start" },
    ] as EncounterAction[]) {
      encounter = applyEncounterAction(encounter, action, ctx).encounter;
    }
    const r = applyEncounterAction(
      encounter,
      { type: "roll", id, what: { type: "feature", feature: "species:human:test-taunt" } },
      { catalog: srd, characters, rng: scriptedRng([5]) },
    );
    expect((r.result as DeclaredResult).rolls.die).toMatchObject({ rolls: [5] });
  });
});

describe("what the contract relies on stays (C01–C14)", () => {
  const b = bard();
  const f = fighter();

  it("a slot cast is paid once with its save's DC; an upcast with Concentration; a cantrip costs nothing", () => {
    const charm = byHand(b, { type: "cast", spell: "charm-person" }, []);
    expect(charm.costs).toEqual([{ type: "play", action: { type: "spend_slot", level: 1 } }]);
    expect(charm.rolls.save).toEqual({ ability: "wis", dc: 13 });
    expect(byHand(b, { type: "cast", spell: "bless", slot_level: 2 }, []).costs).toEqual([
      { type: "play", action: { type: "spend_slot", level: 2 } },
      { type: "play", action: { type: "set_concentration", spell: "Bless" } },
    ]);
    expect(byHand(b, { type: "cast", spell: "light" }, []).costs).toEqual([]);
    expect(byHand(b, { type: "cast", spell: "command" }, []).messages.map((m) => m.code)).toContain(
      "spell.manual",
    );
  });

  it("one Short Rest with two Hit Dice regains a short-rest use once; two rests regain it twice", () => {
    const one = act(f.build, f.state, srd, {
      type: "short_rest",
      hit_dice: [
        { die: 10, roll: 1 },
        { die: 10, roll: 2 },
      ],
    });
    expect(one.uses_spent["fighter:second-wind"]).toBe(1);
    const two = act(
      f.build,
      f.state,
      srd,
      { type: "short_rest", hit_dice: [{ die: 10, roll: 1 }] },
      { type: "short_rest", hit_dice: [{ die: 10, roll: 2 }] },
    );
    expect(two.uses_spent["fighter:second-wind"] ?? 0).toBe(0);
  });

  it("a weapon attack by hand without a target: d20, bonus and damage at once, a natural 20 doubles the dice", () => {
    const a = byHand(f, { type: "attack", attack: "Greatsword" }, [20, 3, 5, 2, 6]).rolls
      .attacks[0] as AttackDice;
    expect([a.roll.d20, a.total, a.critical_hit, a.damage?.total]).toEqual([20, 25, true, 19]);
    const unarmed = computePlaySheet(f.build, f.state, srd).attacks.find(
      (x) => x.name === "Unarmed Strike",
    );
    expect([unarmed?.attack_bonus, unarmed?.damage]).toEqual([5, "4"]);
  });
});

describe("armor without training in an encounter (D-03)", () => {
  it("Initiative rolled in the encounter has Disadvantage too; a cast in turns is refused", () => {
    const a = armored();
    const characters = { syn: { build: a.build, state: a.state } };
    let encounter: Encounter = applyEncounterAction(
      createEncounter(),
      { type: "add_character", character: "syn", side: "party" },
      { catalog: srd, characters, rng: scriptedRng([]) },
    ).encounter;
    const id = encounter.combatants[0]?.id as string;
    const rolled = applyEncounterAction(
      encounter,
      { type: "roll_initiative" },
      { catalog: srd, characters, rng: scriptedRng([15, 4]) },
    );
    encounter = rolled.encounter;
    const bonus = computePlaySheet(a.build, a.state, srd).initiative.total;
    expect(encounter.combatants.find((c) => c.id === id)?.initiative).toBe(4 + bonus);
    encounter = applyEncounterAction(
      encounter,
      { type: "start" },
      { catalog: srd, characters, rng: scriptedRng([]) },
    ).encounter;
    expect(() =>
      applyEncounterAction(
        encounter,
        { type: "roll", id, what: { type: "cast", spell: "acid-splash" } },
        { catalog: srd, characters, rng: scriptedRng([5, 3]) },
      ),
    ).toThrow(/without training/);
  });
});
