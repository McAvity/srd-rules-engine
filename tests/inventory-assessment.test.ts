// kenli F-013 T02: `assessInventoryItems`, a read-only assessment of catalog items for a
// character as they are now. Expected values come from the SRD tables, the character's choices
// and what the sheet and the actions actually do, not from the assessment's own code.
import { describe, expect, it } from "vitest";
import {
  applyAction,
  assessInventoryItems,
  builder,
  type Catalog,
  type CharacterBuild,
  type CharacterState,
  computePlaySheet,
  createCatalog,
  createState,
  type ItemAssessment,
  type ItemAssessmentRequest,
  listedPrice,
  MESSAGES_EN,
  type Message,
  magicItemBases,
  type PlayAction,
  PlayError,
  purseValue,
  renderMessage,
  scriptedRng,
} from "../src/index";
import { srdPack } from "../src/srd";
import { autocomplete, classBuild, fighterBuild, levelUpIn } from "./helpers";

// Invented test content: an origin feat granting proficiency with one weapon id.
const pack = {
  manifest: { id: "test-f013", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
  feats: [
    {
      id: "test-longsword-drill",
      name: "Test Longsword Drill",
      category: "origin",
      grants: { weapon_proficiencies: ["longsword"] },
    },
  ],
};
const catalog: Catalog = createCatalog([srdPack, pack], {});

const act = (b: CharacterBuild, s: CharacterState, ...actions: PlayAction[]) => {
  let state = s;
  for (const a of actions) {
    state = applyAction(b, state, catalog, a, { rng: scriptedRng([4, 4, 4, 4]) }).state;
  }
  return state;
};
const idOf = (s: CharacterState, item: string) => {
  const found = s.inventory.find((i) => i.item === item);
  if (!found) throw new Error(`no ${item}`);
  return found.id;
};
const assess = (b: CharacterBuild, s: CharacterState, requests: ItemAssessmentRequest[]) =>
  assessInventoryItems(b, s, catalog, requests);
const one = (b: CharacterBuild, s: CharacterState, request: ItemAssessmentRequest) =>
  assess(b, s, [request])[0] as ItemAssessment;
const codes = (a: ItemAssessment) => a.restrictions.map((r) => r.code);
const mod = (score: number) => Math.floor((score - 10) / 2);

/** A Human Wizard (Soldier) whose origin feat grants Longsword proficiency. */
const wizard = (() => {
  let b = classBuild("wizard");
  b = builder.setChoice(b, catalog, "species:human#versatile", ["test-longsword-drill"]).build;
  return autocomplete(b, catalog);
})();
const wizardState = createState(wizard, catalog);
const fighter = fighterBuild(); // Str 17, Chain Mail, masteries Greatsword/Flail/Javelin, Lute
const fighterState = createState(fighter, catalog);

describe("weapons: proficiency (simple, martial, martial:light, an id) and mastery apart", () => {
  it("the Wizard: Simple weapons and the Longsword (feat), not other Martial weapons", () => {
    const [dagger, longsword, rapier] = assess(wizard, wizardState, [
      { table: "weapons", item: "dagger" },
      { table: "weapons", item: "longsword" },
      { table: "weapons", item: "rapier" },
    ]) as ItemAssessment[];
    expect(dagger?.proficiency).toMatchObject({ status: "yes", via: "simple", bonus: 2 });
    expect(longsword?.proficiency).toMatchObject({ status: "yes", via: "longsword", bonus: 2 });
    expect(rapier?.proficiency).toMatchObject({ status: "no", via: null, bonus: null });
    expect(codes(rapier as ItemAssessment)).toEqual(["weapon_not_proficient"]);
    expect(rapier?.restrictions[0]).toMatchObject({
      effect: "no_proficiency_bonus",
      evaluation: "checked",
    });
    // Mastery is separate: a Wizard has none, even with proficiency.
    expect(dagger?.mastery).toMatchObject({ status: "no", property: "nick", name: "Nick" });
    expect(dagger?.kind).toBe("weapon");
  });

  it("agrees with the sheet: no Proficiency Bonus on the Rapier's attack roll", () => {
    const s = act(
      wizard,
      wizardState,
      { type: "add_item", item: "rapier" },
      { type: "add_item", item: "dagger" },
    );
    const sheet = computePlaySheet(wizard, s, catalog);
    const finesse = Math.max(mod(sheet.scores.str), mod(sheet.scores.dex));
    const bonus = (name: string) => sheet.attacks.find((a) => a.name === name)?.attack_bonus;
    expect(bonus("Rapier")).toBe(finesse);
    expect(bonus("Dagger")).toBe(finesse + sheet.proficiency_bonus);
  });

  it("a Monk (martial:light) and a Rogue (martial:finesse)", () => {
    const monk = autocomplete(classBuild("monk"), catalog);
    const monkState = createState(monk, catalog);
    const [scimitar, rapier, longsword] = assess(monk, monkState, [
      { table: "weapons", item: "scimitar" },
      { table: "weapons", item: "rapier" },
      { table: "weapons", item: "longsword" },
    ]);
    expect(scimitar?.proficiency).toMatchObject({ status: "yes", via: "martial:light" });
    expect(rapier?.proficiency.status).toBe("no"); // Finesse only, not Light
    expect(longsword?.proficiency.status).toBe("no");
    const rogue = autocomplete(classBuild("rogue"), catalog);
    const r = one(rogue, createState(rogue, catalog), { table: "weapons", item: "rapier" });
    expect(r.proficiency).toMatchObject({ status: "yes", via: "martial:finesse" });
  });

  it("the Fighter: mastery for the chosen weapons only, and as chosen today (state)", () => {
    const [greatsword, longsword] = assess(fighter, fighterState, [
      { table: "weapons", item: "greatsword" },
      { table: "weapons", item: "longsword" },
    ]);
    expect(greatsword?.proficiency).toMatchObject({ status: "yes", via: "martial" });
    expect(greatsword?.mastery).toMatchObject({ status: "yes", property: "graze" });
    expect(longsword?.proficiency.status).toBe("yes");
    expect(longsword?.mastery).toMatchObject({ status: "no", property: "sap" });
    // Weapon Mastery changes after a Long Rest: today's pick, from the state.
    const key = "class:fighter#weapon_mastery";
    const today = act(fighter, fighterState, {
      type: "set_choice",
      key,
      values: ["greatsword", "flail", "longsword"],
    });
    expect(fighter.choices[key]).not.toContain("longsword");
    expect(one(fighter, today, { table: "weapons", item: "longsword" }).mastery.status).toBe("yes");
    expect(one(fighter, today, { table: "weapons", item: "javelin" }).mastery.status).toBe("no");
  });

  it("at the current level: a Wizard who takes a Fighter level is proficient with Martial weapons", () => {
    const before = one(wizard, wizardState, { table: "weapons", item: "rapier" });
    const multi = levelUpIn(wizard, "fighter", 1, null, catalog);
    const after = one(multi, createState(multi, catalog), { table: "weapons", item: "rapier" });
    expect(before.proficiency.status).toBe("no");
    expect(after.proficiency).toMatchObject({ status: "yes", via: "martial" });
  });

  it("Heavy below Strength 13 and Two-Handed with a held Shield, as conditional penalties", () => {
    const w = one(wizard, wizardState, { table: "weapons", item: "greatsword" });
    const str = computePlaySheet(wizard, wizardState, catalog).scores.str;
    expect(str).toBeLessThan(13);
    expect(codes(w)).toEqual(["weapon_not_proficient", "heavy_weapon"]);
    expect(w.restrictions[1]?.message.params).toMatchObject({ score: str });
    // The sheet's attack line says the same.
    const s = act(wizard, wizardState, { type: "add_item", item: "greatsword" });
    const line = computePlaySheet(wizard, s, catalog).attacks.find((a) => a.name === "Greatsword");
    expect(line?.notes.some((n) => n.startsWith("Disadvantage (Heavy"))).toBe(true);
    // Owning a Two-Handed weapon isn't a problem; holding a Shield makes it one.
    const f = one(fighter, fighterState, { table: "weapons", item: "greatsword" });
    expect(codes(f)).toEqual([]);
    let held = act(fighter, fighterState, { type: "add_item", item: "shield" });
    held = act(fighter, held, { type: "equip", id: idOf(held, "shield"), equipped: true });
    const withShield = one(fighter, held, { table: "weapons", item: "greatsword" });
    expect(codes(withShield)).toEqual(["two_handed_with_shield"]);
    expect(withShield.restrictions[0]?.message.params).toMatchObject({ shield: "Shield" });
  });

  it("current scores: Gauntlets of Ogre Power (Strength 19) lift the Heavy and armor Strength limits", () => {
    let s = act(wizard, wizardState, { type: "add_item", item: "gauntlets-of-ogre-power" });
    const id = idOf(s, "gauntlets-of-ogre-power");
    s = act(
      wizard,
      s,
      { type: "equip", id, equipped: true },
      { type: "attune", id, attuned: true },
    );
    const [greatsword, chain] = assess(wizard, s, [
      { table: "weapons", item: "greatsword" },
      { table: "armor", item: "chain-mail" },
    ]);
    expect(codes(greatsword as ItemAssessment)).toEqual(["weapon_not_proficient"]);
    expect(codes(chain as ItemAssessment)).toEqual(["armor_untrained", "armor_stealth"]);
  });
});

describe("armor and shields", () => {
  it("untrained armor: Disadvantage and no spells, Strength, Stealth — and the sheet agrees", () => {
    const a = one(wizard, wizardState, { table: "armor", item: "chain-mail" });
    expect(a.kind).toBe("armor");
    expect(a.proficiency).toMatchObject({ status: "no", via: null });
    expect(codes(a)).toEqual(["armor_untrained", "armor_strength", "armor_stealth"]);
    expect(a.restrictions.every((r) => r.effect === "penalty" && r.evaluation === "checked")).toBe(
      true,
    );
    expect(a.restrictions[1]?.message.params).toMatchObject({ strength: 13 });
    let s = act(wizard, wizardState, { type: "add_item", item: "chain-mail" });
    const before = computePlaySheet(wizard, s, catalog);
    // Owning it changes nothing on the sheet.
    expect(before.armor_untrained).toBeNull();
    s = act(wizard, s, { type: "equip", id: idOf(s, "chain-mail"), equipped: true });
    const worn = computePlaySheet(wizard, s, catalog);
    expect(worn.armor_untrained).toBe("Chain Mail");
    expect(worn.speed.total).toBe(before.speed.total - 10);
    expect(worn.warnings.some((w) => w.includes("Stealth"))).toBe(true);
  });

  it("trained armor: only what applies (the Fighter's Chain Mail: Stealth)", () => {
    const a = one(fighter, fighterState, { table: "armor", item: "chain-mail" });
    expect(a.proficiency).toMatchObject({ status: "yes", via: "heavy" });
    expect(codes(a)).toEqual(["armor_stealth"]);
  });

  it("Mithral: no Strength requirement or Stealth Disadvantage; training still counts", () => {
    const plate = one(wizard, wizardState, { table: "armor", item: "plate-armor" });
    expect(codes(plate)).toEqual(["armor_untrained", "armor_strength", "armor_stealth"]);
    const mithral = one(wizard, wizardState, {
      table: "magic_items",
      item: "mithral-armor",
      base: "plate-armor",
    });
    expect(mithral.kind).toBe("armor");
    expect(mithral.name).toBe("Mithral Armor (Plate Armor)");
    expect(codes(mithral)).toEqual(["armor_untrained"]);
    const fighterMithral = one(fighter, fighterState, {
      table: "magic_items",
      item: "mithral-armor",
      base: "plate-armor",
    });
    expect(fighterMithral.proficiency.status).toBe("yes");
    expect(codes(fighterMithral)).toEqual([]);
  });

  it("shields, ordinary and magic, as T01 plays them: no AC without training", () => {
    const [plain, magic] = assess(wizard, wizardState, [
      { table: "armor", item: "shield" },
      { table: "magic_items", item: "shield-1" },
    ]) as ItemAssessment[];
    for (const a of [plain, magic] as ItemAssessment[]) {
      expect(a.kind).toBe("shield");
      expect(a.proficiency.status).toBe("no");
      expect(codes(a)).toEqual(["shield_untrained"]);
    }
    expect(magic?.base).toBe("shield"); // the only base, picked as add_item picks it
    expect(magic?.name).toBe("Shield, +1");
    // The sheet: holding either adds no AC.
    const ac = (s: CharacterState) => computePlaySheet(wizard, s, catalog).armor_class.total;
    for (const item of ["shield", "shield-1"]) {
      let s = act(wizard, wizardState, { type: "add_item", item });
      s = act(wizard, s, { type: "equip", id: idOf(s, item), equipped: true });
      expect(ac(s)).toBe(ac(wizardState));
    }
    const trained = one(fighter, fighterState, { table: "magic_items", item: "shield-1" });
    expect(trained.proficiency).toMatchObject({ status: "yes", via: "shield" });
    expect(codes(trained)).toEqual([]);
  });
});

describe("tools, gear and unknown records", () => {
  it("a tool: the proficiency's source and PB; the activity decides the rest (manual)", () => {
    const sheet = computePlaySheet(fighter, fighterState, catalog);
    const lute = one(fighter, fighterState, { table: "tools", item: "lute" });
    expect(lute.kind).toBe("tool");
    expect(sheet.tools.lute).toBeDefined();
    expect(lute.proficiency).toMatchObject({ status: "yes", via: sheet.tools.lute, bonus: 2 });
    expect(lute.mastery.status).toBe("not_applicable");
    expect(lute.restrictions).toEqual([
      expect.objectContaining({ code: "tool_activity", effect: "note", evaluation: "manual" }),
    ]);
    const wizardLute = one(wizard, wizardState, { table: "tools", item: "lute" });
    expect(wizardLute.proficiency).toMatchObject({ status: "no", via: null, bonus: null });
    expect(codes(wizardLute)).toEqual(["tool_not_proficient", "tool_activity"]);
  });

  it("ordinary gear and ammunition: no proficiency applies; an unknown id: unknown, per row", () => {
    const [rope, arrow, nothing, wrongTable] = assess(wizard, wizardState, [
      { table: "gear", item: "rope" },
      { table: "gear", item: "arrow" },
      { table: "gear", item: "no-such-thing" },
      { table: "weapons", item: "rope" },
    ]) as ItemAssessment[];
    for (const a of [rope, arrow] as ItemAssessment[]) {
      expect(a).toMatchObject({ found: true, kind: "gear", magic: false });
      expect(a.proficiency.status).toBe("not_applicable");
      expect(a.mastery.status).toBe("not_applicable");
      expect(a.restrictions).toEqual([]);
    }
    for (const a of [nothing, wrongTable] as ItemAssessment[]) {
      expect(a).toMatchObject({ found: false, kind: null, name: null, price_cp: null });
      expect(a.proficiency.status).toBe("unknown");
      expect(a.issues.map((i) => i.code)).toEqual(["unknown_item"]);
    }
  });

  it("a base or kind asked of an item without them is reported, not silently assessed", () => {
    const a = one(wizard, wizardState, {
      table: "weapons",
      item: "dagger",
      base: "club",
      variant: "fire",
    });
    expect(a.base).toBeNull();
    expect(a.issues.map((i) => i.code)).toEqual(["base_not_used", "variant_not_used"]);
    expect(a.proficiency.status).toBe("yes");
  });
});

describe("magic items: bases, kinds, attunement", () => {
  it("a template with mixed proficiency lists every base and which ones fit (Weapon, +1)", () => {
    const t = one(wizard, wizardState, { table: "magic_items", item: "weapon-1" });
    expect(t.proficiency.status).toBe("choose_base");
    expect(t.mastery.status).toBe("choose_base");
    expect(t.base).toBeNull();
    expect(t.issues.map((i) => i.code)).toEqual(["choose_base"]);
    expect(t.kind).toBe("weapon");
    expect(t.magic).toBe(true);
    expect(t.price_cp).toBeNull(); // no listed price: not free
    const allowed = magicItemBases(catalog, "weapon-1");
    expect(t.bases?.allowed.map((b) => b.id)).toEqual(allowed);
    // Independently: every Simple weapon, plus the Longsword (the feat).
    const expected = allowed.filter(
      (id) => catalog.weapons[id]?.category === "simple" || id === "longsword",
    );
    expect(t.bases?.proficient).toEqual(expected);
    expect(t.bases?.any_proficient).toBe(true);
    expect(t.bases?.allowed.find((b) => b.id === "rapier")?.proficiency).toBe("no");
  });

  it("a chosen base is assessed for real; an invalid one is refused as add_item refuses it", () => {
    const [rapier, longsword, armor] = assess(wizard, wizardState, [
      { table: "magic_items", item: "weapon-1", base: "rapier" },
      { table: "magic_items", item: "weapon-1", base: "longsword" },
      { table: "magic_items", item: "weapon-1", base: "chain-mail" },
    ]) as ItemAssessment[];
    expect(rapier).toMatchObject({
      name: "Rapier, +1",
      base: "rapier",
      key: "magic_items:weapon-1@rapier",
    });
    expect(rapier?.proficiency.status).toBe("no");
    expect(codes(rapier as ItemAssessment)).toEqual(["weapon_not_proficient"]);
    expect(longsword?.proficiency).toMatchObject({ status: "yes", via: "longsword" });
    expect(armor?.proficiency.status).toBe("unknown");
    expect(armor?.issues.map((i) => i.code)).toEqual(["invalid_base"]);
    expect(armor).toMatchObject({ base: "chain-mail", name: "Weapon, +1", kind: "weapon" });
    let refusal: PlayError | null = null;
    try {
      act(wizard, wizardState, { type: "add_item", item: "weapon-1", base: "chain-mail" });
    } catch (e) {
      refusal = e as PlayError;
    }
    expect(refusal?.details[0]?.code).toBe(armor?.issues[0]?.message.code);
    expect(refusal?.details[0]?.text).toBe(armor?.issues[0]?.message.text);
  });

  it("a magic weapon whose bases differ for this character (Oathbow: Shortbow yes, Longbow no)", () => {
    const t = one(wizard, wizardState, { table: "magic_items", item: "oathbow" });
    const byId = Object.fromEntries(t.bases?.allowed.map((b) => [b.id, b.proficiency]) ?? []);
    expect(byId).toEqual({ longbow: "no", shortbow: "yes" });
    expect(t.bases?.proficient).toEqual(["shortbow"]);
  });

  it("kinds: missing or invalid is an issue; a valid one names the item (with a base too)", () => {
    const [none, fire, bogus, armor] = assess(wizard, wizardState, [
      { table: "magic_items", item: "ring-of-resistance" },
      { table: "magic_items", item: "ring-of-resistance", variant: "fire" },
      { table: "magic_items", item: "ring-of-resistance", variant: "bogus" },
      { table: "magic_items", item: "armor-of-resistance", base: "leather-armor", variant: "cold" },
    ]) as ItemAssessment[];
    expect(none?.issues.map((i) => i.code)).toEqual(["choose_variant"]);
    expect(none?.kind).toBe("gear");
    expect(none?.magic_category).toBe("ring");
    expect(none?.proficiency.status).toBe("not_applicable");
    expect(none?.variants.map((v) => v.id)).toContain("fire");
    expect(fire?.issues).toEqual([]);
    expect(fire?.name).toBe("Ring of Resistance (Fire)");
    expect(bogus?.issues.map((i) => i.code)).toEqual(["invalid_variant"]);
    expect(armor?.issues).toEqual([]);
    expect(armor?.kind).toBe("armor");
    expect(armor?.proficiency.status).toBe("no");
    expect(armor?.name).toBe("Armor of Resistance (Leather Armor) (Cold)");
  });

  it("attunement: required, by class (checked like attune), by text (manual), and the limit", () => {
    const [avenger, thrower, ring] = assess(wizard, wizardState, [
      { table: "magic_items", item: "holy-avenger", base: "longsword" },
      { table: "magic_items", item: "dwarven-thrower" },
      { table: "magic_items", item: "ring-of-protection" },
    ]) as ItemAssessment[];
    expect(avenger?.requires_attunement).toBe(true);
    expect(codes(avenger as ItemAssessment)).toEqual([
      "attunement_required",
      "attunement_not_allowed",
    ]);
    const blocked = avenger?.restrictions[1];
    expect(blocked?.evaluation).toBe("checked");
    // The same reason the attune action gives.
    let s = act(wizard, wizardState, { type: "add_item", item: "holy-avenger", base: "longsword" });
    let refusal: PlayError | null = null;
    try {
      act(wizard, s, { type: "attune", id: idOf(s, "holy-avenger"), attuned: true });
    } catch (e) {
      refusal = e as PlayError;
    }
    const reason = blocked?.message.params.reason as Message | undefined;
    expect(reason?.code).toBe(refusal?.details[0]?.code);
    expect(reason?.code).toBe("refusal.attunement_requires");
    expect(codes(thrower as ItemAssessment)).toContain("attunement_manual");
    expect(thrower?.restrictions.find((r) => r.code === "attunement_manual")?.evaluation).toBe(
      "manual",
    );
    expect(codes(ring as ItemAssessment)).toEqual(["attunement_required"]);
    // Three attuned: the limit, as the attune action enforces it.
    s = wizardState;
    for (const item of ["bracers-of-defense", "cloak-of-protection", "gauntlets-of-ogre-power"]) {
      s = act(wizard, s, { type: "add_item", item });
      s = act(wizard, s, { type: "attune", id: idOf(s, item), attuned: true });
    }
    expect(codes(one(wizard, s, { table: "magic_items", item: "ring-of-protection" }))).toEqual([
      "attunement_required",
      "attunement_limit",
    ]);
    s = act(wizard, s, { type: "add_item", item: "ring-of-protection" });
    expect(() =>
      act(wizard, s, { type: "attune", id: idOf(s, "ring-of-protection"), attuned: true }),
    ).toThrow(/at most 3/);
  });
});

describe("prices: the same as Buy charges (listedPrice)", () => {
  it("Lute 35 GP (listed with its weight), Arrows 1 GP for 20, magic items unlisted", () => {
    const [lute, arrow, rope, magic] = assess(fighter, fighterState, [
      { table: "tools", item: "lute" },
      { table: "gear", item: "arrow" },
      { table: "gear", item: "rope" },
      { table: "magic_items", item: "bag-of-holding" },
    ]) as ItemAssessment[];
    expect(catalog.tools.lute?.cost).toBe("35 GP, 2 lb.");
    expect(lute).toMatchObject({ price_cp: 3500, bundle: 1 });
    expect(arrow).toMatchObject({ price_cp: 100, bundle: 20 });
    expect(rope).toMatchObject({ price_cp: 100, bundle: 1 });
    expect(magic).toMatchObject({ price_cp: null, bundle: 1 });
    expect(listedPrice(catalog, "lute")).toEqual({ name: "Lute", cp: 3500, bundle: 1 });
    expect(listedPrice(catalog, "no-such-thing")).toBeNull();
  });

  it("Buy takes exactly that price once and gives the bundle", () => {
    for (const item of ["lute", "arrow"]) {
      const a = one(fighter, fighterState, { table: item === "lute" ? "tools" : "gear", item });
      const purse = { ...fighterState, currency: { cp: 0, sp: 0, ep: 0, gp: 40, pp: 0 } };
      const before = purseValue(purse.currency);
      const owned = (s: CharacterState) =>
        s.inventory.filter((i) => i.item === item).reduce((n, i) => n + i.qty, 0);
      const after = act(fighter, purse, { type: "buy", item, qty: 1 });
      expect(before - purseValue(after.currency)).toBe(a.price_cp);
      expect(owned(after) - owned(purse)).toBe(a.bundle);
    }
    // 34 GP isn't enough for the Lute.
    const poor = { ...fighterState, currency: { cp: 0, sp: 0, ep: 0, gp: 34, pp: 0 } };
    expect(() => act(fighter, poor, { type: "buy", item: "lute" })).toThrow(PlayError);
  });
});

describe("a read, not an action", () => {
  const requests: ItemAssessmentRequest[] = [
    { table: "weapons", item: "greatsword" },
    { table: "armor", item: "chain-mail" },
    { table: "armor", item: "shield" },
    { table: "tools", item: "lute" },
    { table: "gear", item: "arrow" },
    { table: "magic_items", item: "weapon-1" },
    { table: "magic_items", item: "holy-avenger", base: "longsword" },
    { table: "magic_items", item: "ring-of-resistance" },
    { table: "gear", item: "no-such-thing" },
  ];

  it("changes nothing: build, state and catalog stay as they were (deeply frozen)", () => {
    const deepFreeze = <T>(o: T): T => {
      if (o && typeof o === "object" && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const v of Object.values(o)) deepFreeze(v);
      }
      return o;
    };
    const build = deepFreeze(structuredClone(wizard));
    const state = deepFreeze(structuredClone(wizardState));
    const tables = ["weapons", "armor", "tools", "gear", "magic_items"] as const;
    const snapshot = JSON.stringify(tables.map((t) => catalog[t]));
    const result = assessInventoryItems(build, state, catalog, requests);
    expect(result).toHaveLength(requests.length);
    expect(build).toEqual(wizard);
    expect(state).toEqual(wizardState);
    expect(JSON.stringify(tables.map((t) => catalog[t]))).toBe(snapshot);
    // Asking twice gives the same answer; the same request has the same key.
    expect(assessInventoryItems(build, state, catalog, requests)).toEqual(result);
    expect(result.map((r) => r.key)).toEqual([
      "weapons:greatsword",
      "armor:chain-mail",
      "armor:shield",
      "tools:lute",
      "gear:arrow",
      "magic_items:weapon-1",
      "magic_items:holy-avenger@longsword",
      "magic_items:ring-of-resistance",
      "gear:no-such-thing",
    ]);
  });

  it("survives JSON; every message has a known code and renders to its text", () => {
    const result = assessInventoryItems(fighter, fighterState, catalog, requests);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    const messages = result.flatMap((r) => [
      r.proficiency.reason,
      r.mastery.reason,
      ...r.restrictions.map((x) => x.message),
      ...r.issues.map((x) => x.message),
    ]);
    expect(messages.length).toBeGreaterThan(20);
    for (const m of messages) {
      expect(m.code in MESSAGES_EN).toBe(true);
      expect(renderMessage(m)).toBe(m.text);
    }
  });
});
