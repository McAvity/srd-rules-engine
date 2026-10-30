import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  applyAction,
  type CharacterState,
  CUSTOM_STATE_VERSION,
  combatantFromCharacter,
  computePlaySheet,
  createState,
  DOCUMENT_VERSION,
  type PlayAction,
  PlayError,
  parseState,
  reconcileState,
  stateVersion,
  validateState,
} from "../src/index";
import { catalog, fighterBuild } from "./helpers";

// Custom items (kenli F-011 contracts/changes.md §6): `ItemInstance.item: null` with `custom`
// {name, description, weight_lb}. The same inventory and the same carried weight as catalog items;
// no rules at all (never worn, attuned, charged, sold, attacked with). A state with one is version 3
// (an older engine refuses it); every other state keeps version 1 or 2 with its bytes.

const fighter = fighterBuild(); // Chain Mail worn, Greatsword, Str 17
const fresh = createState(fighter, catalog);
const act = (s: CharacterState, ...actions: PlayAction[]) => {
  let state = s;
  const notes: string[] = [];
  for (const a of actions) {
    const r = applyAction(fighter, state, catalog, a);
    state = r.state;
    notes.push(...r.notes);
  }
  return { state, notes, sheet: computePlaySheet(fighter, state, catalog) };
};
const add = (name: string, weight_lb: number | null, extra: Partial<PlayAction> = {}): PlayAction =>
  ({ type: "add_custom_item", name, description: "", weight_lb, ...extra }) as PlayAction;
const customIds = (s: CharacterState) => s.inventory.filter((i) => i.custom).map((i) => i.id);
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PlayError) return e.details.map((m) => m.code);
    throw e;
  }
  throw new Error("not refused");
};
const json = (x: unknown) => JSON.stringify(x);
const base = act(fresh).sheet.play;

describe("custom items: adding, removing, storing", () => {
  it("add_custom_item adds a new line each time, never merged by name, with distinct ids", () => {
    const { state, notes } = act(
      fresh,
      add("Strange idol", 2),
      add("Strange idol", 2),
      add("  Strange idol  ", null, { qty: 3 } as Partial<PlayAction>),
    );
    const ids = customIds(state);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => !fresh.inventory.some((i) => i.id === id))).toBe(true);
    expect(state.inventory.filter((i) => i.custom).map((i) => [i.custom?.name, i.qty])).toEqual([
      ["Strange idol", 1],
      ["Strange idol", 1],
      ["Strange idol", 3],
    ]);
    expect(state.next_item).toBe(fresh.next_item + 3);
    expect(notes).toContain("Strange idol added (1).");
    expect(state.version).toBe(CUSTOM_STATE_VERSION);
  });

  it("the line is exactly the contract's shape", () => {
    const { state } = act(fresh, {
      type: "add_custom_item",
      name: "Letter",
      description: "Sealed, <b>not</b> markup.",
      weight_lb: 0,
    });
    expect(state.inventory.at(-1)).toEqual({
      id: `i${fresh.next_item}`,
      item: null,
      custom: { name: "Letter", description: "Sealed, <b>not</b> markup.", weight_lb: 0 },
      base: null,
      variant: null,
      qty: 1,
      equipped: false,
      attuned: false,
      charges_spent: 0,
      notes: "",
    });
  });

  it("remove_item takes some or all; removing the last custom line goes back to version 1 and the same bytes", () => {
    const { state } = act(fresh, add("Rope bundle", 1, { qty: 5 } as Partial<PlayAction>));
    const id = customIds(state)[0] as string;
    const less = act(state, { type: "remove_item", id, qty: 2 }).state;
    expect(less.inventory.find((i) => i.id === id)?.qty).toBe(3);
    const gone = act(less, { type: "remove_item", id }).state;
    expect(customIds(gone)).toEqual([]);
    expect(gone.version).toBe(1);
    // Nothing else lost; only next_item moved on.
    expect(json({ ...gone, next_item: fresh.next_item })).toBe(json(fresh));
  });

  it("store and take back: stored custom keeps version 3; with a stored catalog item, removing the custom is version 2", () => {
    const sword = fresh.inventory.find((i) => i.item === "greatsword")?.id as string;
    const { state } = act(fresh, add("Anvil", 300), { type: "store", id: sword, stored: true });
    const anvil = customIds(state)[0] as string;
    const stored = act(state, { type: "store", id: anvil, stored: true });
    expect(stored.state.inventory.find((i) => i.id === anvil)?.location).toBe("stored");
    expect(stored.state.version).toBe(3);
    expect(stored.notes).toContain("Anvil put away (stored: not carried).");
    const back = act(stored.state, { type: "store", id: anvil, stored: false }).state;
    expect(back.inventory.find((i) => i.id === anvil)?.location).toBeUndefined();
    const removed = act(back, { type: "remove_item", id: anvil }).state;
    expect(removed.version).toBe(2);
    expect(removed.inventory.find((i) => i.id === sword)?.location).toBe("stored");
  });

  it("refuses an empty or too long name, a too long description and a bad weight; nothing changes", () => {
    for (const name of ["", "   ", "x".repeat(121)])
      expect(refusal(() => act(fresh, add(name, 1)))).toEqual(["refusal.custom_item_name"]);
    expect(act(fresh, add("x".repeat(120), 1)).state.inventory.at(-1)?.custom?.name).toHaveLength(
      120,
    );
    expect(
      refusal(() =>
        act(fresh, {
          type: "add_custom_item",
          name: "Book",
          description: "y".repeat(4001),
          weight_lb: 1,
        }),
      ),
    ).toEqual(["refusal.custom_item_description"]);
    for (const w of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(refusal(() => act(fresh, add("Idol", w)))).toEqual(["refusal.custom_item_weight"]);
    expect(() => act(fresh, add("Idol", 1, { qty: 0 } as Partial<PlayAction>))).toThrow();
  });
});

