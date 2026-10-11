import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyEncounterAction,
  builder,
  type CharacterBuild,
  type CharacterState,
  type CombatantOptions,
  checkAction,
  combatantFromCharacter,
  combatantFromMonster,
  combatantOptions,
  computePlaySheet,
  createEncounter,
  createHistory,
  createState,
  type D20TestResult,
  type DeclaredResult,
  type Encounter,
  type EncounterAction,
  EncounterActionSchema,
  EncounterError,
  lookup,
  type MonsterDef,
  type OptionEntry,
  parseEncounter,
  type RollWhat,
  recordAction,
  rollByHand,
  scriptedRng,
  undoAction,
} from "../src/index";
import { autocomplete, catalog, classBuild, fighterBuild, levelUpIn } from "./helpers";

// Rolling by hand is a dice roller (`roll`): no target, no action economy, no outcome; the
// actor's resources are checked and spent (slots, uses, daily uses, Recharge, Concentration) and
// its dice rolled. The table applies what happens.

/** A level 5 Wizard with Fireball, Scorching Ray, Fly and Haste prepared. */
function wizard(): CharacterBuild {
  let b = levelUpIn(autocomplete(classBuild("wizard", { name: "Ilse" })), "wizard", 4);
  b = builder.setChoice(b, catalog, "class:wizard:5#spellbook", ["fly", "haste"]).build;
  const third = b.choices["class:wizard:3#spellbook"] ?? [];
  const other = third.find((x) => x !== "scorching-ray") as string;
  b = builder.setChoice(b, catalog, "class:wizard:3#spellbook", ["scorching-ray", other]).build;
  const prepared = b.choices["class:wizard#prepared"] ?? [];
  const picks = ["fireball", "fly", "haste", "scorching-ray"];
  const rest = prepared.filter((x) => !picks.includes(x)).slice(0, prepared.length - picks.length);
  return builder.setChoice(b, catalog, "class:wizard#prepared", [...picks, ...rest]).build;
}

/** One character first in the order, then monsters; started. */
function session(key: string, build: CharacterBuild, monsters: string[]) {
  let encounter: Encounter = createEncounter();
  let state: CharacterState = createState(build, catalog);
  const ctx = () => ({ catalog, characters: { [key]: { build, state } } });
  const ids = [key, ...monsters.map((m, i) => (monsters.indexOf(m) === i ? m : `${m}-2`))];
  for (const action of [
    { type: "add_character", character: key, side: "party" },
    ...monsters.map((monster) => ({ type: "add_monster", monster, side: "enemies" })),
    ...ids.map((id, i) => ({ type: "set_initiative", id, value: 20 - i })),
    { type: "start" },
  ] as EncounterAction[]) {
    encounter = applyEncounterAction(encounter, action, {
      ...ctx(),
      rng: scriptedRng([]),
    }).encounter;
  }
  let history = createHistory(encounter, { [key]: state });
  const act = (rolls: number[], action: EncounterAction) => {
    const r = applyEncounterAction(encounter, action, { ...ctx(), rng: scriptedRng(rolls) });
    encounter = r.encounter;
    state = r.states[key] ?? state;
    history = recordAction(history, action, r);
    return r;
  };
  return {
    act,
    ctx,
    encounter: () => encounter,
    state: () => state,
    history: () => history,
    sheet: () => computePlaySheet(build, state, catalog),
    get: (id: string) => encounter.combatants.find((c) => c.id === id),
  };
}

const declared = (r: { result: unknown }) => r.result as DeclaredResult;
/** The `roll` action: `what` rolled by hand for combatant `id`. */
const roll = (id: string, what: RollWhat): EncounterAction => ({ type: "roll", id, what });
const greatsword = roll("brakka", { type: "attack", attack: "Greatsword" });
const slots = (s: ReturnType<typeof session>, level: number) =>
  s.sheet().play.spell_slots.find((x) => x.level === level)?.spent;

