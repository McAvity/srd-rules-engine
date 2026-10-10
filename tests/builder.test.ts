import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ABILITIES,
  type ActiveChoice,
  BuildError,
  createBuild,
  evaluate,
  parseBuild,
  reportErrors,
  STEPS,
  updateBuild,
  validateBuild,
} from "../src/index";
import * as svc from "../src/services/builder";
import { apply, catalog, fighterBuild } from "./helpers";

const all = (score: number) => Object.fromEntries(ABILITIES.map((a) => [a, score]));

describe("validation", () => {
  it("an empty build lists every step as pending", () => {
    const report = validateBuild(createBuild(), catalog);
    expect(report.is_complete).toBe(false);
    expect(reportErrors(report)).toEqual([]);
    const pending = new Set(
      report.issues.filter((i) => i.severity === "pending").map((i) => i.step),
    );
    expect(pending).toEqual(new Set(STEPS));
  });

  it("the complete fighter is valid", () => {
    const ev = evaluate(fighterBuild(), catalog);
    expect(ev.report.issues.filter((i) => i.severity !== "note")).toEqual([]);
    expect(ev.report.is_complete).toBe(true);
    expect(svc.nextIncompleteStep(ev)).toBeNull();
  });

  it("Magic Initiate spells are chosen from the feat's list", () => {
    let build = apply(createBuild(), svc.setBackground, "sage"); // Magic Initiate (Wizard)
    const cantrips = "feat:magic-initiate@background:sage#cantrips";
    const ev = evaluate(build, catalog);
    const options = ev.resolution.options(ev.resolution.choice(cantrips) as ActiveChoice);
    expect(options.map((o) => o.id)).toContain("fire-bolt");
    expect(options.map((o) => o.id)).not.toContain("sacred-flame"); // Cleric only
    expect(ev.report.issues.filter((i) => i.severity === "note")).toEqual([]);
    build = apply(build, svc.setChoice, cantrips, ["fire-bolt", "mage-hand"]);
    build = apply(build, svc.setChoice, "feat:magic-initiate@background:sage#spell", ["shield"]);
    build = apply(
      build,
      svc.setChoice,
      "feat:magic-initiate@background:sage#spellcasting_ability",
      ["int"],
    );
    const sheet = evaluate(build, catalog).sheet;
    expect(sheet.spellcasting).toEqual([
      expect.objectContaining({ source: "Magic Initiate", list: "wizard", ability: "int" }),
    ]);
    expect(sheet.spells.find((s) => s.id === "shield")?.always_prepared).toBe(true);
  });
});

