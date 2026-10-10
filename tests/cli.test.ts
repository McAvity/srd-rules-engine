import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BuilderApp } from "../src/cli/builder";
import { Console, scriptedInput } from "../src/cli/console";
import { FightApp } from "../src/cli/fight";
import { PlayApp } from "../src/cli/play";
import {
  type CharacterBuild,
  createCatalog,
  evaluate,
  parseBuild,
  parseState,
  seededRng,
} from "../src/index";
import { srdPack } from "../src/srd";
import { autocomplete, catalog, classBuild, fighterBuild, levelUpIn } from "./helpers";

async function runScript(answers: string[], build?: CharacterBuild) {
  const out: string[] = [];
  const saveDir = mkdtempSync(join(tmpdir(), "builder-"));
  const input = scriptedInput(answers, (prompt) => out.push(prompt));
  const con = new Console({ input, output: (text) => out.push(text), color: false });
  const app = new BuilderApp(con, catalog, { build, rng: seededRng(1), saveDir });
  const result = await app.run();
  return { build: result, output: out.join("\n"), saveDir };
}

it("the title shows the loaded build's level", async () => {
  const fresh = await runScript(["quit", "n"]);
  expect(fresh.output).toContain("Character Builder · Level 1 · SRD 5.2.1");
  const third = levelUpIn(autocomplete(classBuild("bard", { name: "Lute" })), "bard", 2);
  const loaded = await runScript(["quit", "n"], third);
  expect(loaded.output).toContain("Character Builder · Level 3 · SRD 5.2.1");
});

it("a full session builds and saves a valid fighter", async () => {
  // biome-ignore format: one line per step
  const answers = [
    "", "5",                  // class: Fighter
    "", "3", "3", "2",        // species: Elf, Wood Elf, Wisdom
    "", "4",                  // background: Soldier
    "", "2", "suggest", "",   // abilities: point buy, class suggestion
    "1", "1", "2",            // bonus: +2 Str, +1 Con
    "", "1", "2",             // equipment: Chain Mail package, 50 GP
    "", "2", "19 16 5",       // Defense; Greatsword, Flail, Javelin
    "", "1 7", "3", "1",      // skills, Keen Senses (Survival), dice set
    "", "5 4",                // Elvish, Dwarvish
    "", "Aerin", "2",         // name, Neutral Good
    "", "y",                  // review, save
    "quit",
  ];
  const { build, output, saveDir } = await runScript(answers);
  expect(output).toContain("Your character is complete and valid");
  expect(output).toContain("AC 16→17"); // Defense preview
  expect(output).toContain("already proficient from Soldier"); // Athletics greyed out
  const saved = JSON.parse(readFileSync(join(saveDir, "aerin.json"), "utf-8"));
  expect(parseBuild(saved)).toEqual(build);
  expect(build.choices["class:fighter#weapon_mastery"]).toEqual(["greatsword", "flail", "javelin"]);
});

it("invalid input is explained and asked again", async () => {
  // biome-ignore format: one line per step
  const answers = [
    "1", "5",                         // class: Fighter
    "4", "2",                         // abilities: point buy
    "str 16",                         // out of range
    "str 15", "dex 15", "con 15",     // 27 points spent
    "+wis",                           // can't afford
    "",                               // finish (no background yet, bonus skipped)
    "quit", "n",
  ];
  const { output } = await runScript(answers);
  expect(output).toContain("Point buy scores range from 8 to 15");
  expect(output).toContain("you have 0");
  expect(output).toContain("Choose a background to apply");
});

it("back returns to the menu, and an unchanged build quits without asking to save", async () => {
  const { output } = await runScript(["2", "back", "quit"], fighterBuild());
  expect(output).toContain("Farewell");
  expect(output).not.toContain("Save your character before quitting");
});

it("running out of input quits cleanly", async () => {
  const { output } = await runScript([]);
  expect(output).toContain("Farewell");
});

it("the sheet renders every section", async () => {
  const { output } = await runScript(["sheet", "quit"], fighterBuild());
  for (const heading of [
    "Combat",
    "Attacks",
    "Skills",
    "Feats",
    "Traits & Features",
    "Equipment",
  ]) {
    expect(output).toContain(heading);
  }
  expect(output).toContain("Armor Class  17   = 16 Chain Mail + 1 Defense");
});