describe("rolling by hand: a dice roller", () => {
  it("an attack without a target rolls the d20 and the damage, as often as it's asked", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"]);
    const before = s.encounter();
    for (let i = 0; i < 3; i++) {
      const r = s.act([15, 3, 4], greatsword);
      expect(r.rolls).toEqual([15, 3, 4]);
      expect(declared(r)).toEqual({
        manual: true,
        by: "brakka",
        action: "attack",
        name: "Greatsword",
        slot_level: null,
        rolls: {
          attacks: [
            {
              attack: "Greatsword",
              roll: { rolls: [15], d20: 15, mode: "normal" },
              bonus: 5,
              total: 20,
              critical_hit: false,
              critical_miss: false,
              reasons: [],
              reason_messages: [],
              damage: {
                parts: [{ dice: "2d6", bonus: 3, type: "slashing", rolls: [3, 4], total: 10 }],
                total: 10,
                critical: false,
              },
              riders: [],
            },
          ],
          damage: null,
          healing: null,
          save: null,
        },
      } satisfies DeclaredResult);
      expect(r.notes).toEqual([
        "Brakka uses Greatsword, by hand.",
        "Greatsword attack roll: 20 (15 on the die).",
        "Greatsword damage rolled: 10 slashing (3 + 4).",
      ]);
    }
    // Nothing else changed: no economy spent, no HP.
    expect(s.encounter()).toEqual(before);
  });

  it("a natural 20 doubles the damage dice; a Poisoned attacker has Disadvantage", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"]);
    const [crit] = declared(s.act([20, 1, 2, 3, 4], greatsword)).rolls.attacks;
    expect(crit).toMatchObject({ critical_hit: true, damage: { critical: true, total: 13 } });
    expect(crit?.damage?.parts[0]?.rolls).toEqual([1, 2, 3, 4]);
    s.act([], {
      type: "effects",
      id: "brakka",
      actions: [{ type: "add_condition", condition: "poisoned" }],
    });
    const r = s.act([15, 4, 3, 4], greatsword);
    const [poisoned] = declared(r).rolls.attacks;
    expect(poisoned?.roll).toEqual({ rolls: [15, 4], d20: 4, mode: "disadvantage" });
    expect(poisoned?.reasons).toEqual(["Disadvantage: Brakka is Poisoned"]);
    expect(r.notes[1]).toBe(
      "Greatsword attack roll: 9 (4 on the die); Disadvantage: Brakka is Poisoned.",
    );
  });

  it("Scorching Ray at level 3: four rays, each with 2d6 fire; the slot is spent", () => {
    const s = session("ilse", wizard(), ["goblin-warrior"]);
    const ray = roll("ilse", { type: "cast", spell: "scorching-ray", slot_level: 3 });
    const dice = [10, 1, 2, 11, 3, 4, 12, 5, 6, 13, 1, 1];
    const r = declared(s.act(dice, ray));
    expect(r.slot_level).toBe(3);
    expect(r.rolls.attacks.map((a) => [a.roll.d20, a.damage?.total])).toEqual([
      [10, 3],
      [11, 7],
      [12, 11],
      [13, 2],
    ]);
    expect(r.rolls.attacks[0]?.damage?.parts[0]).toMatchObject({ dice: "2d6", type: "fire" });
    expect(slots(s, 3)).toBe(1);
    // Two 3rd-level slots at level 5: the third cast has none left.
    s.act(dice, ray);
    try {
      s.act(dice, ray);
      expect.unreachable();
    } catch (error) {
      if (!(error instanceof EncounterError)) throw error;
      expect(error.messages).toEqual(["Ilse: No level 3 spell slots left"]);
      expect(error.codes).toEqual(["no_resources"]);
    }
    // The GM can still force it: cast, no slot spent.
    const forced = declared(s.act(dice, { ...ray, force: true } as EncounterAction));
    expect(forced.rolls.attacks).toHaveLength(4);
    expect(slots(s, 3)).toBe(2);
  });

  it("Fireball rolls 8d6 once and shows the DC; no saves, no area, no HP changed", () => {
    const s = session("ilse", wizard(), ["goblin-warrior"]);
    const eight = [1, 2, 3, 4, 5, 6, 1, 2];
    const r = s.act(eight, roll("ilse", { type: "cast", spell: "fireball" }));
    expect(r.rolls).toEqual(eight);
    const { rolls } = declared(r);
    expect(rolls.save).toEqual({ ability: "dex", dc: s.sheet().spellcasting[0]?.save_dc });
    expect(rolls.damage?.parts[0]).toMatchObject({ dice: "8d6", type: "fire", total: 24 });
    expect(rolls.attacks).toEqual([]);
    expect(r.notes).toEqual([
      "Ilse uses Fireball at level 3, by hand.",
      `Fireball: DC ${rolls.save?.dc} Dexterity saving throw.`,
      "Fireball damage rolled: 24 fire (1 + 2 + 3 + 4 + 5 + 6 + 1 + 2).",
    ]);
    expect(s.get("goblin-warrior")?.hp).toBe(10);
    expect(slots(s, 3)).toBe(1);
    expect(s.get("ilse")?.used.action).toBe(false);
  });

  it("a Concentration spell starts Concentration and replaces the previous one", () => {
    const s = session("ilse", wizard(), ["goblin-warrior"]);
    s.act([], roll("ilse", { type: "cast", spell: "fly" }));
    expect(s.state().concentration).toBe("Fly");
    s.act([], roll("ilse", { type: "cast", spell: "haste" }));
    expect(s.state().concentration).toBe("Haste");
  });

  it("Second Wind rolls its healing and spends a use; out of uses, it's refused", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"]);
    const wind = roll("brakka", { type: "feature", feature: "Second Wind" });
    const uses = s.sheet().play.uses.find((u) => u.key.endsWith(":second-wind"))?.max ?? 0;
    expect(uses).toBeGreaterThan(0);
    for (let i = 0; i < uses; i++) {
      const r = s.act([7], wind);
      expect(declared(r).rolls.healing).toBe(8);
      expect(r.notes).toContain("Second Wind healing rolled: 8.");
    }
    expect(() => s.act([7], wind)).toThrow(EncounterError);
    expect(s.get("brakka")?.used.bonus_action).toBe(false);
    expect(s.state().hp.current).toBeNull();
  });

  it("a monster's 1/Day spell and its Recharge breath: spent, rolled, refused when gone", () => {
    const s = session("brakka", fighterBuild(), ["adult-black-dragon", "adult-red-dragon"]);
    const sphere = roll("adult-black-dragon", { type: "cast", spell: "vitriolic-sphere" });
    // Its effects are text in the SRD data: nothing to roll, the daily use spent.
    const r = s.act([], sphere);
    expect(declared(r).rolls).toEqual({ attacks: [], damage: null, healing: null, save: null });
    expect(r.messages.map((m) => m.code)).toContain("spell.manual");
    expect(s.get("adult-black-dragon")?.daily_used).toEqual({
      "Spellcasting#vitriolic-sphere": 1,
    });
    expect(() => s.act([], sphere)).toThrow("1 time today");
    const breath = roll("adult-red-dragon", { type: "save_action", ability: "Fire Breath" });
    const fire = declared(s.act(Array<number>(17).fill(2), breath));
    expect(fire.rolls.save).toEqual({ ability: "dex", dc: 21 });
    expect(fire.rolls.damage?.parts[0]).toMatchObject({ dice: "17d6", total: 34 });
    expect(s.get("adult-red-dragon")?.expended).toEqual(["Fire Breath"]);
    expect(() => s.act([], breath)).toThrow("hasn't recharged");
  });

  it("Grapple by hand shows the DC; a legendary attack rolls without spending uses", () => {
    const s = session("brakka", fighterBuild(), ["adult-blue-dragon"]);
    const grapple = declared(s.act([], roll("brakka", { type: "unarmed", option: "grapple" })));
    expect(grapple.rolls.save).toEqual({ ability: null, dc: 13 });
    const tail = roll("adult-blue-dragon", { type: "legendary", action: "Tail Swipe" });
    for (let i = 0; i < 4; i++) {
      const [rend] = declared(s.act(Array<number>(9).fill(1), tail)).rolls.attacks;
      expect(rend?.attack).toBe("Rend");
    }
    expect(s.get("adult-blue-dragon")?.legendary_used).toBe(0);
  });

  it("checkAction agrees; undo gives the slot back", () => {
    const s = session("ilse", wizard(), ["goblin-warrior"]);
    const fireball = roll("ilse", { type: "cast", spell: "fireball" });
    expect(checkAction(s.encounter(), fireball, s.ctx()).ok).toBe(true);
    s.act(Array<number>(8).fill(1), fireball);
    expect(slots(s, 3)).toBe(1);
    const undone = undoAction(s.history(), s.ctx());
    expect(undone.states.ilse?.spell_slots_spent ?? []).toEqual([]);
  });
});