describe("custom items: weight", () => {
  it("known weights × qty add to carried_weight; unknown is counted apart, never as 0; 0 is known", () => {
    const { sheet, state } = act(
      fresh,
      add("Herb pouch", 2.5, { qty: 3 } as Partial<PlayAction>),
      add("Strange idol", null, { qty: 2 } as Partial<PlayAction>),
      add("Letter", 0, { qty: 4 } as Partial<PlayAction>),
    );
    const p = sheet.play;
    expect(p.carried_weight).toBeCloseTo(base.carried_weight + 7.5);
    expect(p.carried_weight_unknown).toBe(1);
    const lines = p.inventory.filter((i) => i.item === null);
    expect(lines.map((i) => [i.name, i.category, i.weight, i.custom])).toEqual([
      ["Herb pouch", "custom", 2.5, { name: "Herb pouch", description: "" }],
      ["Strange idol", "custom", null, { name: "Strange idol", description: "" }],
      ["Letter", "custom", 0, { name: "Letter", description: "" }],
    ]);
    // Storing them takes the known weight out and the unknown one out of the count.
    const idol = customIds(state)[1] as string;
    const pouch = customIds(state)[0] as string;
    const stored = act(
      state,
      { type: "store", id: idol, stored: true },
      { type: "store", id: pouch, stored: true },
    ).sheet.play;
    expect(stored.carried_weight).toBeCloseTo(base.carried_weight);
    expect(stored.carried_weight_unknown).toBe(0);
  });

  it("a state without custom items reports carried_weight_unknown 0 and the same carried_weight", () => {
    expect(base.carried_weight_unknown).toBe(0);
    expect(computePlaySheet(fighter, fresh, catalog).play.carried_weight).toBe(base.carried_weight);
  });
});

