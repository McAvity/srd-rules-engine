import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyEncounterAction,
  builder,
  type CharacterBuild,
  type CharacterState,
  checkAction,
  combatantOptions,
  computePlaySheet,
  createCatalog,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  fixedRng,
  type Rng,
  scriptedRng,
} from "../src/index";
import { srdPack } from "../src/srd";
import { fighterBuild } from "./helpers";

// kenli F-002 T08: feat traits given as text only (Reactive Strike, Guardian, Halt), their named
// rules derived from the trait names. Invented test content only: a feat with those three traits.
const pack = {
  manifest: {
    id: "test-reaction-feats",
    version: "1.0.0",
    source: "test",
    requires: ["srd-5.2.1"],
  },
  feats: [
    {
      id: "test-warden",
      name: "Test Warden",
      category: "origin",
      grants: {
        traits: [
          { name: "Reactive Strike", text: "A Reaction attack when a creature enters your reach." },
          { name: "Guardian", text: "An Opportunity Attack against a creature within 5 feet." },
          { name: "Halt", text: "An Opportunity Attack's hit: Speed 0 for the rest of the turn." },
        ],
      },
    },
  ],
};
const catalog = createCatalog([srdPack, pack], {});

function brakka(feat = true): CharacterBuild {
  const b = fighterBuild();
  if (!feat) return b;
  const choices = Object.fromEntries(
    Object.entries(b.choices).filter(([k]) => !k.startsWith("feat:skilled@")),
  );
  return builder.setChoice({ ...b, choices }, catalog, "species:human#versatile", ["test-warden"])
    .build;
}
/** Brakka's state holding a Glaive (Heavy, Reach), or with only the Greatsword. */
function holding(b: CharacterBuild, glaive = true): CharacterState {
  const s = createState(b, catalog);
  if (!glaive) return s;
  const added = applyAction(b, s, catalog, { type: "add_item", item: "glaive" }).state;
  const id = added.inventory.find((i) => i.item === "glaive")?.id as string;
  const sword = added.inventory.find((i) => i.item === "greatsword")?.id as string;
  const off = applyAction(b, added, catalog, { type: "equip", id: sword, equipped: false }).state;
  return applyAction(b, off, catalog, { type: "equip", id, equipped: true }).state;
}

/** Brakka at (0,0); goblin A at 5 ft, goblin B at 10 ft (in the Glaive's reach); a goblin's turn. */
function session(b: CharacterBuild, state: CharacterState) {
  const characters: Record<string, { build: CharacterBuild; state: CharacterState }> = {
    brakka: { build: b, state },
  };
  let encounter: Encounter = createEncounter();
  const ctx = () => ({ catalog, characters });
  const act = (action: EncounterAction, rng: Rng = fixedRng(15)) => {
    const r = applyEncounterAction(encounter, action, { ...ctx(), rng });
    encounter = r.encounter;
    for (const [k, st] of Object.entries(r.states)) {
      const c = characters[k];
      if (c) characters[k] = { ...c, state: st };
    }
    return r;
  };
  act({ type: "add_character", character: "brakka" });
  act({ type: "add_monster", monster: "goblin-warrior" });
  act({ type: "add_monster", monster: "goblin-warrior" });
  act({ type: "place", id: "brakka", x: 0, y: 0 });
  act({ type: "place", id: "goblin-warrior", x: 1, y: 0 });
  act({ type: "place", id: "goblin-warrior-2", x: 2, y: 0 });
  act({ type: "set_initiative", id: "goblin-warrior", value: 20 });
  act({ type: "set_initiative", id: "brakka", value: 10 });
  act({ type: "set_initiative", id: "goblin-warrior-2", value: 5 });
  act({ type: "start" });
  return {
    act,
    get encounter() {
      return encounter;
    },
    get: (id: string) => encounter.combatants.find((c) => c.id === id),
    options: () => combatantOptions(encounter, "brakka", ctx()),
    check: (action: EncounterAction) => checkAction(encounter, action, ctx()),
  };
}
const attack = (target: string, extra: object): EncounterAction =>
  ({ type: "attack", id: "brakka", target, attack: "Glaive", ...extra }) as EncounterAction;

describe("rules derived from feat traits", () => {
  it("the feat's three traits give reactive_strike, guardian and halt; the held Glaive qualifies", () => {
    const b = brakka();
    const sheet = computePlaySheet(b, holding(b), catalog);
    expect(sheet.rules).toEqual(expect.arrayContaining(["reactive_strike", "guardian", "halt"]));
    expect(sheet.reactive_strike).toEqual(["Glaive"]);
    // A Greatsword is Heavy but not Reach: no Reactive Strike with it.
    expect(computePlaySheet(b, holding(b, false), catalog).reactive_strike).toEqual([]);
    const plain = brakka(false);
    const none = computePlaySheet(plain, holding(plain), catalog);
    expect(none.rules).not.toContain("reactive_strike");
    expect(none.reactive_strike).toEqual([]);
  });
});

