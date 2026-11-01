import { describe, expect, it } from "vitest";
import {
  applyAction,
  type CharacterState,
  computePlaySheet,
  createState,
  itemQuote,
  PlayError,
  stockItems,
} from "../src/index";
import { autocomplete, catalog, classBuild } from "./helpers";

// kenli F-002 T13: a starting kit bought on a state in memory (SRD gear, weapons and armor; the
// catalog's prices only): owned units aren't bought again, a missing amount is bought in whole
// bundles, all or nothing.

const build = autocomplete(classBuild("fighter", { name: "Kit" }));
const withGold = (gp: number, extra: Partial<CharacterState> = {}): CharacterState => ({
  ...createState(build, catalog),
  inventory: [],
  currency: { cp: 0, sp: 0, ep: 0, gp, pp: 0 },
  ...extra,
});
const gold = (s: CharacterState) =>
  s.currency.cp +
  s.currency.sp * 10 +
  s.currency.ep * 50 +
  s.currency.gp * 100 +
  s.currency.pp * 1000;

describe("itemQuote", () => {
  it("the catalog's price per bundle and the bundle size", () => {
    expect(itemQuote(catalog, "arrow")).toEqual({
      item: "arrow",
      name: "Arrow",
      cp: 100,
      bundle: 20,
    });
    expect(itemQuote(catalog, "chain-mail")).toMatchObject({ cp: 7500, bundle: 1 });
    expect(() => itemQuote(catalog, "no-such-item")).toThrow(PlayError);
  });
});