describe("options: every reason, with its category, and rollable", () => {
  const every = (o: CombatantOptions): OptionEntry[] => [
    ...o.attacks,
    ...o.spells,
    ...o.features,
    ...o.save_actions,
    ...o.legendary,
    ...o.standard,
    ...o.zones,
  ];
  const options = (s: ReturnType<typeof session>, id: string) =>
    combatantOptions(s.encounter(), id, s.ctx());

  it("the Attack action spent: refused for economy, still rollable, and the roll is taken", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"]);
    s.act([2, 1, 1], {
      type: "attack",
      id: "brakka",
      target: "goblin-warrior",
      attack: "Greatsword",
    });
    const sword = options(s, "brakka").attacks.find(
      (x) => x.action.type === "attack" && x.action.attack === "Greatsword" && !x.action.granted,
    );
    expect(sword?.available).toBe(false);
    expect(sword?.rollable).toBe(true);
    expect(sword?.reasons.map((r) => r.category)).toEqual(["economy"]);
    expect(sword?.reasons[0]?.message.text).toBe(sword?.reasons[0]?.text);
    expect(declared(s.act([15, 3, 4], greatsword)).rolls.attacks).toHaveLength(1);
  });

  it("Fireball with no level 3 slot and the action spent: both reasons, each categorized", () => {
    const s = session("ilse", wizard(), ["goblin-warrior"]);
    const fireball = roll("ilse", { type: "cast", spell: "fireball" });
    s.act(Array<number>(8).fill(1), fireball);
    s.act(Array<number>(8).fill(1), fireball);
    s.act([], { type: "dash", id: "ilse" });
    const entries = options(s, "ilse").spells.filter(
      (x) => x.action.type === "cast" && x.action.spell === "fireball",
    );
    expect(entries.length).toBeGreaterThan(0);
    const third = entries.find((x) => x.action.type === "cast" && !x.action.slot_level);
    const option = third ?? (entries[0] as OptionEntry);
    expect(option.available).toBe(false);
    expect(option.rollable).toBe(true);
    const reasons = option.reasons.map((r) => [r.code, r.category]);
    expect(reasons).toContainEqual(["economy_used", "economy"]);
    expect(reasons).toContainEqual(["no_resources", "resource"]);
    // By hand, the slot stops it (unless forced).
    expect(() => s.act(Array<number>(8).fill(1), fireball)).toThrow("No level 3 spell slots");
  });

  it("an Incapacitated actor: every rollable option has the `state` reason", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"]);
    s.act([], {
      type: "effects",
      id: "brakka",
      actions: [{ type: "add_condition", condition: "incapacitated" }],
    });
    const rollable = every(options(s, "brakka")).filter((x) => x.rollable);
    expect(rollable.length).toBeGreaterThan(0);
    for (const x of rollable) {
      expect(x.reasons).toContainEqual(
        expect.objectContaining({ code: "incapacitated", category: "state" }),
      );
    }
  });

  it("Dash isn't rollable; an attack and a feature are", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"]);
    const o = options(s, "brakka");
    expect(o.standard.find((x) => x.action.type === "dash")?.rollable).toBe(false);
    expect(o.attacks.every((x) => x.rollable)).toBe(true);
    expect(o.features.find((x) => x.label.startsWith("Second Wind"))?.rollable).toBe(true);
  });

  it("checkAction with force lists what it overrode before what stopped it", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"]);
    const far = {
      type: "attack",
      id: "goblin-warrior",
      target: "brakka",
      attack: "Scimitar",
      force: true,
    } as EncounterAction;
    s.act([], {
      type: "effects",
      id: "goblin-warrior",
      actions: [{ type: "add_condition", condition: "incapacitated" }],
    });
    const check = checkAction(s.encounter(), far, s.ctx());
    expect(check.ok).toBe(true);
    expect(check.override_codes).toEqual(
      expect.arrayContaining(["not_your_turn", "incapacitated"]),
    );
  });
});

