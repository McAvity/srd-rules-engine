// kenli F-013 T01 (R01-01): a Shield gives its Armor Class only with Shield training (SRD
// "Armor Training": without it you don't gain the Shield's AC benefit). Holding it is still
// allowed and still counts as wielding a Shield for other rules (Unarmored Defense, Bracers of
// Defense). Expected values are computed here from ability scores and the SRD tables, not by the
// sheet's AC routine.
import { describe, expect, it } from "vitest";
import {
  applyAction,
  type CharacterBuild,
  type CharacterState,
  computePlaySheet,
  createState,
  lookup,
  type PlayAction,
  scriptedRng,
} from "../src/index";
import { autocomplete, catalog, classBuild, fighterBuild } from "./helpers";

const act = (b: CharacterBuild, s: CharacterState, ...actions: PlayAction[]) => {
  let state = s;
  for (const a of actions) {
    state = applyAction(b, state, catalog, a, { rng: scriptedRng([4, 4, 4, 4]) }).state;
  }
  return state;
};
const sheetOf = (b: CharacterBuild, s: CharacterState) => computePlaySheet(b, s, catalog);
const ac = (b: CharacterBuild, s: CharacterState) => sheetOf(b, s).armor_class.total;
const idOf = (s: CharacterState, item: string) => {
  const found = s.inventory.find((i) => i.item === item);
  if (!found) throw new Error(`no ${item} in the inventory`);
  return found.id;
};
const mod = (score: number) => Math.floor((score - 10) / 2);
/** Add a catalog item and equip it (no purchase: gold stays the same). */
const holdItem = (b: CharacterBuild, s: CharacterState, item: string, base?: string) => {
  const added = act(b, s, { type: "add_item", item, ...(base ? { base } : {}) });
  return act(b, added, { type: "equip", id: idOf(added, item), equipped: true });
};
const SHIELD_AC = 2; // SRD Armor table: Shield +2
const SHIELD_TRAINING_WARNING = /aren't trained with Shields/;

describe("a Shield without Shield training (SRD Wizard)", () => {
  const wizard = autocomplete(classBuild("wizard"));
  const start = createState(wizard, catalog);
  const scores = sheetOf(wizard, start).scores;
  const unarmored = 10 + mod(scores.dex);

  it("the Wizard has no armor or shield training and starts unarmored", () => {
    expect(sheetOf(wizard, start).armor_training).toEqual([]);
    expect(ac(wizard, start)).toBe(unarmored);
    expect(ac(wizard, start)).toBe(11); // Dex 13 (12 + Soldier +1)
  });

  it("equipping an ordinary Shield doesn't change AC and adds no armor penalty", () => {
    const s = holdItem(wizard, start, "shield");
    const shield = s.inventory.find((i) => i.item === "shield");
    expect(shield?.equipped).toBe(true);
    expect(shield?.qty).toBe(1);
    expect(s.currency).toEqual(start.currency);
    const sheet = sheetOf(wizard, s);
    expect(sheet.armor_class.total).toBe(unarmored);
    expect(sheet.armor_class.parts.map((p) => p.source)).not.toContain("Shield");
    // Not armor: no Disadvantage on Str/Dex tests and no loss of spellcasting.
    expect(sheet.armor_untrained).toBeNull();
    expect(sheet.warnings.some((w) => SHIELD_TRAINING_WARNING.test(w))).toBe(true);
  });

  it("a magic Shield, +1 gives neither the base +2 nor its +1", () => {
    const s = holdItem(wizard, start, "shield-1", "shield");
    expect(s.inventory.find((i) => i.item === "shield-1")?.equipped).toBe(true);
    expect(ac(wizard, s)).toBe(unarmored);
  });

  it("unequipped or stored, the Shield stays owned and AC stays the same", () => {
    const held = holdItem(wizard, start, "shield");
    const id = idOf(held, "shield");
    const off = act(wizard, held, { type: "equip", id, equipped: false });
    expect(ac(wizard, off)).toBe(unarmored);
    expect(sheetOf(wizard, off).warnings.some((w) => SHIELD_TRAINING_WARNING.test(w))).toBe(false);
    const stored = act(wizard, off, { type: "store", id, stored: true });
    expect(stored.inventory.find((i) => i.id === id)?.location).toBe("stored");
    expect(ac(wizard, stored)).toBe(unarmored);
    expect(stored.currency).toEqual(start.currency);
  });

  it("a held Shield still counts as using a Shield (Bracers of Defense) and keeps other effects (Ring of Protection)", () => {
    let s = start;
    for (const item of ["bracers-of-defense", "ring-of-protection"]) {
      s = act(wizard, s, { type: "add_item", item });
      const id = idOf(s, item);
      s = act(
        wizard,
        s,
        { type: "equip", id, equipped: true },
        { type: "attune", id, attuned: true },
      );
    }
    expect(ac(wizard, s)).toBe(unarmored + 2 + 1); // Bracers +2 (no armor, no Shield), Ring +1
    const held = holdItem(wizard, s, "shield");
    // The Bracers stop (a Shield is used), the Ring keeps working, the Shield adds nothing.
    expect(ac(wizard, held)).toBe(unarmored + 1);
  });
});

describe("a Shield with Shield training", () => {
  it("a Fighter in Chain Mail gains +2, and +3 with a Shield, +1", () => {
    const fighter = fighterBuild();
    const start = createState(fighter, catalog);
    const chainMailDefense = 16 + 1; // Chain Mail 16 (no Dex), Defense +1
    expect(sheetOf(fighter, start).armor_training).toContain("shield");
    expect(ac(fighter, start)).toBe(chainMailDefense);
    const shield = holdItem(fighter, start, "shield");
    expect(ac(fighter, shield)).toBe(chainMailDefense + SHIELD_AC);
    expect(sheetOf(fighter, shield).warnings.some((w) => SHIELD_TRAINING_WARNING.test(w))).toBe(
      false,
    );
    const magic = holdItem(fighter, start, "shield-1", "shield");
    expect(ac(fighter, magic)).toBe(chainMailDefense + SHIELD_AC + 1);
  });

  it("a Barbarian keeps Unarmored Defense with a Shield and adds its +2", () => {
    const barbarian = autocomplete(classBuild("barbarian"));
    const start = createState(barbarian, catalog);
    const s0 = act(
      barbarian,
      start,
      ...start.inventory
        .filter((i) => i.equipped && i.item !== null && lookup(catalog.armor, i.item))
        .map((i) => ({ type: "equip", id: i.id, equipped: false }) as const),
    );
    const scores = sheetOf(barbarian, s0).scores;
    const unarmoredDefense = 10 + mod(scores.dex) + mod(scores.con);
    expect(ac(barbarian, s0)).toBe(unarmoredDefense);
    expect(ac(barbarian, holdItem(barbarian, s0, "shield"))).toBe(unarmoredDefense + SHIELD_AC);
  });
});

describe("a Monk (no Shield training) holding a Shield", () => {
  it("loses Unarmored Defense and gains nothing from the Shield", () => {
    const monk = autocomplete(classBuild("monk"));
    const start = createState(monk, catalog);
    const scores = sheetOf(monk, start).scores;
    expect(ac(monk, start)).toBe(10 + mod(scores.dex) + mod(scores.wis));
    expect(ac(monk, holdItem(monk, start, "shield"))).toBe(10 + mod(scores.dex));
  });
});
