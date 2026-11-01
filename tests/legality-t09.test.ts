import { describe, expect, it } from "vitest";
import {
  type AbilityMap,
  builder,
  type Catalog,
  type CharacterBuild,
  createBuild,
  createCatalog,
  evaluate,
  resolve,
  SKILLS,
} from "../src/index";
import { srdPack } from "../src/srd";
import { autocomplete } from "./helpers";

// kenli F-002 T09: builder legality the 2024 plans need (invented test content only):
// a skill grant when no skill is left, one-third casters' slots, a flat Hit Point bonus, a spell
// choice limited by casting time (Spell Mastery), an older background's "any" increases.
const pack = {
  manifest: { id: "test-legality", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
  species: [
    {
      id: "test-polymath",
      name: "Test Polymath",
      grants: { size: "medium", skills: [...SKILLS] },
    },
    {
      id: "test-scholar",
      name: "Test Scholar",
      grants: {
        size: "medium",
        skills: SKILLS.filter((s) => s !== "stealth" && s !== "acrobatics"),
      },
    },
  ],
  backgrounds: [
    {
      id: "test-old-background",
      name: "Test Old Background",
      ability_scores: ["str", "dex", "con", "int", "wis", "cha"],
      grants: {},
    },
  ],
  feats: [
    {
      id: "test-fortitude",
      name: "Test Fortitude",
      category: "origin",
      grants: { effects: [{ target: "hp_max", op: "add", value: 40 }] },
    },
    {
      id: "test-mastery",
      name: "Test Mastery",
      category: "origin",
      grants: {
        choices: [
          {
            id: "spell",
            label: "An Action spell",
            kind: "spell",
            spell_level: 1,
            spell_list: "wizard",
            casting_time: "Action",
          },
        ],
      },
    },
  ],
  subclasses: [
    {
      id: "test-trickster",
      name: "Test Trickster",
      class: "rogue",
      features: { "3": { spellcasting: { list: "wizard", ability: "int", progression: "third" } } },
    },
  ],
};
const cat: Catalog = createCatalog([srdPack, pack], {});

function start(
  classId: string,
  species: string,
  { background = "sage", bonus = { int: 2, wis: 1 } as AbilityMap } = {},
): CharacterBuild {
  let b = createBuild();
  const set = <A extends unknown[]>(
    f: (b: CharacterBuild, c: Catalog, ...a: A) => { build: CharacterBuild },
    ...a: A
  ) => {
    b = f(b, cat, ...a).build;
  };
  set(builder.setClass, classId);
  set(builder.setSpecies, species);
  set(builder.setBackground, background);
  set(builder.setAbilityMethod, "point_buy");
  set(builder.setBaseScores, { str: 8, dex: 15, con: 12, int: 13, wis: 10, cha: 13 });
  set(builder.setBackgroundBonus, bonus);
  set(builder.setName, "Tester");
  set(builder.setAlignment, "N");
  return b;
}
const up = (b: CharacterBuild, classId: string, n = 1) => {
  let x = b;
  for (let i = 0; i < n; i++) x = autocomplete(builder.levelUp(x, cat, classId, null).build, cat);
  return x;
};

describe("a skill grant when every skill is already known (Lore's Bonus Proficiencies)", () => {
  it("needs no pick: the level is complete and nothing is gained", () => {
    const b = autocomplete(start("rogue", "test-polymath"), cat);
    const res = resolve(b, cat);
    const skills = res.choices.find((c) => c.key === "class:rogue#skills");
    expect(skills && res.required(skills)).toBe(0);
    expect(skills && res.selected(skills)).toEqual([]);
    expect(evaluate(b, cat).report.is_complete).toBe(true);
  });
  it("still needs the skills that are left, and refuses one already known", () => {
    const b0 = start("rogue", "test-scholar");
    const res = resolve(b0, cat);
    const skills = res.choices.find((c) => c.key === "class:rogue#skills");
    expect(skills && res.required(skills)).toBe(2);
    expect(() => builder.setChoice(b0, cat, "class:rogue#skills", ["stealth", "arcana"])).toThrow();
    const ok = builder.setChoice(b0, cat, "class:rogue#skills", ["stealth", "acrobatics"]).build;
    const after = resolve(ok, cat).choices.find((c) => c.key === "class:rogue#skills");
    expect(after && resolve(ok, cat).selected(after)).toEqual(["stealth", "acrobatics"]);
  });
});

describe("one-third casters (progression: third)", () => {
  const rogue = (n: number) => {
    let b = up(autocomplete(start("rogue", "human"), cat), "rogue", 2);
    b = builder.setChoice(b, cat, "class:rogue:3#subclass", ["test-trickster"]).build;
    return up(autocomplete(b, cat), "rogue", n - 3);
  };
  it("its own table when it's the only spellcasting class: Rogue 3 → 2, Rogue 4 → 3 level 1 slots", () => {
    expect(evaluate(rogue(3), cat).sheet.spell_slots).toEqual([2]);
    expect(evaluate(rogue(4), cat).sheet.spell_slots).toEqual([3]);
    expect(evaluate(rogue(7), cat).sheet.spell_slots).toEqual([4, 2]);
  });
  it("rounded down with another caster: Rogue 4 + Wizard 1 = caster level 2", () => {
    const b = up(rogue(4), "wizard");
    expect(evaluate(b, cat).sheet.spell_slots).toEqual([3]);
    const solo = up(rogue(5), "rogue", 0);
    expect(evaluate(solo, cat).sheet.spell_slots).toEqual([3]);
  });
});

describe("hp_max: a flat Hit Point maximum bonus (Boon of Fortitude)", () => {
  it("adds once, not per level", () => {
    const plain = autocomplete(start("fighter", "human"), cat);
    const boon = builder.setChoice(plain, cat, "species:human#versatile", ["test-fortitude"]).build;
    const hp = (b: CharacterBuild) => evaluate(autocomplete(b, cat), cat).sheet.max_hp?.total ?? 0;
    expect(hp(boon) - hp(plain)).toBe(40);
    expect(hp(up(boon, "fighter", 2)) - hp(up(plain, "fighter", 2))).toBe(40);
  });
});

describe("casting_time on a spell choice (Spell Mastery: an Action)", () => {
  it("offers only spells with that casting time", () => {
    const b = builder.setChoice(start("fighter", "human"), cat, "species:human#versatile", [
      "test-mastery",
    ]).build;
    const res = resolve(b, cat);
    const c = res.choices.find(
      (x) => x.key.endsWith("#spell") && x.key.startsWith("feat:test-mastery"),
    );
    expect(c).toBeDefined();
    const ids = c ? res.options(c).map((o) => o.id) : [];
    expect(ids).toContain("grease");
    expect(ids).not.toContain("shield");
    expect(() => builder.setChoice(b, cat, c?.key ?? "", ["shield"])).toThrow(/isn't an option/);
    expect(builder.setChoice(b, cat, c?.key ?? "", ["grease"]).build.choices[c?.key ?? ""]).toEqual(
      ["grease"],
    );
  });
});

describe("a background from an older book: increases to any ability", () => {
  it("accepts +2/+1 on any two abilities; a 2024 background still limits them", () => {
    const old = start("bard", "human", {
      background: "test-old-background",
      bonus: { wis: 2, cha: 1 },
    });
    expect(
      evaluate(old, cat).report.issues.filter(
        (i) => i.step === "abilities" && i.severity === "error",
      ),
    ).toEqual([]);
    expect(() => start("bard", "human", { bonus: { cha: 2, str: 1 } })).toThrow(/only increase/);
  });
  it("the schema still needs at least three", () => {
    expect(() =>
      createCatalog(
        [
          srdPack,
          {
            manifest: { id: "x", requires: ["srd-5.2.1"] },
            backgrounds: [{ id: "y", name: "Y", ability_scores: ["str", "dex"], grants: {} }],
          },
        ],
        {},
      ),
    ).toThrow();
  });
});

describe("a spellbook records spells, it doesn't learn them", () => {
  it("copies a spell another feature gives (Magic Initiate) but not one already in the book", () => {
    // Sage: Magic Initiate (Wizard) from the background.
    let b = start("wizard", "human");
    const mi = "feat:magic-initiate@background:sage";
    const res = resolve(b, cat);
    const lvl1 = res.choices.find(
      (c) =>
        c.key.startsWith(`${mi}#`) &&
        c.definition.kind === "spell" &&
        c.definition.spell_level === 1,
    );
    expect(lvl1).toBeDefined();
    b = builder.setChoice(b, cat, lvl1?.key ?? "", ["shield"]).build;
    const book = ["shield", "grease", "sleep", "mage-armor", "magic-missile", "detect-magic"];
    b = builder.setChoice(b, cat, "class:wizard#spellbook", book).build;
    expect(b.choices["class:wizard#spellbook"]).toEqual(book);
    expect(b.choices[`${mi}#spell`]).toEqual(["shield"]);
    // Preparing it as a Wizard spell is still refused (Magic Initiate already has it prepared), and
    // a spell already in the book can't be copied again.
    expect(() =>
      builder.setChoice(b, cat, "class:wizard#prepared", [
        "shield",
        "grease",
        "sleep",
        "mage-armor",
      ]),
    ).toThrow(/already known from Magic Initiate/);
    const ok = builder.setChoice(b, cat, "class:wizard#prepared", [
      "grease",
      "sleep",
      "mage-armor",
      "magic-missile",
    ]).build;
    const two = up(autocomplete(ok, cat), "wizard");
    expect(evaluate(two, cat).report.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(() =>
      builder.setChoice(two, cat, "class:wizard:2#spellbook", ["grease", "web"]),
    ).toThrow(/already/);
  });
});
