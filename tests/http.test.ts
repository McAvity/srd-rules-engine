import { describe, expect, it } from "vitest";
import { createHandler, type FetchHandler } from "../src/http/index";
import { fixedRng, scriptedRng } from "../src/index";
import { fighterBuild } from "./helpers";

const character = (overrides = {}) => ({
  name: "Test",
  character_class: "fighter",
  level: 5,
  ability_scores: {
    strength: 16,
    dexterity: 14,
    constitution: 15,
    intelligence: 10,
    wisdom: 12,
    charisma: 8,
  },
  max_hit_points: 44,
  current_hit_points: 44,
  armor_class: 16,
  proficiency_bonus: 3,
  ...overrides,
});

function client(handler: FetchHandler) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await handler(
      new Request(`http://test${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  return {
    get: (path: string) => call("GET", path),
    post: (path: string, body: unknown) => call("POST", path, body),
  };
}

const api = client(createHandler({ rng: fixedRng(20) }));

describe("HTTP API", () => {
  it("health", async () => {
    expect(await api.get("/health")).toMatchObject({ status: 200, body: { status: "ok" } });
  });

  it("validates characters", async () => {
    expect((await api.post("/v1/characters/", character())).status).toBe(200);
    const bad = await api.post("/v1/characters", character({ level: 25 }));
    expect(bad.status).toBe(422);
    expect(bad.body.message).toContain("level");
  });

  it("alive and passive perception", async () => {
    expect((await api.post("/v1/characters/Bob/alive", character())).body).toEqual({
      name: "Bob",
      alive: true,
    });
    const pp = await api.post("/v1/characters/Bob/passive-perception?proficient=true", character());
    expect(pp.body.passive_perception).toBe(14);
  });

  it("rolls dice", async () => {
    const res = await api.post("/v1/combat/roll", { expression: "2d6+3" });
    expect(res.body).toEqual({ dice_expression: "2d6+3", rolls: [20, 20], modifier: 3, total: 43 });
    expect((await api.post("/v1/combat/roll", { expression: "nope" })).status).toBe(400);
    expect((await api.post("/v1/combat/roll", { expression: "99999d6" })).status).toBe(400);
  });

  it("saving throws accept any ability capitalization", async () => {
    const res = await api.post("/v1/combat/saving-throw", {
      character: character(),
      ability: "Dexterity",
      dc: 15,
    });
    expect(res.body.success).toBe(true);
  });

  it("spell stats", async () => {
    const res = await api.post("/v1/spells/stats", {
      caster: character(),
      spellcasting_ability: "wisdom",
    });
    expect(res.body).toEqual({ save_dc: 12, attack_bonus: 4 });
  });

  it("serves content", async () => {
    expect((await api.get("/v1/content")).body.weapons).toBe(38);
    expect((await api.get("/v1/content/armor/chain-mail")).body.base_ac).toBe(16);
    expect((await api.get("/v1/content/armor/nope")).status).toBe(404);
    expect((await api.get("/v1/content/spaceships")).status).toBe(404);
    expect((await api.get("/v1/content/magic_items/weapon-1")).body.name).toBe("Weapon, +1");
    expect((await api.get("/v1/content/magic-items/weapon-1")).status).toBe(200);
    expect((await api.get("/v1/content/monsters/goblin-warrior")).body.cr).toBe("1/4");
    expect((await api.get("/v1/content/packs")).body).toEqual([
      expect.objectContaining({ id: "srd-5.2.1", version: "5.2.1" }),
    ]);
  });

  it("evaluates a build", async () => {
    const res = await api.post("/v1/builds/evaluate", fighterBuild());
    expect(res.body.report.is_complete).toBe(true);
    expect(res.body.sheet.armor_class.total).toBe(17);
    const skills = res.body.choices.find((c: { key: string }) => c.key === "class:fighter#skills");
    expect(skills.selected).toEqual(["acrobatics", "survival"]);
    expect(skills.options.find((o: { id: string }) => o.id === "athletics").unavailable).toBe(
      "already proficient from Soldier",
    );
  });

  it("levels up and sets choices over HTTP", async () => {
    const build = fighterBuild();
    const up = await api.post("/v1/builds/level-up", { build, class_id: "fighter", hp: 7 });
    expect(up.status).toBe(200);
    expect(up.body.build.levels).toEqual([{ class_id: "fighter", hp: 7 }]);
    const three = await api.post("/v1/builds/level-up", {
      build: up.body.build,
      class_id: "fighter",
    });
    const ev = await api.post("/v1/builds/evaluate", three.body.build);
    const subclass = ev.body.choices.find(
      (c: { key: string }) => c.key === "class:fighter:3#subclass",
    );
    expect(subclass).toMatchObject({ level: 3, required: 1, selected: [] });
    const chosen = await api.post("/v1/builds/set-choice", {
      build: three.body.build,
      key: "class:fighter:3#subclass",
      values: ["champion"],
    });
    const after = await api.post("/v1/builds/evaluate", chosen.body.build);
    expect(after.body.sheet.critical_hit_on).toBe(19);
    expect(after.body.sheet.level).toBe(3);
    const down = await api.post("/v1/builds/remove-level", { build: chosen.body.build });
    expect(down.body.build.levels).toHaveLength(1);
    const bad = await api.post("/v1/builds/level-up", { build, class_id: "wizard" });
    expect(bad).toMatchObject({
      status: 400,
      body: { detail: ["Wizard: Wizard needs Intelligence 13+"] },
    });
  });

  it("previews and changes the past over HTTP", async () => {
    let build = fighterBuild();
    for (let i = 0; i < 2; i++) {
      build = (await api.post("/v1/builds/level-up", { build, class_id: "fighter" })).body.build;
    }
    build = (
      await api.post("/v1/builds/set-choice", {
        build,
        key: "class:fighter:3#subclass",
        values: ["champion"],
      })
    ).body.build;
    const preview = await api.post("/v1/builds/preview", {
      build,
      key: "class:fighter:3#subclass",
      values: [],
    });
    expect(preview.status).toBe(200);
    expect(preview.body.pending).toMatchObject([
      { level: 3, message: "Fighter subclass: choose 1 more", detail: { code: "issue.choice" } },
    ]);
    const moved = await api.post("/v1/builds/set-level-class", {
      build,
      level: 2,
      class_id: "rogue",
    });
    expect(moved.status).toBe(200);
    expect(moved.body.build.levels.map((l: { class_id: string }) => l.class_id)).toEqual([
      "rogue",
      "fighter",
    ]);
    const refused = await api.post("/v1/builds/set-level-class", {
      build,
      level: 2,
      class_id: "wizard",
    });
    expect(refused.status).toBe(400);
    const ev = await api.post("/v1/builds/evaluate", build);
    const swap = ev.body.choices.find((c: { key: string }) => c.key.includes("#replace:"));
    expect(swap).toMatchObject({ required: 0, replaces: { family: "fighter:fighter-style" } });
    expect(swap.replace_old_options.map((o: { id: string }) => o.id)).toEqual(["defense"]);
  });

  it("rejects bad requests", async () => {
    expect((await api.get("/nope")).status).toBe(404);
    expect((await api.get("/v1/combat/roll")).status).toBe(405);
    const res = await createHandler()(
      new Request("http://test/v1/combat/roll", { method: "POST", body: "{not json" }),
    );
    expect(res.status).toBe(400);
  });

  it("supports a base path and CORS", async () => {
    const mounted = client(createHandler({ basePath: "/api", cors: true }));
    const res = await mounted.get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("HTTP play state", () => {
  it("creates a state, applies actions and returns the play sheet", async () => {
    const build = fighterBuild();
    const created = await api.post("/v1/state/new", { build });
    expect(created.status).toBe(200);
    const applied = await api.post("/v1/state/apply", {
      build,
      state: created.body,
      action: [
        { type: "damage", amount: 5 },
        { type: "add_condition", condition: "poisoned" },
      ],
    });
    expect(applied.status).toBe(200);
    const sheet = await api.post("/v1/state/sheet", { build, state: applied.body.state });
    expect(sheet.body.sheet.play.hp).toEqual({ current: 7, max: 12, temp: 0, bloodied: false });
    expect(sheet.body.sheet.play.conditions.map((c: { id: string }) => c.id)).toEqual(["poisoned"]);
    expect(sheet.body.issues).toEqual([]);
  });

  it("refuses impossible actions and malformed ones", async () => {
    const build = fighterBuild();
    const state = (await api.post("/v1/state/new", { build })).body;
    const refused = await api.post("/v1/state/apply", {
      build,
      state,
      action: { type: "spend_slot", level: 1 },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.detail).toEqual(["No level 1 spell slots left"]);
    expect(refused.body.details).toEqual([
      {
        code: "refusal.no_level_spell_slots",
        params: { level: 1 },
        text: "No level 1 spell slots left",
      },
    ]);
    const bad = await api.post("/v1/state/apply", { build, state, action: { type: "fly" } });
    expect(bad.status).toBe(422);
  });

  it("rolls by hand on the sheet: the dice and their costs; paying is /v1/state/apply", async () => {
    const api = client(
      createHandler({ rng: scriptedRng([15, 3, 4, ...Array<number>(10).fill(7)]) }),
    );
    const build = fighterBuild();
    const state = (await api.post("/v1/state/new", { build })).body;
    const sword = await api.post("/v1/state/roll", {
      build,
      state,
      what: { type: "attack", attack: "Greatsword" },
    });
    expect(sword.status).toBe(200);
    expect(sword.body.roll.rolls.attacks[0]).toMatchObject({ total: 20, damage: { total: 10 } });
    expect(sword.body.costs).toEqual([]);
    const wind = { type: "feature", feature: "Second Wind" };
    let current = state;
    let unpaid = null;
    for (let i = 0; i < 5 && !unpaid; i++) {
      const res = await api.post("/v1/state/roll", { build, state: current, what: wind });
      expect(res.status).toBe(200);
      const [cost] = res.body.costs;
      if (!cost.payable) unpaid = cost;
      else {
        const paid = await api.post("/v1/state/apply", {
          build,
          state: current,
          action: cost.action,
        });
        current = paid.body.state;
      }
    }
    expect(unpaid).toMatchObject({ payable: false, reason: { category: "resource" } });
  });

  it("resolves an attack between two characters and damages the target's state", async () => {
    const api = client(createHandler({ rng: scriptedRng([15, 4, 5]) }));
    const build = fighterBuild();
    const state = (await api.post("/v1/state/new", { build })).body;
    const side = { build, state };
    const res = await api.post("/v1/state/attack", {
      attacker: side,
      target: side,
      attack: "Greatsword",
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ total: 20, hit: true, target_ac: 17 });
    expect(res.body.result.instances).toEqual([{ amount: 12, type: "slashing" }]);
    expect(res.body.target_state.hp.current).toBe(0);
    expect(res.body.notes).toContain(
      "Down to 0 Hit Points: Unconscious, making Death Saving Throws.",
    );
    const sneakless = await api.post("/v1/state/attack", {
      attacker: side,
      target: side,
      attack: "Greatsword",
      riders: [{ rider: "sneak-attack" }],
    });
    expect(sneakless.status).toBe(400);
    expect(sneakless.body.detail[0]).toMatch(/no rider 'sneak-attack'/);
    const unknown = await api.post("/v1/state/attack", {
      attacker: side,
      target: side,
      attack: "Laser",
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.detail[0]).toMatch(/no attack 'Laser'/);
  });
});

describe("encounter options over HTTP", () => {
  const api = client(createHandler({ rng: fixedRng(10) }));
  const setup = async () => {
    const build = fighterBuild();
    const state = (await api.post("/v1/state/new", { build })).body;
    const characters = { brakka: { build, state } };
    const started = await api.post("/v1/encounters/apply", {
      encounter: {},
      characters,
      action: [
        { type: "add_character", character: "brakka" },
        { type: "add_monster", monster: "goblin-warrior", side: "enemies" },
        { type: "set_initiative", id: "brakka", value: 20 },
        { type: "set_initiative", id: "goblin-warrior", value: 10 },
        { type: "start" },
      ],
    });
    return { encounter: started.body.encounter, characters };
  };

  it("lists a combatant's options and checks an action without applying it", async () => {
    const { encounter, characters } = await setup();
    const options = await api.post("/v1/encounters/options", {
      encounter,
      characters,
      id: "brakka",
    });
    expect(options.status).toBe(200);
    expect(options.body).toMatchObject({ id: "brakka", turn: true });
    const sword = options.body.attacks.find((x: { label: string }) =>
      x.label.startsWith("Greatsword"),
    );
    expect(sword).toMatchObject({ available: true, cost: "attack" });
    const ok = await api.post("/v1/encounters/check", {
      encounter,
      characters,
      action: sword.action,
    });
    expect(ok.body).toEqual({ ok: true, reasons: [], codes: [], reason_messages: [] });
    const refused = await api.post("/v1/encounters/check", {
      encounter,
      characters,
      action: { type: "dodge", id: "goblin-warrior" },
    });
    expect(refused.body).toMatchObject({
      ok: false,
      reasons: ["It isn't Goblin Warrior's turn: only a reaction can Dodge"],
      codes: ["not_your_turn"],
      reason_messages: [{ code: "refusal.isnt_turn_reaction" }],
    });
    const unknown = await api.post("/v1/encounters/options", { encounter, characters, id: "x" });
    expect(unknown.status).toBe(400);
    const bad = await api.post("/v1/encounters/check", {
      encounter,
      characters,
      action: { type: "fly" },
    });
    expect(bad.status).toBe(422);
  });
});