describe("custom items: no rules", () => {
  const { state } = act(fresh, add("Idol", 1));
  const id = customIds(state)[0] as string;

  it("can't be worn, attuned to, used, charged or sold", () => {
    for (const a of [
      { type: "equip", id, equipped: true },
      { type: "attune", id, attuned: true },
      { type: "use_item", id },
      { type: "set_charges", id, spent: 1 },
      { type: "sell", id },
    ] as PlayAction[])
      expect(refusal(() => act(state, a))).toEqual(["refusal.custom_item_not_usable"]);
    expect(() => act(state, { type: "equip", id, equipped: true })).toThrow(
      /custom item: it can't be worn/,
    );
  });

  it("changes no AC, attack, equipment, attunement or gold; validateState and reconcileState accept it", () => {
    const before = computePlaySheet(fighter, fresh, catalog);
    const after = computePlaySheet(fighter, state, catalog);
    expect(after.armor_class).toEqual(before.armor_class);
    expect(after.attacks).toEqual(before.attacks);
    expect(after.equipment).toEqual(before.equipment);
    expect(after.play.attuned).toBe(before.play.attuned);
    expect(after.play.currency).toEqual(before.play.currency);
    expect(state.currency).toEqual(fresh.currency);
    const line = after.play.inventory.find((i) => i.id === id);
    expect(line).toMatchObject({
      equipped: false,
      attuned: false,
      active: false,
      charges: null,
      requires_attunement: false,
    });
    expect(validateState(fighter, state, catalog)).toEqual([]);
    const r = reconcileState(fighter, state, catalog);
    expect(json(r.state)).toBe(json(state));
    expect(r.notes).toEqual([]);
    const c = combatantFromCharacter(fighter, state, catalog);
    const c0 = combatantFromCharacter(fighter, fresh, catalog);
    expect(c.armor_class).toBe(c0.armor_class);
    expect(c.attacks).toEqual(c0.attacks);
  });

  it("add_item of a catalog item never merges into a custom line", () => {
    const named = act(fresh, add("Rope", 1)).state;
    const roped = act(named, { type: "add_item", item: "rope" }).state;
    expect(roped.inventory.filter((i) => i.custom)).toHaveLength(1);
    expect(roped.inventory.filter((i) => i.item === "rope")).toHaveLength(1);
  });
});