describe("Reactive Strike: a Reaction attack, not an Opportunity Attack", () => {
  it("off its turn: offered in the reaction group; uses the reaction once; no Halt", () => {
    const b = brakka();
    const s = session(b, holding(b));
    const labels = s.options().attacks.map((o) => o.label);
    expect(labels).toContain("Glaive +5 · 1d10+3 slashing (Reactive Strike)");
    // Only with the held qualifying weapon (not the carried Greatsword).
    expect(labels.filter((l) => String(l).includes("Reactive Strike"))).toHaveLength(1);
    s.act(attack("goblin-warrior-2", { reactive_strike: true }));
    expect(s.get("brakka")?.used.reaction).toBe(true);
    expect(s.get("brakka")?.used.action).toBe(false);
    expect(s.encounter.marks.some((m) => m.kind === "speed_zero")).toBe(false);
    expect(() => s.act(attack("goblin-warrior", { reactive_strike: true }))).toThrow(
      /already used its reaction/,
    );
  });

  it("a Disengaged creature entering the reach can still be struck (it isn't an OA)", () => {
    const b = brakka();
    const s = session(b, holding(b));
    s.act({ type: "disengage", id: "goblin-warrior" } as EncounterAction);
    expect(() => s.act(attack("goblin-warrior", { opportunity: true }))).toThrow(/Disengaged/);
    s.act(attack("goblin-warrior", { reactive_strike: true }));
    expect(s.get("brakka")?.used.reaction).toBe(true);
  });

  it("refused without a qualifying held weapon, without the trait, and as an OA too", () => {
    const b = brakka();
    const sword = session(b, holding(b, false));
    expect(sword.options().attacks.some((o) => String(o.label).includes("Reactive Strike"))).toBe(
      false,
    );
    expect(() =>
      sword.act({
        type: "attack",
        id: "brakka",
        target: "goblin-warrior",
        attack: "Greatsword",
        reactive_strike: true,
      } as EncounterAction),
    ).toThrow(/can't make a Reactive Strike/);
    const plain = brakka(false);
    expect(() =>
      session(plain, holding(plain)).act(attack("goblin-warrior", { reactive_strike: true })),
    ).toThrow(/has no Reactive Strike/);
    expect(() =>
      session(b, holding(b)).act(
        attack("goblin-warrior", { reactive_strike: true, opportunity: true }),
      ),
    ).toThrow(/not an Opportunity Attack/);
  });
});

describe("Sentinel-like Guardian (5 ft) and Halt", () => {
  it("Guardian: within 5 ft, after a Disengage too; 10 ft away is refused, nothing spent", () => {
    const b = brakka();
    const s = session(b, holding(b));
    const guardian = s.options().attacks.find((o) => String(o.label).includes("Guardian"));
    expect(guardian?.targets?.ids).toEqual(["goblin-warrior"]);
    const far = s.check(attack("goblin-warrior-2", { opportunity: true, guardian: true }));
    expect(far.ok).toBe(false);
    expect(far.reasons.join(" ")).toMatch(/10 feet away: Guardian's Opportunity Attack/);
    s.act({ type: "disengage", id: "goblin-warrior" } as EncounterAction);
    s.act(attack("goblin-warrior", { opportunity: true, guardian: true }));
    expect(s.get("brakka")?.used.reaction).toBe(true);
  });

  it("Halt: an Opportunity Attack's hit sets Speed 0 for the rest of the turn; a miss doesn't", () => {
    const b = brakka();
    const s = session(b, holding(b));
    s.act(attack("goblin-warrior", { opportunity: true }), fixedRng(2));
    expect(s.encounter.marks.some((m) => m.kind === "speed_zero")).toBe(false);
    const t = session(b, holding(b));
    // A hit for 1d10 (1) + 3: the goblin is still up.
    const hit = t.act(attack("goblin-warrior", { opportunity: true }), scriptedRng([15, 1]));
    expect(hit.notes).toContain(
      "Goblin Warrior's Speed is 0 for the rest of the turn (Brakka's Halt).",
    );
    expect(t.encounter.marks.find((m) => m.kind === "speed_zero")?.on).toBe("goblin-warrior");
    expect(() =>
      t.act({ type: "move", id: "goblin-warrior", to: { x: 1, y: 1 } } as EncounterAction),
    ).toThrow(/Speed is 0|can move 0 more feet/);
    // The goblin's turn ends: the mark with it; its next turn it moves again.
    t.act({ type: "next_turn" });
    expect(t.encounter.marks.some((m) => m.kind === "speed_zero")).toBe(false);
  });
});
