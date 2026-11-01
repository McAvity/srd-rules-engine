import { describe, expect, it } from "vitest";
import { builder, createCatalog, createState, gainLevelItems, levelItems } from "../src/index";
import { srdPack } from "../src/srd";
import { autocomplete, classBuild, levelUpIn } from "./helpers";

// kenli F-002 T12 (D043): the items a level gained in play grants (an XPHB Assassin's Tools-like
// subclass gift at Rogue 3, here a test patch on the SRD Thief), added once and free.

const pack = {
  manifest: { id: "test-level-items", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
  patches: [
    {
      target: "subclasses/thief",
      op: "set",
      path: "features.3.items",
      value: [
        { item: "disguise-kit", qty: 1 },
        { item: "poisoners-kit", qty: 1 },
      ],
    },
  ],
};
const cat = createCatalog([srdPack, pack], {});
const rogue2 = levelUpIn(autocomplete(classBuild("rogue"), cat), "rogue", 1, null, cat);
const rogue3 = autocomplete(
  builder.setChoice(levelUpIn(rogue2, "rogue", 1, null, cat), cat, "class:rogue:3#subclass", [
    "thief",
  ]).build,
  cat,
);
const rogue4 = levelUpIn(rogue3, "rogue", 1, null, cat);

describe("D043: items a gained level grants", () => {
  it("Rogue 2 → 3 (the subclass's level 3 feature): both kits, once each", () => {
    expect(levelItems(rogue2, rogue3, cat).map((i) => [i.item, i.qty])).toEqual([
      ["disguise-kit", 1],
      ["poisoners-kit", 1],
    ]);
    expect(levelItems(rogue3, rogue4, cat)).toEqual([]);
  });

  it("added free to the state; coins and other items unchanged; the input state untouched", () => {
    const s2 = {
      ...createState(rogue2, cat),
      currency: { cp: 3, sp: 0, ep: 0, gp: 75, pp: 0 },
    };
    const before = structuredClone(s2);
    const r = gainLevelItems(rogue2, rogue3, s2, cat);
    expect(r.items.map((i) => i.name)).toEqual(["Disguise Kit", "Poisoner's Kit"]);
    expect(r.state.currency).toEqual(s2.currency);
    expect(r.state.inventory.length).toBe(s2.inventory.length + 2);
    expect(r.state.inventory.filter((i) => i.item === "disguise-kit").map((i) => i.qty)).toEqual([
      1,
    ]);
    expect(r.messages.map((m) => m.code)).toEqual(["play.level_items"]);
    expect(s2).toEqual(before);
    // The next level gives nothing again: no duplicate.
    const r4 = gainLevelItems(rogue3, rogue4, r.state, cat);
    expect(r4.items).toEqual([]);
    expect(r4.state).toBe(r.state);
  });

  it("without the patch (plain SRD Thief): nothing", () => {
    const plain = createCatalog([srdPack], {});
    expect(levelItems(rogue2, rogue3, plain)).toEqual([]);
  });
});
