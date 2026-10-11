import { describe, expect, it } from "vitest";
import {
  applyAction,
  type CharacterBuild,
  type CharacterState,
  computePlaySheet,
  createBuild,
  createState,
  magicItemBases,
  type PlayAction,
  PlayError,
  parseState,
  playBuild,
  reconcileState,
  resolve,
  scriptedRng,
  seededRng,
  startingEquipment,
  validateState,
} from "../src/index";
import * as svc from "../src/services/builder";
import { autocomplete, catalog, classBuild, fighterBuild, levelUpIn } from "./helpers";

const fighter = fighterBuild(); // Str 17, Con 14, Chain Mail, 12 HP
const act = (b: CharacterBuild, s: CharacterState, ...actions: PlayAction[]) => {
  let state = s;
  const notes: string[] = [];
  for (const a of actions) {
    const r = applyAction(b, state, catalog, a, { rng: scriptedRng([4, 4, 4, 4]) });
    state = r.state;
    notes.push(...r.notes);
  }
  return { state, notes, sheet: computePlaySheet(b, state, catalog) };
};
const itemId = (s: CharacterState, item: string) =>
  s.inventory.find((i) => i.item === item)?.id as string;

describe("a new state", () => {
  const state = createState(fighter, catalog);
  const sheet = computePlaySheet(fighter, state, catalog);

  it("starts at full HP with the starting equipment, wearing the armor", () => {
    expect(sheet.play.hp).toEqual({ current: 12, max: 12, temp: 0, bloodied: false });
    expect(state.inventory.find((i) => i.item === "chain-mail")?.equipped).toBe(true);
    expect(state.inventory.find((i) => i.item === "greatsword")?.equipped).toBe(false);
    expect(state.currency.gp).toBe(sheet.gp);
    expect(sheet.armor_class.total).toBe(17); // Chain Mail 16 + Defense 1
    expect(sheet.play.carrying_capacity).toBe(17 * 15);
    expect(validateState(fighter, state, catalog)).toEqual([]);
  });

  it("taking the armor off changes AC", () => {
    const { sheet: s } = act(fighter, state, {
      type: "equip",
      id: itemId(state, "chain-mail"),
      equipped: false,
    });
    expect(s.armor_class.total).toBe(12); // 10 + Dex 2
  });
});

describe("starting equipment taken later", () => {
  // A state made for a new (empty) build, before its equipment was chosen.
  const early = createState(createBuild(), catalog);

  it("a state made before the build's equipment has none, and offers it", () => {
    expect(early.inventory).toEqual([]);
    expect(early.starting_equipment).toBe(false);
    const sheet = computePlaySheet(fighter, early, catalog);
    expect(sheet.play.starting_equipment_taken).toBe(false);
    const kit = startingEquipment(fighter, catalog);
    expect(kit.items).toContainEqual({ item: "chain-mail", name: "Chain Mail", qty: 1 });
    expect(kit.gp).toBe(sheet.gp);
  });

  it("take_starting_equipment adds it once, wearing the armor, with the gold", () => {
    const { state, notes, sheet } = act(fighter, early, { type: "take_starting_equipment" });
    expect(state.starting_equipment).toBe(true);
    expect(state.inventory.find((i) => i.item === "chain-mail")?.equipped).toBe(true);
    expect(state.currency.gp).toBe(sheet.gp);
    expect(sheet.armor_class.total).toBe(17);
    expect(notes[0]).toMatch(/^Starting equipment added: .*Chain Mail/);
    expect(() => act(fighter, state, { type: "take_starting_equipment" })).toThrow(
      "The starting equipment is already in the inventory",
    );
  });

  it("is refused while the build has no equipment", () => {
    expect(() => act(createBuild(), early, { type: "take_starting_equipment" })).toThrow(
      "The build has no starting equipment yet",
    );
  });

  it("a state saved before the flag counts as taken when it holds items or coins", () => {
    const { starting_equipment: _, ...old } = createState(fighter, catalog);
    expect(parseState(old).starting_equipment).toBe(true);
    expect(parseState({}).starting_equipment).toBe(false);
  });
});

