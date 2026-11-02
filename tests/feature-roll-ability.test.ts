import { describe, expect, it } from "vitest";
import {
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