describe("setters", () => {
  it("builds are immutable", () => {
    const build = createBuild();
    const { build: next } = svc.setClass(build, catalog, "fighter");
    expect(build.class_id).toBeNull();
    expect(next.class_id).toBe("fighter");
    expect(() => {
      (next as { class_id: string }).class_id = "wizard";
    }).toThrow(TypeError);
  });

  it("rejects an unknown class", () => {
    expect(() => svc.setClass(createBuild(), catalog, "artificer")).toThrow(/Unknown class/);
    expect(() => svc.setClass(createBuild(), catalog, "constructor")).toThrow(BuildError);
  });

  it("rejects a skill already granted by the background", () => {
    expect(() =>
      svc.setChoice(fighterBuild(), catalog, "class:fighter#skills", ["athletics", "history"]),
    ).toThrow(/already proficient from Soldier/);
  });

  it("skills must come from the class list", () => {
    expect(() =>
      svc.setChoice(fighterBuild(), catalog, "class:fighter#skills", ["arcana", "history"]),
    ).toThrow(/isn't an option/);
  });

  it("enforces the choice count", () => {
    expect(() =>
      svc.setChoice(fighterBuild(), catalog, "class:fighter#skills", [
        "history",
        "insight",
        "acrobatics",
      ]),
    ).toThrow(/at most 2/);
  });

  it("a non-repeatable origin feat can't be taken twice", () => {
    // Soldier grants Savage Attacker.
    expect(() =>
      svc.setChoice(fighterBuild(), catalog, "species:human#versatile", ["savage-attacker"]),
    ).toThrow(/already have this feat/);
  });

  it("a repeated Magic Initiate needs a different spell list", () => {
    let build = apply(createBuild(), svc.setSpecies, "human");
    build = apply(build, svc.setBackground, "acolyte");
    build = apply(build, svc.setChoice, "species:human#versatile", ["magic-initiate"]);
    const key = "feat:magic-initiate@species:human#versatile#spell_list";
    expect(() => svc.setChoice(build, catalog, key, ["cleric"])).toThrow(/already chosen/);
    build = apply(build, svc.setChoice, key, ["wizard"]);
    expect(build.choices[key]).toEqual(["wizard"]);
  });

  it("a fixed choice can't be changed", () => {
    const build = apply(createBuild(), svc.setBackground, "acolyte");
    const key = "feat:magic-initiate@background:acolyte#spell_list";
    expect(() => svc.setChoice(build, catalog, key, ["wizard"])).toThrow(/fixed by/);
  });

  it("rejects point buy overspending", () => {
    const build = apply(createBuild(), svc.setAbilityMethod, "point_buy");
    expect(() => svc.setBaseScores(build, catalog, all(15))).toThrow(/overspent/);
  });

  it("rejects all twenties with any method", () => {
    for (const method of ["standard_array", "point_buy"] as const) {
      const build = apply(createBuild(), svc.setAbilityMethod, method);
      expect(() => svc.setBaseScores(build, catalog, all(20))).toThrow(BuildError);
    }
  });

  it("changing the method clears scores", () => {
    const { build } = svc.setAbilityMethod(fighterBuild(), catalog, "point_buy");
    expect(build.base_scores).toEqual({});
    expect(build.background_bonus).toEqual({});
  });

  it("rejects a bonus to an ability the background can't raise", () => {
    expect(() => svc.setBackgroundBonus(fighterBuild(), catalog, { cha: 2, str: 1 })).toThrow(
      /can only increase/,
    );
  });

  it("an evil alignment is allowed with a note", () => {
    const { notes } = svc.setAlignment(createBuild(), catalog, "CE");
    expect(notes[0]).toContain("GM");
  });
});

describe("what picking an option would change (previewOption)", () => {
  const key = "class:fighter#fighting_style";

  it("Defense on a Fighter in Chain Mail: AC 16 → 17", () => {
    expect(svc.previewOption(fighterBuild(), catalog, key, "defense")).toEqual([
      {
        stat: "armor_class",
        label: "AC",
        label_message: { code: "stat.armor_class", params: {}, text: "AC" },
        before: 16,
        after: 17,
      },
    ]);
    // Compared with the choice unanswered, whatever is picked now.
    expect(svc.previewOption(fighterBuild(), catalog, key, "archery")).toEqual([]);
  });

  it("Skillful's Perception shows as Passive Perception 10 → 12", () => {
    const b = fighterBuild();
    expect(svc.previewOption(b, catalog, "species:human#skillful", "perception")).toEqual([
      {
        stat: "passive_perception",
        label: "Passive Perception",
        label_message: { code: "stat.passive_perception", params: {}, text: "Passive Perception" },
        before: 10,
        after: 12,
      },
    ]);
  });
});

describe("normalization", () => {
  it("changing background repairs downstream choices", () => {
    // Skilled picked Stealth; Criminal grants Stealth.
    const { build, notes } = svc.setBackground(fighterBuild(), catalog, "criminal");
    expect(build.background_bonus).toEqual({});
    expect(notes.some((n) => n.includes("bonuses were reset"))).toBe(true);
    expect(notes.some((n) => n.includes("removed Stealth"))).toBe(true);
    expect(build.choices["feat:skilled@species:human#versatile#proficiencies"]).not.toContain(
      "stealth",
    );
    const report = validateBuild(build, catalog);
    expect(reportErrors(report)).toEqual([]);
    expect(
      report.issues.some((i) => i.message.includes("Skilled proficiencies: choose 1 more")),
    ).toBe(true);
  });

  it("changing species drops its choices", () => {
    const { build } = svc.setSpecies(fighterBuild(), catalog, "dwarf");
    const keys = Object.keys(build.choices);
    expect(keys.some((k) => k.startsWith("species:human"))).toBe(false);
    expect(keys.some((k) => k.includes("skilled"))).toBe(false);
  });

  it("resolves a conflict between two choices only once", () => {
    // Force a conflict: Human Skillful and Fighter both pick Survival.
    const base = fighterBuild();
    const conflicted = updateBuild(base, {
      choices: { ...base.choices, "species:human#skillful": ["survival"] },
    });
    const { build, notes } = svc.normalize(conflicted, catalog);
    const picks = [build.choices["class:fighter#skills"], build.choices["species:human#skillful"]];
    expect(picks.filter((p) => p?.includes("survival"))).toHaveLength(1);
    expect(notes).toHaveLength(1);
  });
});

describe("saved builds", () => {
  it("round-trip through JSON", () => {
    const build = fighterBuild();
    expect(parseBuild(JSON.parse(JSON.stringify(build)))).toEqual(build);
  });

  it("builds saved by the Python builder still load", () => {
    const saved = JSON.parse(
      readFileSync(new URL("./fixtures/python-builder-save.json", import.meta.url), "utf-8"),
    );
    const ev = evaluate(parseBuild(saved), catalog);
    expect(reportErrors(ev.report)).toEqual([]);
    expect(ev.sheet.armor_class.total).toBeGreaterThan(10);
  });
});