describe("damage, dying and healing", () => {
  const state = createState(fighter, catalog);

  it("temporary HP absorb damage first and don't stack", () => {
    const r = act(
      fighter,
      state,
      { type: "set_temp_hp", amount: 5 },
      { type: "set_temp_hp", amount: 3 },
      { type: "damage", amount: 7 },
    );
    expect(r.notes).toContain("Temporary Hit Points don't stack: keeping 5.");
    expect(r.sheet.play.hp).toEqual({ current: 10, max: 12, temp: 0, bloodied: false });
  });

  it("dropping to 0 makes you Unconscious (and Prone) and dying", () => {
    const r = act(
      fighter,
      state,
      { type: "set_concentration", spell: "Bless" },
      { type: "damage", amount: 15 },
    );
    expect(r.sheet.play.dying).toBe(true);
    expect(r.state.concentration).toBeNull();
    const ids = r.sheet.play.conditions.map((c) => [c.id, c.implied]);
    expect(ids).toEqual(
      expect.arrayContaining([
        ["unconscious", false],
        ["incapacitated", true],
        ["prone", true],
      ]),
    );
    expect(r.sheet.speed.total).toBe(0);
  });

  it("massive damage kills outright", () => {
    expect(act(fighter, state, { type: "damage", amount: 24 }).state.dead).toBe(true);
    expect(act(fighter, state, { type: "damage", amount: 23 }).state.dead).toBe(false);
  });

  it("death saves: a natural 1 counts twice, a natural 20 brings you back", () => {
    const down = act(fighter, state, { type: "damage", amount: 12 }).state;
    const failing = act(
      fighter,
      down,
      { type: "death_save", roll: 1 },
      { type: "death_save", roll: 5 },
    );
    expect(failing.state.dead).toBe(true);
    const back = act(fighter, down, { type: "death_save", roll: 20 });
    expect(back.sheet.play.hp.current).toBe(1);
    expect(back.state.conditions).toEqual(["prone"]);
    const stable = act(
      fighter,
      down,
      { type: "death_save", roll: 10 },
      { type: "death_save", roll: 12 },
      { type: "death_save", roll: 15 },
    );
    expect(stable.state.stable).toBe(true);
  });

  it("damage at 0 HP is a failed death save (two on a critical)", () => {
    const down = act(fighter, state, { type: "damage", amount: 12 }).state;
    expect(act(fighter, down, { type: "damage", amount: 1 }).state.death_saves.failures).toBe(1);
    expect(
      act(fighter, down, { type: "damage", amount: 1, critical: true }).state.death_saves.failures,
    ).toBe(2);
  });

  it("healing a dying character wakes them up", () => {
    const down = act(fighter, state, { type: "damage", amount: 12 }).state;
    const r = act(fighter, down, { type: "heal", amount: 4 });
    expect(r.sheet.play.hp.current).toBe(4);
    expect(r.sheet.play.dying).toBe(false);
    expect(r.state.conditions).not.toContain("unconscious");
  });

  it("concentration asks for a save with the right DC", () => {
    const r = act(
      fighter,
      state,
      { type: "set_concentration", spell: "Bless" },
      { type: "damage", amount: 11 },
    );
    expect(r.notes).toContain("Concentration on Bless: Constitution saving throw, DC 10.");
  });

  it("resistances halve damage", () => {
    let s = act(fighter, state, {
      type: "add_item",
      item: "ring-of-resistance",
      variant: "fire",
    }).state;
    s = act(fighter, s, {
      type: "equip",
      id: itemId(s, "ring-of-resistance"),
      equipped: true,
    }).state;
    expect(
      act(fighter, s, { type: "damage", amount: 9, damage_type: "fire" }).sheet.play.hp.current,
    ).toBe(8);
  });
});