describe("stockItems: a starting kit on a state in memory", () => {
  it("buys and equips Chain Mail and a Glaive at catalog prices; AC and the attack follow", () => {
    const s0 = withGold(205);
    const r = stockItems(build, s0, catalog, [
      { item: "chain-mail", units: 1, equip: true },
      { item: "glaive", units: 1, equip: true },
      { item: "javelin", units: 4, equip: false },
    ]);
    expect(r.spent_cp).toBe(7500 + 2000 + 4 * 50);
    expect(r.before_cp).toBe(20500);
    expect(r.after_cp).toBe(20500 - 9700);
    expect(gold(r.state)).toBe(r.after_cp);
    expect(r.lines.map((l) => [l.item, l.bundles, l.received, l.cost_cp, l.equip])).toEqual([
      ["chain-mail", 1, 1, 7500, true],
      ["glaive", 1, 1, 2000, true],
      ["javelin", 4, 4, 200, false],
    ]);
    const sheet = computePlaySheet(build, r.state, catalog);
    expect(sheet.armor_class.total).toBe(16);
    expect(sheet.attacks.some((a) => a.name === "Glaive")).toBe(true);
    expect(
      r.state.inventory
        .filter((i) => i.equipped)
        .map((i) => i.item)
        .sort(),
    ).toEqual(["chain-mail", "glaive"]);
    // Pure: the state given is unchanged.
    expect(gold(s0)).toBe(20500);
    expect(s0.inventory).toEqual([]);
  });

  it("bundles: 30 Arrows is two bundles (40 received, 2 GP); 25 owned + 30 wanted is one bundle (20 received)", () => {
    const a = stockItems(build, withGold(10), catalog, [
      { item: "arrow", units: 30, equip: false },
    ]);
    expect(a.lines[0]).toMatchObject({
      owned: 0,
      bundles: 2,
      bundle: 20,
      received: 40,
      cost_cp: 200,
    });
    const owned = applyAction(build, withGold(10), catalog, {
      type: "add_item",
      item: "arrow",
      qty: 25,
    }).state;
    const b = stockItems(build, owned, catalog, [{ item: "arrow", units: 30, equip: false }]);
    expect(b.lines[0]).toMatchObject({ owned: 25, bundles: 1, received: 20, cost_cp: 100 });
    expect(b.state.inventory.find((i) => i.item === "arrow")?.qty).toBe(45);
  });

  it("the class's actual starting grant (SRD Fighter option A: Chain Mail, Javelins) is not bought again", () => {
    const granted = createState(build, catalog);
    const mail = granted.inventory.find((i) => i.item === "chain-mail");
    expect(mail).toBeDefined();
    const r = stockItems(build, granted, catalog, [
      { item: "chain-mail", units: 1, equip: true },
      { item: "whip", units: 1, equip: false },
    ]);
    expect(r.lines.map((l) => [l.item, l.owned, l.bundles, l.cost_cp])).toEqual([
      ["chain-mail", 1, 0, 0],
      ["whip", 0, 1, 200],
    ]);
    expect(r.spent_cp).toBe(200);
  });

  it("a granted item fully owned is not bought (no cost), and it can be equipped", () => {
    const owned = applyAction(build, withGold(0), catalog, {
      type: "add_item",
      item: "shield",
    }).state;
    const r = stockItems(build, owned, catalog, [{ item: "shield", units: 1, equip: true }]);
    expect(r.lines[0]).toMatchObject({ owned: 1, bundles: 0, received: 0, cost_cp: 0 });
    expect(r.spent_cp).toBe(0);
    expect(r.state.inventory.find((i) => i.item === "shield")?.equipped).toBe(true);
  });

  it("all or nothing: not enough coins, an unknown or unpriced item, a bad count or a repeat refuse the whole list", () => {
    const s0 = withGold(80);
    const kit = (items: { item: string; units: number; equip: boolean }[]) => () =>
      stockItems(build, s0, catalog, items);
    expect(
      kit([
        { item: "glaive", units: 1, equip: true },
        { item: "chain-mail", units: 1, equip: true },
      ]),
    ).toThrow(/Not enough coins|coins/i);
    expect(kit([{ item: "no-such-item", units: 1, equip: false }])).toThrow(PlayError);
    expect(kit([{ item: "bag-of-holding", units: 1, equip: false }])).toThrow("no listed price");
    expect(kit([{ item: "arrow", units: 0, equip: false }])).toThrow("at least 1");
    expect(kit([{ item: "arrow", units: 1.5, equip: false }])).toThrow("at least 1");
    expect(
      kit([
        { item: "arrow", units: 1, equip: false },
        { item: "arrow", units: 2, equip: false },
      ]),
    ).toThrow("listed twice");
    expect(gold(s0)).toBe(8000);
    expect(s0.inventory).toEqual([]);
  });

  it("D044: each line's equip is the staged state's, not the request", () => {
    // The SRD Fighter's granted Chain Mail is worn; `equip: false` asks nothing, it stays worn.
    const granted = createState(build, catalog);
    expect(granted.inventory.find((i) => i.item === "chain-mail")?.equipped).toBe(true);
    const r = stockItems(build, granted, catalog, [{ item: "chain-mail", units: 1, equip: false }]);
    expect(r.lines[0]).toMatchObject({ item: "chain-mail", owned: 1, bundles: 0, equip: true });
    expect(r.state.inventory.find((i) => i.item === "chain-mail")?.equipped).toBe(true);
    // Not worn and not asked: false.
    const s = stockItems(build, withGold(100), catalog, [
      { item: "dagger", units: 1, equip: false },
    ]);
    expect(s.lines[0]?.equip).toBe(false);
  });

  it("D044: two armors asked to be worn can't both be: the whole list refused, nothing changes", () => {
    const s0 = withGold(500);
    expect(() =>
      stockItems(build, s0, catalog, [
        { item: "chain-mail", units: 1, equip: true },
        { item: "leather-armor", units: 1, equip: true },
      ]),
    ).toThrow(/Leather Armor|Chain Mail/);
    expect(() =>
      stockItems(build, s0, catalog, [
        { item: "chain-mail", units: 1, equip: true },
        { item: "leather-armor", units: 1, equip: true },
      ]),
    ).toThrow(/can't be worn or held together/);
    expect(gold(s0)).toBe(50000);
    expect(s0.inventory).toEqual([]);
    // One armor worn, the other only carried: fine, and the lines say which.
    const ok = stockItems(build, s0, catalog, [
      { item: "chain-mail", units: 1, equip: true },
      { item: "leather-armor", units: 1, equip: false },
    ]);
    expect(ok.lines.map((l) => [l.item, l.equip])).toEqual([
      ["chain-mail", true],
      ["leather-armor", false],
    ]);
    expect(computePlaySheet(build, ok.state, catalog).armor_class.total).toBe(16);
  });
});