describe("rollByHand: no encounter needed", () => {
  it("a character's Fireball on the sheet: the dice, and its slot as a cost to apply", () => {
    const build = wizard();
    let state = createState(build, catalog);
    const ilse = combatantFromCharacter(build, state, catalog);
    const eight = [1, 2, 3, 4, 5, 6, 1, 2];
    const r = rollByHand(
      ilse,
      { type: "cast", spell: "fireball" },
      { catalog, character: { build, state }, rng: scriptedRng(eight) },
    );
    expect(r).toMatchObject({ action: "cast", name: "Fireball", slot_level: 3 });
    expect(r.rolls.damage?.total).toBe(24);
    expect(r.rolls.save?.ability).toBe("dex");
    expect(r.costs).toEqual([{ type: "play", action: { type: "spend_slot", level: 3 } }]);
    for (const cost of r.costs) {
      if (cost.type === "play") state = applyAction(build, state, catalog, cost.action).state;
    }
    expect(computePlaySheet(build, state, catalog).play.spell_slots[2]?.spent).toBe(1);
  });

  it("a feature needs the character's build and state; a monster's costs come from its stat block", () => {
    const build = fighterBuild();
    const state = createState(build, catalog);
    const brakka = combatantFromCharacter(build, state, catalog);
    const wind = { type: "feature", feature: "Second Wind" } as const;
    expect(() => rollByHand(brakka, wind, { catalog })).toThrow("has no class features");
    const r = rollByHand(brakka, wind, {
      catalog,
      character: { build, state },
      rng: scriptedRng([7]),
    });
    expect(r.rolls.healing).toBe(8);
    expect(r.costs).toEqual([
      {
        type: "play",
        action: { type: "use_feature", key: expect.stringMatching(/second-wind$/), manual: true },
      },
    ]);
    // A monster from its stat block alone: the breath's Recharge, the 1/Day spell's daily use.
    const red = lookup(catalog.monsters, "adult-red-dragon") as MonsterDef;
    const breath = rollByHand(
      combatantFromMonster(red),
      { type: "save_action", ability: "Fire Breath" },
      { catalog, monster: red, rng: scriptedRng(Array<number>(17).fill(2)) },
    );
    expect(breath.rolls.save).toEqual({ ability: "dex", dc: 21 });
    expect(breath.costs).toEqual([{ type: "recharge", name: "Fire Breath" }]);
    const black = lookup(catalog.monsters, "adult-black-dragon") as MonsterDef;
    const sphere = rollByHand(
      combatantFromMonster(black),
      { type: "cast", spell: "vitriolic-sphere" },
      { catalog, monster: black },
    );
    expect(sphere.costs).toEqual([
      { type: "daily", key: "Spellcasting#vitriolic-sphere", per_day: 1, name: "Vitriolic Sphere" },
    ]);
  });
});