describe("rests", () => {
  const b = levelUpIn(fighter, "fighter", 4); // Fighter 5
  const state = createState(b, catalog);

  it("a Short Rest spends Hit Dice (roll + Con) and recharges short-rest features", () => {
    const hurt = act(
      b,
      state,
      { type: "damage", amount: 20 },
      { type: "use", key: "fighter:action-surge" },
      { type: "use", key: "fighter:second-wind" },
      { type: "use", key: "fighter:second-wind" },
    ).state;
    const r = act(b, hurt, {
      type: "short_rest",
      hit_dice: [
        { die: 10, roll: 6 },
        { die: 10, roll: 1 },
      ],
    });
    const max = r.sheet.play.hp.max;
    expect(r.sheet.play.hp.current).toBe(max - 20 + 8 + 3);
    expect(r.sheet.play.hit_dice).toEqual([{ die: 10, total: 5, spent: 2 }]);
    const uses = Object.fromEntries(r.sheet.play.uses.map((u) => [u.key, u.spent]));
    expect(uses["fighter:action-surge"]).toBe(0);
    expect(uses["fighter:second-wind"]).toBe(1); // Second Wind regains one use on a Short Rest
  });

  it("a Long Rest restores everything and lowers Exhaustion", () => {
    const tired = act(
      b,
      state,
      { type: "damage", amount: 20 },
      { type: "short_rest", hit_dice: [{ die: 10, roll: 5 }] },
      { type: "set_exhaustion", level: 2 },
      { type: "set_temp_hp", amount: 4 },
    ).state;
    const r = act(b, tired, { type: "long_rest" });
    expect(r.sheet.play.hp).toEqual({
      current: r.sheet.play.hp.max,
      max: r.sheet.play.hp.max,
      temp: 0,
      bloodied: false,
    });
    expect(r.state.hit_dice_spent).toEqual({});
    expect(r.state.exhaustion).toBe(1);
    expect(r.state.heroic_inspiration).toBe(true); // Human: Resourceful
  });

  it("needs at least 1 HP", () => {
    const down = act(b, state, { type: "damage", amount: 45 }).state;
    expect(() => act(b, down, { type: "long_rest" })).toThrow(PlayError);
  });

  it("spell slots and Pact Magic", () => {
    const w = levelUpIn(autocomplete(classBuild("warlock")), "warlock", 1);
    let s = createState(w, catalog);
    s = act(w, s, { type: "spend_pact_slot" }, { type: "spend_pact_slot" }).state;
    expect(() => act(w, s, { type: "spend_pact_slot" })).toThrow(/No Pact Magic slots left/);
    expect(act(w, s, { type: "short_rest" }).state.pact_slots_spent).toBe(0);
    const c = levelUpIn(autocomplete(classBuild("cleric")), "cleric", 2);
    let cs = createState(c, catalog);
    cs = act(c, cs, { type: "spend_slot", level: 2 }, { type: "spend_slot", level: 2 }).state;
    expect(() => act(c, cs, { type: "spend_slot", level: 2 })).toThrow(/No level 2/);
    expect(act(c, cs, { type: "short_rest" }).state.spell_slots_spent).toEqual([0, 2]);
    expect(act(c, cs, { type: "long_rest" }).state.spell_slots_spent).toEqual([]);
  });
});

describe("conditions and Exhaustion", () => {
  const state = createState(fighter, catalog);

  it("Exhaustion lowers d20 tests and speed", () => {
    const before = computePlaySheet(fighter, state, catalog);
    const r = act(fighter, state, { type: "set_exhaustion", level: 2 });
    expect(r.sheet.initiative.total).toBe(before.initiative.total - 4);
    expect(r.sheet.speed.total).toBe(before.speed.total - 10);
    expect(act(fighter, state, { type: "set_exhaustion", level: 6 }).state.dead).toBe(true);
  });

  it("Grappled sets speed to 0; Incapacitated ends concentration", () => {
    expect(
      act(fighter, state, { type: "add_condition", condition: "grappled" }).sheet.speed.total,
    ).toBe(0);
    const r = act(
      fighter,
      state,
      { type: "set_concentration", spell: "Bless" },
      { type: "add_condition", condition: "stunned" },
    );
    expect(r.state.concentration).toBeNull();
    expect(() => act(fighter, r.state, { type: "set_concentration", spell: "Bless" })).toThrow(
      /Incapacitated/,
    );
  });
});