describe("custom items: the document", () => {
  const { state } = act(fresh, add("Strange idol", null), add("Letter", 0.25));

  it("version 3 is written only with a custom item and roundtrips exactly", () => {
    expect(DOCUMENT_VERSION).toBe(3);
    expect(stateVersion(state)).toBe(3);
    const text = json(state);
    const back = parseState(JSON.parse(text));
    expect(json(back)).toBe(text);
    expect(back.inventory.filter((i) => i.custom).map((i) => i.custom?.weight_lb)).toEqual([
      null,
      0.25,
    ]);
  });

  it("old states keep their version and bytes: v1, v2 with a stored item", () => {
    expect(fresh.version).toBe(1);
    expect(json(parseState(JSON.parse(json(fresh))))).toBe(json(fresh));
    const sword = fresh.inventory.find((i) => i.item === "greatsword")?.id as string;
    const v2 = act(fresh, { type: "store", id: sword, stored: true }).state;
    expect(v2.version).toBe(2);
    expect(json(parseState(JSON.parse(json(v2))))).toBe(json(v2));
    // A document without a version, and catalog lines without the defaults, still read as before.
    const bare = parseState({ inventory: [{ id: "i1", item: "rope" }] });
    expect(bare.version).toBe(1);
    expect(bare.inventory[0]).toEqual({
      id: "i1",
      item: "rope",
      base: null,
      variant: null,
      qty: 1,
      equipped: false,
      attuned: false,
      charges_spent: 0,
      notes: "",
    });
  });

  it("a declared version is recomputed: v3 without a custom item reads as 1, v1 with one reads as 3", () => {
    expect(parseState({ ...fresh, version: 3 }).version).toBe(1);
    expect(parseState({ ...JSON.parse(json(state)), version: 1 }).version).toBe(3);
    expect(() => parseState({ ...fresh, version: 4 })).toThrow(/saved by a newer srd-rules-engine/);
  });

  const line = state.inventory.find((i) => i.custom) as Record<string, unknown>;
  const withLine = (patch: Record<string, unknown>, drop: string[] = []) => {
    const l: Record<string, unknown> = { ...line, ...patch };
    for (const k of drop) delete l[k];
    return { ...JSON.parse(json(state)), inventory: [l] };
  };
  it.each([
    ["a catalog id with custom fields", { item: "rope" }, []],
    ["item null without custom", {}, ["custom"]],
    ["a base on a custom item", { base: "longsword" }, []],
    ["a kind on a custom item", { variant: "fire" }, []],
    ["worn", { equipped: true }, []],
    ["attuned", { attuned: true }, []],
    ["charged", { charges_spent: 1 }, []],
    ["notes", { notes: "x" }, []],
    ["an empty name", { custom: { name: "", description: "", weight_lb: null } }, []],
    ["an untrimmed name", { custom: { name: " Idol", description: "", weight_lb: null } }, []],
    [
      "a 121-character name",
      { custom: { name: "x".repeat(121), description: "", weight_lb: null } },
      [],
    ],
    [
      "a 4001-character description",
      { custom: { name: "Idol", description: "y".repeat(4001), weight_lb: null } },
      [],
    ],
    ["a negative weight", { custom: { name: "Idol", description: "", weight_lb: -1 } }, []],
    ["a string weight", { custom: { name: "Idol", description: "", weight_lb: "5" } }, []],
    [
      "an unknown custom field",
      { custom: { name: "Idol", description: "", weight_lb: 1, url: "https://x" } },
      [],
    ],
    ["a missing weight", { custom: { name: "Idol", description: "" } }, []],
  ])("refuses a contradictory or bad line: %s", (_why, patch, drop) => {
    expect(() => parseState(withLine(patch, drop))).toThrow();
  });

  it("the JSON Schema accepts the v3 state and its action", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const schema = (n: string) =>
      ajv.compile(JSON.parse(readFileSync(join(import.meta.dirname, "..", "schemas", n), "utf-8")));
    const stateOk = schema("state.schema.json");
    expect(stateOk(JSON.parse(json(state))), JSON.stringify(stateOk.errors)).toBe(true);
    const actionOk = schema("play-action.schema.json");
    expect(actionOk(add("Idol", null))).toBe(true);
    // review03 R03-01: `custom` itself is closed in the schema too; the line-level rule (no unknown
    // key beside `item: null`) is the reader's (parseState), the schema's line stays as before.
    const bad = (l: Record<string, unknown>) => ({ ...JSON.parse(json(state)), inventory: [l] });
    expect(stateOk(bad({ ...line, custom: { ...(line.custom as object), url: "x" } }))).toBe(false);
    expect(stateOk(bad({ id: "i1", item: "rope", extra: 1 }))).toBe(true); // catalog: as before
  });

  // review03 R03-01: a custom line is refused with any unknown key, never read with it dropped.
  it("parseState refuses an unknown field on a custom line, at its top level and inside custom", () => {
    const custom = {
      id: "i1",
      item: null,
      custom: { name: "Idol", description: "", weight_lb: null },
    };
    const unknown = (l: unknown) => () => parseState({ version: 3, inventory: [l] });
    expect(unknown({ ...custom, extra: "must not disappear" })).toThrow(
      /unrecognized_keys[\s\S]*"extra"/,
    );
    expect(unknown({ ...custom, custom: { ...custom.custom, url: "x" } })).toThrow(
      /unrecognized_keys[\s\S]*"url"/,
    );
    expect(unknown({ ...custom, location: "stored", origin: "x" })).toThrow(
      /unrecognized_keys[\s\S]*"origin"/,
    );
    expect(parseState({ version: 3, inventory: [custom] }).inventory[0]).toEqual({
      ...custom,
      base: null,
      variant: null,
      qty: 1,
      equipped: false,
      attuned: false,
      charges_spent: 0,
      notes: "",
    });
  });

  it("a catalog line keeps its old reading: unknown keys dropped as before, v1/v2 bytes unchanged", () => {
    const read = parseState({ inventory: [{ id: "i1", item: "rope", extra: 1, qty: 2 }] });
    expect(read.version).toBe(1);
    expect(json(read.inventory[0])).toBe(
      json({
        id: "i1",
        item: "rope",
        base: null,
        variant: null,
        qty: 2,
        equipped: false,
        attuned: false,
        charges_spent: 0,
        notes: "",
      }),
    );
    const sword = fresh.inventory.find((i) => i.item === "greatsword")?.id as string;
    const v2 = act(fresh, { type: "store", id: sword, stored: true }).state;
    expect(json(parseState(JSON.parse(json(v2))))).toBe(json(v2));
    expect(json(parseState(JSON.parse(json(fresh))))).toBe(json(fresh));
    // Its errors stay specific (a union would say only "Invalid input" at the line).
    expect(() => parseState({ inventory: [{ id: "i1", item: "rope", location: "home" }] })).toThrow(
      /"invalid_value"[\s\S]*"location"[\s\S]*expected/,
    );
  });
});