describe("a saving throw on demand (check with save)", () => {
  it("rolls a Restrained goblin's Dexterity save with Disadvantage, nothing else changes", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"]);
    s.act([], {
      type: "effects",
      id: "goblin-warrior",
      actions: [{ type: "add_condition", condition: "restrained" }],
    });
    const before = s.encounter();
    const r = s.act([14, 3], { type: "check", id: "goblin-warrior", save: "dex", dc: 15 });
    expect(r.result as D20TestResult).toMatchObject({
      kind: "save",
      ability: "dex",
      roll: { rolls: [14, 3], d20: 3, mode: "disadvantage" },
      dc: 15,
      success: false,
    });
    expect(r.notes[0]).toMatch(
      /^Goblin Warrior's Dexterity saving throw: \d+ vs DC 15; .*: failure\.$/,
    );
    expect(s.encounter()).toEqual(before);
  });

  it("without a DC it shows the total", () => {
    const s = session("brakka", fighterBuild(), ["goblin-warrior"]);
    const r = s.act([10], { type: "check", id: "brakka", save: "str" });
    expect(r.result).toMatchObject({ kind: "save", dc: null, success: null });
    expect(r.notes[0]).toMatch(/^Brakka's Strength saving throw: \d+\.$/);
  });
});

describe("table dice are gone", () => {
  it("an older document drops its dice settings and a pending roll", () => {
    const old = {
      ...createEncounter(),
      dice: "table",
      combatants: [{ id: "x", name: "X", side: "party", dice: "table" }],
      pending: {
        action: { type: "check", id: "x", ability: "str" },
        rolls: [],
        answers: [],
        combatant: "x",
        kind: "roll",
        question: "X: roll 1d20 for Strength check.",
        recommended: false,
      },
    };
    const parsed = parseEncounter(old);
    expect(parsed.pending).toBeNull();
    expect("dice" in parsed).toBe(false);
    expect("dice" in (parsed.combatants[0] ?? {})).toBe(false);
  });

  it("set_dice and enter_roll are unknown actions", () => {
    const parse = (a: unknown) => EncounterActionSchema.safeParse(a).success;
    expect(parse({ type: "set_dice", mode: "table" })).toBe(false);
    expect(parse({ type: "enter_roll", values: [3] })).toBe(false);
  });
});