describe("magic items", () => {
  const state = createState(fighter, catalog);
  const add = (s: CharacterState, a: Omit<Extract<PlayAction, { type: "add_item" }>, "type">) =>
    act(fighter, s, { type: "add_item", ...a }).state;

  it("a +1 weapon needs a base weapon and improves its attack", () => {
    expect(() => add(state, { item: "weapon-1" })).toThrow(/which weapon/);
    let s = add(state, { item: "weapon-1", base: "longsword" });
    s = add(s, { item: "holy-avenger", base: "longsword" });
    const sheet = computePlaySheet(fighter, s, catalog);
    const bonus = (name: string) => sheet.attacks.find((a) => a.name === name)?.attack_bonus;
    const greatsword = bonus("Greatsword") as number;
    expect(bonus("Longsword, +1")).toBe(greatsword + 1);
    // Holy Avenger's +3 needs Attunement, which only a Paladin can have.
    expect(bonus("Holy Avenger (Longsword)")).toBe(greatsword);
    expect(() =>
      act(fighter, s, { type: "attune", id: itemId(s, "holy-avenger"), attuned: true }),
    ).toThrow(/requires Paladin/);
  });

  it("+1 armor is worn instead of the old armor", () => {
    let s = add(state, { item: "armor-1", base: "plate-armor" });
    const r = act(fighter, s, { type: "equip", id: itemId(s, "armor-1"), equipped: true });
    s = r.state;
    expect(r.notes).toContain("Took off Chain Mail.");
    expect(r.sheet.armor_class.total).toBe(18 + 1 + 1); // Plate 18, +1, Defense
  });

  it("attunement: required for the magic, at most three, with class restrictions", () => {
    let s = add(state, { item: "ring-of-protection" });
    const ring = itemId(s, "ring-of-protection");
    s = act(fighter, s, { type: "equip", id: ring, equipped: true }).state;
    expect(computePlaySheet(fighter, s, catalog).armor_class.total).toBe(17); // not attuned
    s = act(fighter, s, { type: "attune", id: ring, attuned: true }).state;
    expect(computePlaySheet(fighter, s, catalog).armor_class.total).toBe(18);
    for (const item of ["bracers-of-defense", "cloak-of-protection", "gauntlets-of-ogre-power"]) {
      s = add(s, { item });
    }
    s = act(fighter, s, {
      type: "attune",
      id: itemId(s, "bracers-of-defense"),
      attuned: true,
    }).state;
    s = act(fighter, s, {
      type: "attune",
      id: itemId(s, "cloak-of-protection"),
      attuned: true,
    }).state;
    expect(() =>
      act(fighter, s, { type: "attune", id: itemId(s, "gauntlets-of-ogre-power"), attuned: true }),
    ).toThrow(/at most 3/);
    s = add(s, { item: "robe-of-the-archmagi" });
    expect(() =>
      act(fighter, s, { type: "attune", id: itemId(s, "robe-of-the-archmagi"), attuned: false }),
    ).not.toThrow();
    const robe = { type: "attune", id: itemId(s, "robe-of-the-archmagi"), attuned: true } as const;
    s = act(fighter, s, {
      type: "attune",
      id: itemId(s, "cloak-of-protection"),
      attuned: false,
    }).state;
    expect(() => act(fighter, s, robe)).toThrow(/Sorcerer, Warlock, or Wizard/);
  });

  it("Gauntlets of Ogre Power set Strength to 19", () => {
    let s = add(state, { item: "gauntlets-of-ogre-power" });
    const id = itemId(s, "gauntlets-of-ogre-power");
    s = act(
      fighter,
      s,
      { type: "equip", id, equipped: true },
      { type: "attune", id, attuned: true },
    ).state;
    const sheet = computePlaySheet(fighter, s, catalog);
    expect(sheet.scores.str).toBe(19);
    expect(sheet.play.carrying_capacity).toBe(19 * 15);
  });

  it("potions heal and are used up; wands spend charges", () => {
    let s = add(state, { item: "potion-of-healing", qty: 2 });
    s = act(fighter, s, { type: "damage", amount: 10 }).state;
    const r = act(fighter, s, { type: "use_item", id: itemId(s, "potion-of-healing"), roll: 6 });
    expect(r.sheet.play.hp.current).toBe(8);
    expect(r.state.inventory.find((i) => i.item === "potion-of-healing")?.qty).toBe(1);
    let w = add(state, { item: "wand-of-magic-missiles" });
    const wand = itemId(w, "wand-of-magic-missiles");
    w = act(fighter, w, { type: "use_item", id: wand }, { type: "use_item", id: wand }).state;
    expect(
      computePlaySheet(fighter, w, catalog).play.inventory.find((i) => i.id === wand),
    ).toMatchObject({
      charges: 7,
      charges_spent: 2,
    });
  });

  it("currency can't go negative", () => {
    const r = act(fighter, state, { type: "adjust_currency", changes: { gp: -5, sp: 30 } });
    expect(r.state.currency).toMatchObject({ gp: state.currency.gp - 5, sp: 30 });
    expect(() => act(fighter, state, { type: "adjust_currency", changes: { pp: -1 } })).toThrow(
      /Not enough PP/,
    );
  });
});