it("levels up, rolls Hit Points, picks a subclass, and removes a level", async () => {
  // biome-ignore format: one line per step
  const answers = [
    "up", "5", "1", "",       // Fighter 2, fixed HP, keep the Fighting Style
    "up", "5", "2", "1", "",  // Fighter 3, roll HP, Champion, keep the Fighting Style
    "sheet",
    "up", "12",               // Wizard: not allowed (Int 8)
    "back",
    "down", "y",              // remove level 3
    "quit", "n",
  ];
  const { build, output } = await runScript(answers, fighterBuild());
  expect(output).toContain("Level 2: Fighter 2");
  expect(output).toMatch(/You rolled \d+ on the d10/);
  expect(output).toContain("Critical Hits on 19–20");
  expect(output).toContain("Wizard needs Intelligence 13+");
  expect(output).toContain("Removed level 3.");
  expect(build.levels).toEqual([{ class_id: "fighter", hp: null }]);
});

it("replaces a Fighting Style on level-up, then edits a past level's class with a preview", async () => {
  // biome-ignore format: one line per step
  const answers = [
    "up", "5", "1",           // Fighter 2, fixed HP
    "2", "1",                 // replace Defense… with Archery
    "edit", "2", "1", "9",    // edit level 2: its class → Rogue
    "y",                      // confirm after the preview
    "sheet",
    "quit", "n",
  ];
  const { build, output } = await runScript(answers, fighterBuild());
  expect(output).toContain("Replace one: Fighting Style");
  expect(output).toContain("Replace Defense with:");
  // Level 2 is no longer a Fighter level, so its replacement goes away (previewed first).
  expect(output).toContain(
    "Level 2 · Replace one: Fighting Style: Defense → Archery will be removed",
  );
  expect(output).toContain("Changed.");
  expect(output).toContain("Level 2 Human Fighter 1 / Rogue 1");
  expect(build.levels).toEqual([{ class_id: "rogue", hp: null }]);
});

it("play mode tracks HP, slots and items, and saves a state file", async () => {
  const out: string[] = [];
  const saveDir = mkdtempSync(join(tmpdir(), "play-"));
  const input = scriptedInput(
    ["dmg 5", "use 1", "cond prone", "add potion-of-healing", "items", "save", "quit"],
    (prompt) => out.push(prompt),
  );
  const con = new Console({ input, output: (text) => out.push(text), color: false });
  const app = new PlayApp(con, catalog, fighterBuild(), { rng: seededRng(1), saveDir });
  const state = await app.run();
  const output = out.join("\n");
  expect(output).toContain("HP 7/12");
  expect(output).toContain("1. Second Wind 1/2");
  expect(output).toContain("Prone");
  expect(output).toContain("Potion of Healing");
  const saved = parseState(JSON.parse(readFileSync(join(saveDir, "brakka.state.json"), "utf-8")));
  expect(saved).toEqual(state);
  expect(saved.hp.current).toBe(7);
});

it("play mode switches Rage on and off", async () => {
  const out: string[] = [];
  const input = scriptedInput(["on 1", "off 1", "quit"], (prompt) => out.push(prompt));
  const con = new Console({ input, output: (text) => out.push(text), color: false });
  const barbarian = autocomplete(classBuild("barbarian", { name: "Ulla" }));
  const app = new PlayApp(con, catalog, barbarian, { rng: seededRng(1) });
  const state = await app.run();
  const output = out.join("\n");
  expect(output).toContain("Toggle 1. Rage ON");
  expect(state.uses_spent["barbarian:rage"]).toBe(1);
  expect(state.active).toEqual([]);
});

it("save records the content packs the build was made with", () => {
  const layered = createCatalog(srdPack, {
    manifest: { id: "lantern", requires: ["srd-5.2.1"] },
    gear: [{ id: "glow-jar", name: "Glow Jar" }],
  });
  const saveDir = mkdtempSync(join(tmpdir(), "builder-"));
  const con = new Console({ input: scriptedInput([]), output: () => {}, color: false });
  const app = new BuilderApp(con, layered, { build: fighterBuild(), saveDir });
  const saved = parseBuild(JSON.parse(readFileSync(app.save(), "utf-8")));
  expect(saved.packs).toEqual(["lantern"]);
  expect(evaluate(saved, catalog).report.issues.map((i) => i.message)).toContain(
    "Needs content pack 'lantern', which isn't loaded",
  );
});

