// kenli F-013 T07 (main integration): one price for every API after the merge of F-013's
// `listedPrice`/`assessInventoryItems` with F-002's `itemQuote`/`stockItems`. Expected values are
// the SRD's (Lute "35 GP, 2 lb." = 3500 CP; Arrows 1 GP for 20; magic items unlisted), checked
// against what `buy` and `stockItems` actually charge.
import { describe, expect, it } from "vitest";
import {
  applyAction,
  assessInventoryItems,
  type CharacterState,
  createState,
  type ItemTable,
  itemQuote,
  listedPrice,
  PlayError,
  purseValue,
  stockItems,
} from "../src/index";
import { catalog, fighterBuild } from "./helpers";

const fighter = fighterBuild();
const rich: CharacterState = {
  ...createState(fighter, catalog),
  currency: { cp: 0, sp: 0, ep: 0, gp: 100, pp: 0 },
};
const SRD = {
  lute: { table: "tools", cp: 3500, bundle: 1 },
  arrow: { table: "gear", cp: 100, bundle: 20 },
  rope: { table: "gear", cp: 100, bundle: 1 },
  "shield-1": { table: "magic_items", cp: null, bundle: 1 },
  "weapon-1": { table: "magic_items", cp: null, bundle: 1 },
} as const;

describe("one price across listedPrice, itemQuote, the assessment, buy and stockItems", () => {
  it("each API reports the SRD price and bundle", () => {
    const assessed = assessInventoryItems(
      fighter,
      rich,
      catalog,
      Object.entries(SRD).map(([item, x]) => ({ table: x.table as ItemTable, item })),
    );
    for (const [i, [item, want]] of Object.entries(SRD).entries()) {
      expect(listedPrice(catalog, item)).toMatchObject({ cp: want.cp, bundle: want.bundle });
      expect(itemQuote(catalog, item)).toMatchObject({ item, cp: want.cp, bundle: want.bundle });
      expect(assessed[i]).toMatchObject({ price_cp: want.cp, bundle: want.bundle });
    }
  });

  it("buy charges exactly that price once and gives the bundle", () => {
    for (const item of ["lute", "arrow", "rope"] as const) {
      const owned = (s: CharacterState) =>
        s.inventory.filter((x) => x.item === item).reduce((n, x) => n + x.qty, 0);
      const after = applyAction(fighter, rich, catalog, { type: "buy", item }).state;
      expect(purseValue(rich.currency) - purseValue(after.currency)).toBe(SRD[item].cp);
      expect(owned(after) - owned(rich)).toBe(SRD[item].bundle);
    }
    expect(() => applyAction(fighter, rich, catalog, { type: "buy", item: "shield-1" })).toThrow(
      PlayError,
    );
  });

  it("stockItems buys whole bundles at the same price; all or nothing", () => {
    const owned = rich.inventory
      .filter((x) => x.item === "arrow" && !x.location && x.base === null)
      .reduce((n, x) => n + x.qty, 0);
    const r = stockItems(fighter, rich, catalog, [
      { item: "lute", units: 1, equip: false },
      { item: "arrow", units: owned + 25, equip: false },
    ]);
    const [lute, arrows] = r.lines;
    expect(lute).toMatchObject({ bundles: 1, price_cp: 3500, cost_cp: 3500, received: 1 });
    expect(arrows).toMatchObject({
      bundles: 2,
      bundle: 20,
      price_cp: 100,
      cost_cp: 200,
      received: 40,
    });
    expect(r.spent_cp).toBe(3500 + 200);
    // An unpriced magic item refuses the whole list: nothing bought, the state unchanged.
    const before = JSON.stringify(rich);
    expect(() =>
      stockItems(fighter, rich, catalog, [
        { item: "lute", units: 1, equip: false },
        { item: "shield-1", units: 1, equip: false },
      ]),
    ).toThrow(/no listed price/);
    expect(JSON.stringify(rich)).toBe(before);
  });

  it("an unknown id: listedPrice null, the assessment unknown without a price, itemQuote refuses", () => {
    expect(listedPrice(catalog, "no-such-thing")).toBeNull();
    const [a] = assessInventoryItems(fighter, rich, catalog, [
      { table: "gear", item: "no-such-thing" },
    ]);
    expect(a).toMatchObject({ found: false, price_cp: null, bundle: 1 });
    expect(() => itemQuote(catalog, "no-such-thing")).toThrow(PlayError);
  });
});