describe("which items a magic item can be made from", () => {
  const sorted = (ids: string[]) => [...ids].sort();

  it("Weapon, +1: every weapon; Vorpal Sword: its four swords; Trident of Fish Command: one", () => {
    expect(sorted(magicItemBases(catalog, "weapon-1"))).toEqual(
      sorted(Object.keys(catalog.weapons)),
    );
    expect(sorted(magicItemBases(catalog, "vorpal-sword"))).toEqual([
      "glaive",
      "greatsword",
      "longsword",
      "scimitar",
    ]);
    expect(magicItemBases(catalog, "trident-of-fish-command")).toEqual(["trident"]);
  });

  it("Flame Tongue: melee weapons only; ammunition: the five kinds; a shield; none for wondrous items", () => {
    const melee = magicItemBases(catalog, "flame-tongue");
    expect(melee).toContain("longsword");
    expect(melee).not.toContain("longbow");
    expect(sorted(magicItemBases(catalog, "ammunition-1"))).toEqual([
      "arrow",
      "blowgun-needle",
      "crossbow-bolt",
      "firearm-bullet",
      "sling-bullet",
    ]);
    expect(magicItemBases(catalog, "animated-shield")).toEqual(["shield"]);
    expect(magicItemBases(catalog, "bag-of-holding")).toEqual([]);
    expect(magicItemBases(catalog, "nope")).toEqual([]);
  });

  it("add_item accepts exactly those", () => {
    const b = fighterBuild();
    const s = createState(b, catalog);
    expect(() =>
      act(b, s, { type: "add_item", item: "ammunition-1", base: "arrow" }),
    ).not.toThrow();
    expect(() => act(b, s, { type: "add_item", item: "ammunition-1", base: "rope" })).toThrow(
      PlayError,
    );
  });
});