describe("fight mode", () => {
  const lute = levelUpIn(autocomplete(classBuild("bard", { name: "Lute" })), "bard", 2);
  async function fight(
    answers: string[],
    options: Partial<ConstructorParameters<typeof FightApp>[2]> = {},
  ) {
    const out: string[] = [];
    const saveDir = mkdtempSync(join(tmpdir(), "fight-"));
    const input = scriptedInput(answers, (prompt) => out.push(prompt));
    const con = new Console({ input, output: (text) => out.push(text), color: false });
    const app = new FightApp(con, catalog, {
      builds: [fighterBuild(), lute],
      monsters: ["goblin-warrior", "goblin-warrior"],
      rng: seededRng(7),
      saveDir,
      ...options,
    });
    const result = await app.run();
    return { output: out.join("\n"), saveDir, ...result };
  }

  it("sets up, takes turns, attacks, and saves the states and the encounter", async () => {
    // Seed 7: the goblins (Initiative 22) act first, then Lute, then Brakka.
    const run = await fight(["next", "next", "next", "attack 1 greatsword", "quit", "y"]);
    expect(run.output).toContain("▶ 1. Goblin Warrior [goblin-warrior] AC 15 · HP 10/10 · Init 22");
    expect(run.output).toContain(
      "Brakka hits Goblin Warrior with Greatsword (19 vs AC 15): 10 slashing.",
    );
    expect(run.encounter.combatants.find((c) => c.id === "goblin-warrior")?.defeated).toBe(true);
    const saved = JSON.parse(readFileSync(join(run.saveDir, "encounter.json"), "utf-8"));
    expect(saved.round).toBe(1);
    expect(
      parseState(JSON.parse(readFileSync(join(run.saveDir, "brakka.state.json"), "utf-8"))),
    ).toEqual(run.states.brakka);
  });

  it("asks decisions in ask mode, with the recommended answer as the default", async () => {
    const run = await fight(
      ["next", "next", "feature bardic brakka", "next", "check athletics 30", "", "quit", "n"],
      { ask: true },
    );
    // 19 vs 30: a d6 can't make it up, so the default (Enter) keeps the die.
    expect(run.output).toContain(
      "Brakka: Athletics check 19 vs 30. Add the Bardic Inspiration die (d6)? [y/N]",
    );
    expect(run.output).toContain("Brakka's Athletics check: 19 vs DC 30: failure.");
    expect(run.encounter.combatants.find((c) => c.id === "brakka")?.inspiration).not.toBeNull();
  });

  it("places combatants on a grid, shows it, and measures reach", async () => {
    const run = await fight([
      "place brakka 0 0",
      "place lute 0 1",
      "place goblin-warrior 3 0",
      "place goblin-warrior-2 4 4",
      "map",
      "next",
      "next",
      "next",
      "attack 1 greatsword",
      "move 2 0",
      "attack 1 greatsword",
      "quit",
      "n",
    ]);
    expect(run.output).toContain("  · 4 · · 1 · ");
    expect(run.output).toContain(
      "Goblin Warrior is 15 feet away: out of Greatsword's reach (5 ft)",
    );
    expect(run.output).toContain("Brakka hits Goblin Warrior with Greatsword");
  });

  it("resumes a saved encounter, and explains what it can't do", async () => {
    const first = await fight(["next", "quit", "y"]);
    const run = await fight(
      ["attack gob scimitar", "help nobody", "frobnicate", "options lute", "quit", "n"],
      {
        encounter: first.encounter,
        states: first.states,
        monsters: [],
      },
    );
    expect(run.output).toContain("▶ 2. Goblin Warrior 2 [goblin-warrior-2]");
    expect(run.output).toContain("'gob' could be goblin-warrior or goblin-warrior-2");
    expect(run.output).toContain("No combatant 'nobody'");
    expect(run.output).toContain("Unknown command 'frobnicate' (try 'help')");
    expect(run.output).toContain("Bardic Inspiration (bonus action) · 2/2 left");
  });
});
