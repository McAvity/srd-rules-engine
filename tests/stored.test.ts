import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  applyAction,
  type CharacterState,
  combatantFromCharacter,
  computePlaySheet,
  createState,
  type PlayAction,
  PlayError,
  parseState,
  reconcileState,
  rollByHand,
  scriptedRng,
  stateVersion,
  validateState,
} from "../src/index";
import { catalog, fighterBuild } from "./helpers";

// Stored items (kenli F-005 DEC-01, variant A): `ItemInstance.location: "stored"` keeps an item
// owned but off the character: no weight, attack line or magic, no equip/attune/use until it's
// taken back; selling and removing it work. A state with one is version 2 (an older engine
// refuses it); every other state stays version 1 with its bytes.

const fighter = fighterBuild(); // Chain Mail worn, Greatsword, Str 17
const fresh = createState(fighter, catalog);
const act = (s: CharacterState, ...actions: PlayAction[]) => {
  let state = s;
  const notes: string[] = [];
  for (const a of actions) {
    const r = applyAction(fighter, state, catalog, a, { rng: scriptedRng([4, 4, 4, 4]) });
    state = r.state;
    notes.push(...r.notes);
  }
  return { state, notes, sheet: computePlaySheet(fighter, state, catalog) };
};
const idOf = (s: CharacterState, item: string) =>
  s.inventory.find((i) => i.item === item)?.id as string;
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

describe("stored items: the document", () => {
  it("a state without stored items keeps version 1 and its bytes through parse and JSON", () => {
    expect(fresh.version).toBe(1);
    expect(json(parseState(JSON.parse(json(fresh))))).toBe(json(fresh));
    expect(fresh.inventory.every((i) => !("location" in i))).toBe(true);
    // An action on it doesn't add the key either.
    const healed = act(fresh, { type: "damage", amount: 1 }).state;
    expect(healed.version).toBe(1);
    expect(healed.inventory.every((i) => !("location" in i))).toBe(true);
  });

  it("storing makes it version 2 with location kept through JSON; taking it back is version 1 with the same bytes", () => {
    const sword = idOf(fresh, "greatsword");
    const { state: stored, notes } = act(fresh, { type: "store", id: sword, stored: true });
    expect(notes).toContain("Greatsword put away (stored: not carried).");
    expect(stored.version).toBe(2);
    expect(stateVersion(stored)).toBe(2);
    expect(stored.inventory.find((i) => i.id === sword)?.location).toBe("stored");
    const roundtrip = parseState(JSON.parse(json(stored)));
    expect(json(roundtrip)).toBe(json(stored));
    expect(validateState(fighter, roundtrip, catalog)).toEqual([]);
    const back = act(stored, { type: "store", id: sword, stored: false }).state;
    expect(back.version).toBe(1);
    expect(json(back)).toBe(json(fresh));
  });

  it("a version 2 state without a stored item is written as 1; a version 1 with one, as 2", () => {
    expect(parseState({ ...fresh, version: 2 }).version).toBe(1);
    const inventory = fresh.inventory.map((i, n) => (n === 1 ? { ...i, location: "stored" } : i));
    expect(parseState({ ...fresh, inventory }).version).toBe(2);
  });

  it("the generated JSON Schema accepts a stored state and refuses an unknown location", () => {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "schemas", "state.schema.json"), "utf-8"),
    );
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    const stored = act(fresh, { type: "store", id: idOf(fresh, "greatsword"), stored: true }).state;
    expect(validate(JSON.parse(json(stored)))).toBe(true);
    const odd = {
      ...stored,
      inventory: stored.inventory.map((i) => ({ ...i, location: "camp" })),
    };
    expect(validate(JSON.parse(json(odd)))).toBe(false);
  });

  it("an unknown location is refused, not dropped", () => {
    const inventory = fresh.inventory.map((i) => ({ ...i, location: "camp" }));
    expect(() => parseState({ ...fresh, inventory })).toThrow();
  });
});

