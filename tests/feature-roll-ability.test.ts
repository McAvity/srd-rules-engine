import { describe, expect, it } from "vitest";
import {
  applyAction,
  checkCosts,
  combatantFromCharacter,
  computePlaySheet,
  createCatalog,
  createState,
  fixedRng,
  rollByHand,
} from "../src/index";
import { FeatureActionSchema } from "../src/models/content";
import { srdPack } from "../src/srd";
import { fighterBuild } from "./helpers";

// Invented actions on an existing species; no private character or pack needed.
const catalog = createCatalog(
  [
    srdPack,
    {
      manifest: {
        id: "test-roll-ability",
        version: "1.0.0",
        source: "test",
        requires: ["srd-5.2.1"],
      },
      patches: [
        {
          target: "species/human",
          op: "set",
          path: "grants.actions",
          value: [
            {
              id: "with-con",
              name: "Test CON",
              economy: "reaction",
              roll: { dice: "1d12", ability: "con" },
            },
            { id: "legacy", name: "Test legacy", economy: "free", roll: { dice: "1d12" } },
          ],
        },
      ],
    },
  ],
  {},
);

describe("feature roll ability modifier", () => {
  it.each([
    [14, 2],
    [18, 4],
    [10, 0],
    [6, -2],
  ])("uses current CON %i (modifier %i) in the sheet and actual roll", (score, bonus) => {
    const base = fighterBuild();
    const build = {
      ...base,
      base_scores: { ...base.base_scores, con: score - (base.background_bonus.con ?? 0) },
    };
    const state = createState(build, catalog);
    const sheet = computePlaySheet(build, state, catalog);
    const action = sheet.actions.find((a) => a.name === "Test CON");
    expect(action?.roll_die).toBe(`1d12${bonus === 0 ? "" : bonus > 0 ? `+${bonus}` : bonus}`);
    const result = rollByHand(
      combatantFromCharacter(build, state, catalog),
      { type: "feature", feature: "Test CON" },
      {
        catalog,
        character: { build, state },
        rng: fixedRng(0.5),
      },
    );
    expect(result.rolls.die?.modifier).toBe(bonus);
    expect(result.rolls.die?.total).toBe((result.rolls.die?.rolls[0] ?? 0) + bonus);
  });

  it("leaves legacy roll data and expressions unchanged", () => {
    const build = fighterBuild();
    const state = createState(build, catalog);
    const sheet = computePlaySheet(build, state, catalog);
    expect(sheet.actions.find((a) => a.name === "Test legacy")?.roll_die).toBe("1d12");
    expect(
      FeatureActionSchema.parse({
        id: "legacy",
        name: "Legacy",
        economy: "free",
        roll: { dice: "1d12" },
      }).roll,
    ).toEqual({ dice: "1d12" });
  });

  it("rejects an unknown ability without accepting arbitrary names", () => {
    expect(
      FeatureActionSchema.safeParse({
        id: "bad",
        name: "Bad",
        economy: "free",
        roll: { dice: "1d12", ability: "constitution" },
      }).success,
    ).toBe(false);
  });
});

// Synthetic options exercise parent-resource lookup without private pack data.
function optionCatalog(local = false, missing = false) {
  return createCatalog(
    [
      srdPack,
      {
        manifest: {
          id: "test-option-uses",
          version: "1.0.0",
          source: "test",
          requires: ["srd-5.2.1"],
        },
        patches: [
          {
            target: "species/human",
            op: "append",
            path: "grants.resources",
            value: { id: "shared", name: "Shared", max: { value: 2 }, recharge: "long" },
          },
          {
            target: "backgrounds/soldier",
            op: "append",
            path: "grants.resources",
            value: { id: "absent", name: "Unrelated", max: { value: 3 }, recharge: "long" },
          },
          {
            target: "species/human",
            op: "append",
            path: "grants.choices",
            value: {
              id: "test-option",
              label: "Test option",
              kind: "option",
              count: 1,
              options: [
                {
                  id: "roller",
                  name: "Roller",
                  grants: {
                    ...(local
                      ? {
                          resources: [
                            { id: "shared", name: "Local", max: { value: 1 }, recharge: "long" },
                          ],
                        }
                      : {}),
                    actions: [
                      {
                        id: "option-roll",
                        name: "Option roll",
                        economy: "reaction",
                        uses: missing ? "absent" : "shared",
                        roll: { dice: "1d12", ability: "con" },
                      },
                    ],
                  },
                },
                { id: "other", name: "Other", grants: {} },
              ],
            },
          },
        ],
      },
    ],
    {},
  );
}
function optionBuild(option = "roller") {
  const base = fighterBuild();
  return { ...base, choices: { ...base.choices, "species:human#test-option": [option] } };
}
describe("option action resource ancestry", () => {
  it("rolls using the parent's shared pool once, and refuses payment when exhausted", () => {
    const cat = optionCatalog();
    const build = optionBuild();
    const state = createState(build, cat);
    const sheet = computePlaySheet(build, state, cat);
    const action = sheet.actions.find((a) => a.name === "Option roll");
    expect(action?.uses).toBe("species:human:shared");
    const result = rollByHand(
      combatantFromCharacter(build, state, cat),
      { type: "feature", feature: "Option roll" },
      { catalog: cat, character: { build, state }, rng: fixedRng(0.5) },
    );
    expect(result.costs).toHaveLength(1);
    let spent = state;
    for (const cost of result.costs) {
      if (cost.type === "play") spent = applyAction(build, spent, cat, cost.action).state;
    }
    expect(spent.uses_spent["species:human:shared"]).toBe(1);
    expect(Object.keys(spent.uses_spent)).not.toContain("species:human#test-option=roller:shared");
    const exhausted = applyAction(build, spent, cat, {
      type: "use",
      key: "species:human:shared",
    }).state;
    expect(
      checkCosts(result.costs, {
        catalog: cat,
        name: build.name,
        character: { build, state: exhausted },
      }).every((cost) => cost.payable),
    ).toBe(false);
  });
  it("does not show an action from an unselected option", () => {
    const cat = optionCatalog();
    const build = optionBuild("other");
    expect(
      computePlaySheet(build, createState(build, cat), cat).actions.some(
        (a) => a.name === "Option roll",
      ),
    ).toBe(false);
  });
  it("prefers a declared local resource over the parent's resource", () => {
    const cat = optionCatalog(true);
    const build = optionBuild();
    expect(
      computePlaySheet(build, createState(build, cat), cat).actions.find(
        (a) => a.name === "Option roll",
      )?.uses,
    ).toBe("species:human#test-option=roller:shared");
  });
  it("keeps a missing resource unpayable rather than using an unrelated pool", () => {
    const cat = optionCatalog(false, true);
    const build = optionBuild();
    expect(
      computePlaySheet(build, createState(build, cat), cat).actions.find(
        (a) => a.name === "Option roll",
      )?.uses,
    ).toBe("species:human#test-option=roller:absent");
  });
});
