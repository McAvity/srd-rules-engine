// kenli F-013 T04 (R03-01): a magic weapon or armor whose data doesn't say what it's made from
// (category `weapon`/`armor`, no `base`) keeps its kind and is honestly `unknown` (judged by hand),
// never neutral gear; owning it stays allowed. Invented test content only (`source: test`).
import { describe, expect, it } from "vitest";
import {
  applyAction,
  assessInventoryItems,
  type Catalog,
  createCatalog,
  createState,
  type ItemAssessment,
} from "../src/index";
import { srdPack } from "../src/srd";
import { autocomplete, classBuild } from "./helpers";

const pack = {
  manifest: { id: "test-f013-t04", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
  magic_items: [
    {
      id: "test-incomplete-weapon",
      name: "Test Incomplete Weapon",
      category: "weapon",
      rarity: "common",
    },
    {
      id: "test-incomplete-armor",
      name: "Test Incomplete Armor",
      category: "armor",
      rarity: "common",
    },
    { id: "test-plain-ring", name: "Test Plain Ring", category: "ring", rarity: "common" },
  ],
};
const catalog: Catalog = createCatalog([srdPack, pack], {});
const wizard = autocomplete(classBuild("wizard"), catalog);
const state = createState(wizard, catalog);
const assess = (item: string) =>
  assessInventoryItems(wizard, state, catalog, [
    { table: "magic_items", item },
  ])[0] as ItemAssessment;

describe("R03-01: incomplete magic weapon/armor data", () => {
  it("a magic weapon without a base: kind weapon, proficiency unknown, said why (by hand)", () => {
    const a = assess("test-incomplete-weapon");
    expect(a.found).toBe(true);
    expect(a.kind).toBe("weapon");
    expect(a.base).toBeNull();
    expect(a.bases).toBeNull();
    expect(a.proficiency.status).toBe("unknown");
    expect(a.mastery.status).toBe("unknown");
    expect(a.proficiency.reason.code).toBe("item.base_unknown");
    expect(a.restrictions).toEqual([
      expect.objectContaining({ code: "base_unknown", effect: "note", evaluation: "manual" }),
    ]);
    expect(a.issues).toEqual([]);
  });

  it("a magic armor without a base: kind armor, training unknown", () => {
    const a = assess("test-incomplete-armor");
    expect(a.kind).toBe("armor");
    expect(a.proficiency.status).toBe("unknown");
    expect(a.restrictions.map((r) => r.code)).toEqual(["base_unknown"]);
  });

  it("an ordinary ring stays neutral gear; owning the incomplete weapon is allowed", () => {
    const ring = assess("test-plain-ring");
    expect(ring.kind).toBe("gear");
    expect(ring.proficiency.status).toBe("not_applicable");
    expect(ring.restrictions).toEqual([]);
    const added = applyAction(wizard, state, catalog, {
      type: "add_item",
      item: "test-incomplete-weapon",
    }).state;
    expect(added.inventory.some((i) => i.item === "test-incomplete-weapon")).toBe(true);
  });
});