describe("today's prepared spells", () => {
  const c = levelUpIn(autocomplete(classBuild("cleric")), "cleric", 4); // Cleric 5
  const key = "class:cleric#prepared";
  const state = createState(c, catalog);
  const res = resolve(c, catalog);
  const choice = res.choice(key);
  if (!choice) throw new Error("no prepared pool");
  const built = res.selected(choice);
  const third = res
    .options(choice)
    .filter((o) => catalog.spells[o.id]?.level === 3 && !o.unavailable)
    .map((o) => o.id);

  it("change after a rest without touching the build", () => {
    const today = [...built.slice(0, -1), third[0] as string];
    const r = act(c, state, { type: "set_choice", key, values: today });
    expect(r.state.choices[key]).toEqual(today);
    expect(c.choices[key]).toEqual(built);
    const names = r.sheet.spells.map((s) => s.id);
    expect(names).toContain(third[0]);
    expect(names).not.toContain(built.at(-1));
    expect(r.sheet.play.rest_choices).toEqual([key]);
    expect(act(c, r.state, { type: "reset_choice", key }).sheet.spells.map((s) => s.id)).toContain(
      built.at(-1),
    );
  });

  it("today's options come from the build as played (playBuild), as set_choice judges them", () => {
    const today = [...built.slice(0, -1), third[0] as string];
    const s = act(c, state, { type: "set_choice", key, values: today }).state;
    const played = resolve(playBuild(c, s, catalog), catalog);
    const pool = played.choice(key);
    if (!pool) throw new Error("no prepared pool");
    expect(played.selected(pool)).toEqual(today);
    // Each option judged today: an unavailable one is refused, an available one accepted.
    const options = played.options(pool);
    const swap = (id: string) => [...today.slice(0, -1), id];
    const open = options.find((o) => !o.unavailable && !today.includes(o.id));
    const closed = options.find((o) => o.unavailable && !today.includes(o.id));
    expect(() =>
      act(c, s, { type: "set_choice", key, values: swap(open?.id as string) }),
    ).not.toThrow();
    expect(() =>
      act(c, s, { type: "set_choice", key, values: swap(closed?.id as string) }),
    ).toThrow(PlayError);
    // Nothing picked today: the build itself.
    expect(playBuild(c, state, catalog)).toBe(c);
  });

  it("are checked like the build's picks", () => {
    expect(() =>
      act(c, state, { type: "set_choice", key, values: [...built, third[0] as string] }),
    ).toThrow(PlayError);
    expect(() =>
      act(c, state, { type: "set_choice", key: "class:cleric#skills", values: [] }),
    ).toThrow(/isn't a choice you can change after a rest/);
  });
});

describe("reconcile after the build changes", () => {
  it("clamps what no longer fits", () => {
    const b = levelUpIn(fighter, "fighter", 4); // Fighter 5
    let s = createState(b, catalog);
    s = act(
      b,
      s,
      { type: "use", key: "fighter:second-wind", amount: 3 },
      {
        type: "short_rest",
        hit_dice: [
          { die: 10, roll: 3 },
          { die: 10, roll: 3 },
        ],
      },
    ).state;
    s = { ...s, hit_dice_spent: { "10": 4 }, hp: { current: 40, temp: 0 } };
    const smaller = svc.removeLastLevel(
      svc.removeLastLevel(svc.removeLastLevel(b, catalog).build, catalog).build,
      catalog,
    ).build; // Fighter 2
    expect(validateState(smaller, s, catalog).length).toBeGreaterThan(0);
    const { state } = reconcileState(smaller, s, catalog);
    expect(validateState(smaller, state, catalog)).toEqual([]);
    expect(state.hit_dice_spent).toEqual({ "10": 2 });
    expect(state.hp.current).toBeNull();
    expect(state.uses_spent["fighter:second-wind"]).toBeLessThanOrEqual(2);
  });
});

describe("random actions keep the state valid (seeded)", () => {
  it("every accepted action leaves a state that validates", () => {
    const rng = seededRng(11);
    const pick = <T>(xs: readonly T[]): T => xs[rng.int(0, xs.length - 1)] as T;
    const classIds = Object.keys(catalog.classes);
    const itemIds = [
      "weapon-1",
      "ring-of-protection",
      "potion-of-healing",
      "wand-of-magic-missiles",
      "ring-of-resistance",
      "bracers-of-defense",
      "cloak-of-protection",
      "armor-2",
      "shield-1",
    ];
    let accepted = 0;
    for (let run = 0; run < 8; run++) {
      const classId = pick(classIds);
      const b = levelUpIn(autocomplete(classBuild(classId)), classId, rng.int(0, 4));
      let s = createState(b, catalog);
      for (let n = 0; n < 60; n++) {
        const sheet = computePlaySheet(b, s, catalog);
        const inv = s.inventory;
        const actions: PlayAction[] = [
          { type: "damage", amount: rng.int(0, 15), critical: rng.int(0, 5) === 0 },
          { type: "heal", amount: rng.int(1, 10) },
          { type: "death_save" },
          {
            type: "short_rest",
            hit_dice: sheet.play.hit_dice.slice(0, 1).map((d) => ({ die: d.die })),
          },
          { type: "long_rest" },
          { type: "spend_slot", level: rng.int(1, 3) },
          { type: "spend_pact_slot" },
          { type: "use", key: sheet.play.uses[0]?.key ?? "x" },
          { type: "add_condition", condition: pick(Object.keys(catalog.conditions)) },
          { type: "remove_condition", condition: pick([...s.conditions, "prone"]) },
          { type: "set_exhaustion", level: rng.int(0, 3) },
          { type: "set_temp_hp", amount: rng.int(0, 8) },
          {
            type: "add_item",
            item: pick(itemIds),
            base: pick(["longsword", "dagger", "chain-mail", "shield"]),
            variant: "fire",
          },
          ...(inv.length
            ? ([
                { type: "equip", id: pick(inv).id, equipped: rng.int(0, 1) === 1 },
                { type: "attune", id: pick(inv).id, attuned: rng.int(0, 1) === 1 },
                { type: "use_item", id: pick(inv).id },
                { type: "remove_item", id: pick(inv).id, qty: 1 },
              ] as PlayAction[])
            : []),
        ];
        try {
          s = applyAction(b, s, catalog, pick(actions), { rng }).state;
          accepted++;
        } catch (error) {
          if (!(error instanceof PlayError)) throw error;
        }
        expect(validateState(b, s, catalog)).toEqual([]);
        if (s.dead) s = createState(b, catalog);
      }
    }
    expect(accepted).toBeGreaterThan(150);
  });
});

describe("spells on the play sheet: the slots each can be cast with", () => {
  const spend = (b: CharacterBuild, s: CharacterState, action: PlayAction) =>
    applyAction(b, s, catalog, action).state;

  it("a Wizard 3: a level 1 spell with levels 1 and 2, a cantrip with none", () => {
    const b = levelUpIn(autocomplete(classBuild("wizard")), "wizard", 2);
    let s = createState(b, catalog);
    const first = () => computePlaySheet(b, s, catalog).spells.find((x) => x.level === 1);
    expect(first()).toMatchObject({ slot_levels: [1, 2], pact_slot: null });
    const cantrip = computePlaySheet(b, s, catalog).spells.find((x) => x.level === 0);
    expect(cantrip).toMatchObject({ slot_levels: [], pact_slot: null, slots: [] });
    const firsts = computePlaySheet(b, s, catalog).play.spell_slots[0]?.total ?? 0;
    for (let i = 0; i < firsts; i++) s = spend(b, s, { type: "spend_slot", level: 1 });
    expect(first()?.slot_levels).toEqual([2]);
    expect(first()?.slots[0]).toMatchObject({
      level: 1,
      pact: false,
      left: 0,
      available: false,
      reason: { code: "no_resources", category: "resource", text: "No level 1 spell slots left" },
    });
  });

  it("a Warlock 3: the Pact Magic slot at level 2, then none", () => {
    const b = levelUpIn(autocomplete(classBuild("warlock")), "warlock", 2);
    let s = createState(b, catalog);
    const first = () => computePlaySheet(b, s, catalog).spells.find((x) => x.level === 1);
    expect(first()).toMatchObject({ slot_levels: [], pact_slot: 2 });
    const pact = computePlaySheet(b, s, catalog).play.pact_magic?.slots ?? 0;
    for (let i = 0; i < pact; i++) s = spend(b, s, { type: "spend_pact_slot" });
    expect(first()?.pact_slot).toBeNull();
    expect(first()?.slots).toEqual([
      expect.objectContaining({ level: 2, pact: true, left: 0, available: false }),
    ]);
  });
});
