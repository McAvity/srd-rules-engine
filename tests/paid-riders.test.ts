import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyEncounterAction,
  builder,
  type CharacterBuild,
  type CharacterState,
  combatantFromCharacter,
  computePlaySheet,
  createCatalog,
  createEncounter,
  createState,
  type Encounter,
  type EncounterAction,
  rollByHand,
  scriptedRng,
} from "../src/index";
import { srdPack } from "../src/srd";
import { fighterBuild } from "./helpers";

// A damage rider paid with a limited use (`uses`): one use per application, refused when none is
// left. Invented test content only: an origin feat with a 2-use pool and a d6 rider spending it.
const pack = {
  manifest: { id: "test-paid-riders", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
  feats: [
    {
      id: "test-focus-strike",
      name: "Test Focus Strike",
      category: "origin",
      grants: {
        resources: [{ id: "test-focus", name: "Test Focus", max: { value: 2 }, recharge: "short" }],
        damage_riders: [
          {
            id: "test-focus-strike",
            name: "Test Focus Strike",
            damage: "1d6",
            applies_to: { weapon: true },
            uses: "test-focus",
          },
        ],
      },
    },
  ],
};
const catalog = createCatalog([srdPack, pack], {});
const key = "feat:test-focus-strike@species:human#versatile:test-focus";

function brakka(): CharacterBuild {
  const b = fighterBuild();
  const choices = Object.fromEntries(
    Object.entries(b.choices).filter(([k]) => !k.startsWith("feat:skilled@")),
  );
  return builder.setChoice({ ...b, choices }, catalog, "species:human#versatile", [
    "test-focus-strike",
  ]).build;
}

describe("paid damage riders", () => {
  it("the attack line lists the rider with the use it spends; unpaid riders are unchanged", () => {
    const build = brakka();
    const sheet = computePlaySheet(build, createState(build, catalog), catalog);
    const sword = sheet.attacks.find((a) => a.name === "Greatsword");
    expect(sword?.riders).toContainEqual(
      expect.objectContaining({ id: "test-focus-strike", dice: "1d6", uses: key }),
    );
    expect(sheet.play.uses).toContainEqual(expect.objectContaining({ key, max: 2 }));
    // Older content (an unpaid optional rider) has no `uses`.
    const rogue = computePlaySheet(build, createState(build, catalog), catalog).attacks.flatMap(
      (a) => a.riders,
    );
    expect(
      rogue.filter((r) => r.id !== "test-focus-strike").every((r) => r.uses === undefined),
    ).toBe(true);
  });

  it("rolled by hand: the use is a cost to apply, once per application; none left refuses", () => {
    const build = brakka();
    let state: CharacterState = createState(build, catalog);
    const attack = {
      type: "attack",
      attack: "Greatsword",
      riders: [{ rider: "test-focus-strike" }],
    } as const;
    for (let i = 0; i < 2; i++) {
      const me = combatantFromCharacter(build, state, catalog);
      const r = rollByHand(me, attack, {
        catalog,
        character: { build, state },
        rng: scriptedRng([15, 4, 3, 6]),
      });
      expect(r.costs).toEqual([{ type: "play", action: { type: "use", key } }]);
      for (const cost of r.costs) {
        if (cost.type === "play") state = applyAction(build, state, catalog, cost.action).state;
      }
    }
    expect(state.uses_spent[key]).toBe(2);
    const me = combatantFromCharacter(build, state, catalog);
    expect(() =>
      rollByHand(me, attack, { catalog, character: { build, state }, rng: scriptedRng([]) }),
    ).toThrow("Test Focus: 0 left");
    // Without the rider nothing is spent.
    const plain = rollByHand(
      me,
      { type: "attack", attack: "Greatsword" },
      {
        catalog,
        character: { build, state },
        rng: scriptedRng([15, 4, 3]),
      },
    );
    expect(plain.costs).toEqual([]);
  });

  it("in an encounter, a paid rider is refused (roll it by hand to spend the use)", () => {
    const build = brakka();
    const characters: Record<string, { build: CharacterBuild; state: CharacterState }> = {
      brakka: { build, state: createState(build, catalog) },
    };
    let encounter: Encounter = createEncounter();
    const act = (action: EncounterAction) => {
      encounter = applyEncounterAction(encounter, action, {
        catalog,
        characters,
        rng: scriptedRng([]),
      }).encounter;
    };
    act({ type: "add_character", character: "brakka" });
    act({ type: "add_monster", monster: "ogre" });
    act({ type: "set_initiative", id: "brakka", value: 20 });
    act({ type: "set_initiative", id: "ogre", value: 10 });
    act({ type: "start" });
    expect(() =>
      act({
        type: "attack",
        id: "brakka",
        target: "ogre",
        attack: "Greatsword",
        riders: [{ rider: "test-focus-strike" }],
      }),
    ).toThrow("roll the attack by hand");
  });
});