describe("stored items: the rules", () => {
  it("an equipped item must be taken off first; refused with nothing changed", () => {
    const armor = idOf(fresh, "chain-mail");
    expect(refusal(() => act(fresh, { type: "store", id: armor, stored: true }))).toEqual([
      "refusal.unequip_first",
    ]);
    const off = act(fresh, { type: "equip", id: armor, equipped: false }).state;
    const stored = act(off, { type: "store", id: armor, stored: true });
    expect(stored.state.inventory.find((i) => i.id === armor)).toMatchObject({
      location: "stored",
      equipped: false,
    });
    expect(stored.sheet.armor_class.total).toBe(12);
  });

  it("not carried: no weight, no attack line, still listed with its location", () => {
    const before = computePlaySheet(fighter, fresh, catalog);
    const sword = idOf(fresh, "greatsword");
    const { sheet } = act(fresh, { type: "store", id: sword, stored: true });
    const greatsword = 6;
    expect(sheet.play.carried_weight).toBe(before.play.carried_weight - greatsword);
    expect(before.attacks.some((a) => a.name === "Greatsword")).toBe(true);
    expect(sheet.attacks.some((a) => a.name === "Greatsword")).toBe(false);
    expect(sheet.play.inventory.find((i) => i.id === sword)).toMatchObject({
      location: "stored",
      weight: greatsword,
    });
    expect(before.play.inventory.every((i) => !("location" in i))).toBe(true);
  });

  it("can't be equipped, attuned to or used until taken back", () => {
    let s = act(fresh, { type: "add_item", item: "potion-of-healing" }).state;
    const potion = idOf(s, "potion-of-healing");
    const sword = idOf(s, "greatsword");
    s = act(
      s,
      { type: "store", id: potion, stored: true },
      { type: "store", id: sword, stored: true },
    ).state;
    expect(refusal(() => act(s, { type: "equip", id: sword, equipped: true }))).toEqual([
      "refusal.item_stored",
    ]);
    expect(refusal(() => act(s, { type: "use_item", id: potion }))).toEqual([
      "refusal.item_stored",
    ]);
    s = act(s, { type: "add_item", item: "scarab-of-protection" }).state;
    const scarab = idOf(s, "scarab-of-protection");
    s = act(s, { type: "store", id: scarab, stored: true }).state;
    expect(refusal(() => act(s, { type: "attune", id: scarab, attuned: true }))).toEqual([
      "refusal.item_stored",
    ]);
    const back = act(
      s,
      { type: "store", id: sword, stored: false },
      { type: "equip", id: sword, equipped: true },
    );
    expect(back.state.inventory.find((i) => i.id === sword)?.equipped).toBe(true);
  });

  it("attunement is kept while stored, without its effect", () => {
    let s = act(fresh, { type: "add_item", item: "scarab-of-protection" }).state;
    const scarab = idOf(s, "scarab-of-protection");
    s = act(s, { type: "attune", id: scarab, attuned: true }).state;
    const ac = computePlaySheet(fighter, s, catalog).armor_class.total;
    expect(ac).toBe(18); // Chain Mail 16 + Defense 1 + Scarab 1
    const stored = act(s, { type: "store", id: scarab, stored: true });
    expect(stored.sheet.armor_class.total).toBe(17);
    expect(stored.sheet.play.inventory.find((i) => i.id === scarab)).toMatchObject({
      attuned: true,
      active: false,
    });
    expect(stored.sheet.play.attuned).toBe(1);
    const back = act(stored.state, { type: "store", id: scarab, stored: false });
    expect(back.sheet.armor_class.total).toBe(18);
  });

  it("sold or removed while stored: gone; with no stored item left, version 1", () => {
    const sword = idOf(fresh, "greatsword");
    const stored = act(fresh, { type: "store", id: sword, stored: true }).state;
    const sold = act(stored, { type: "sell", id: sword });
    expect(sold.state.inventory.some((i) => i.id === sword)).toBe(false);
    expect(sold.state.currency.gp).toBe(fresh.currency.gp + 25); // half of 50 gp
    expect(sold.state.version).toBe(1);
    const removed = act(stored, { type: "remove_item", id: sword }).state;
    expect(removed.inventory.some((i) => i.id === sword)).toBe(false);
    expect(removed.version).toBe(1);
  });

  it("an added or bought item is carried and not merged into a stored stack", () => {
    let s = act(fresh, { type: "add_item", item: "torch", qty: 2 }).state;
    const torches = idOf(s, "torch");
    s = act(s, { type: "store", id: torches, stored: true }).state;
    s = act(s, { type: "add_item", item: "torch", qty: 1 }).state;
    const all = s.inventory.filter((i) => i.item === "torch");
    expect(all.map((i) => [i.qty, i.location ?? "carried"])).toEqual([
      [2, "stored"],
      [1, "carried"],
    ]);
    const bought = act(s, { type: "buy", item: "torch" }).state;
    expect(bought.inventory.find((i) => i.id === torches)?.qty).toBe(2);
  });

  it("an edited document with a stored item marked worn: validateState says so, reconcileState takes it off", () => {
    const inventory = fresh.inventory.map((i) =>
      i.item === "chain-mail" ? { ...i, location: "stored" as const } : i,
    );
    const odd = parseState({ ...fresh, inventory });
    expect(validateState(fighter, odd, catalog).map((i) => i.detail.code)).toContain(
      "state.stored_equipped",
    );
    const fixed = reconcileState(fighter, odd, catalog).state;
    expect(fixed.inventory.find((i) => i.item === "chain-mail")).toMatchObject({
      location: "stored",
      equipped: false,
    });
    expect(validateState(fighter, fixed, catalog)).toEqual([]);
  });

  it("a stored weapon can't be rolled by hand (no attack line)", () => {
    const stored = act(fresh, { type: "store", id: idOf(fresh, "greatsword"), stored: true }).state;
    const options = { rng: scriptedRng([10, 4, 4]), catalog };
    const carried = combatantFromCharacter(fighter, fresh, catalog);
    expect(() =>
      rollByHand(carried, { type: "attack", attack: "Greatsword" }, options),
    ).not.toThrow();
    const without = combatantFromCharacter(fighter, stored, catalog);
    expect(() => rollByHand(without, { type: "attack", attack: "Greatsword" }, options)).toThrow();
  });
});
