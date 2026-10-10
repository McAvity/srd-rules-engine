import { describe, expect, it } from "vitest";
import {
  ALIGNMENT_NAMES,
  type AttackResult,
  applyAction,
  applyEncounterAction,
  type BuildError,
  builder,
  combatantOptions,
  createBuild,
  createEncounter,
  createState,
  type EncounterAction,
  EncounterError,
  encounterCombatant,
  formatMessage,
  MESSAGES_EN,
  type Message,
  makeAttack,
  type PlayAction,
  PlayError,
  type RuleError,
  renderMessage,
  resolve,
  STEP_TITLES,
  seededRng,
  validateBuild,
} from "../src/index";
import { message } from "../src/rules/messages";
import { catalog, fighterBuild } from "./helpers";

describe("message templates", () => {
  it("values, plurals, selects and lists", () => {
    expect(formatMessage("{n, plural, one {# turn} other {# turns}}", { n: 1 })).toBe("1 turn");
    expect(formatMessage("{n, plural, =0 {none} one {#} other {# turns}}", { n: 0 })).toBe("none");
    expect(formatMessage("{ok, select, true {yes} other {no}}", { ok: false })).toBe("no");
    expect(formatMessage("{a, list, plus} / {a}", { a: ["1", "2"] })).toBe("1 + 2 / 1, 2");
  });

  it("an English message renders from its template; another catalog translates it, nested ones too", () => {
    const save = message("save.total", { total: 12, dc: 15, mode: "advantage" });
    expect(save.text).toBe("12 vs DC 15, advantage");
    const m = message("concentration.lost", { name: "Brakka", spell: "Bless", save });
    expect(m.text).toBe("Brakka loses Concentration on Bless (12 vs DC 15, advantage).");
    const it = {
      "concentration.lost": "{name} perde la Concentrazione su {spell} ({save}).",
      "save.total": "{total} contro CD {dc}",
    };
    expect(renderMessage(m, it)).toBe("Brakka perde la Concentrazione su Bless (12 contro CD 15).");
    // A code the catalog lacks keeps its English text.
    expect(renderMessage(message("why.took_damage"), it)).toBe("it took damage");
  });

  it("a missing parameter is an engine bug", () => {
    expect(() => message("readied.taken", { name: "Brakka" })).toThrow("'trigger' missing");
  });
});

describe("other languages", () => {
  const turns = "{n, plural, one {# tura} few {# tury} many {# tur} other {# tury}}";

  it("plurals follow the locale's rules; English and no locale as before", () => {
    const pl = { "test.turns": turns };
    const m = (n: number): Message => ({ code: "test.turns", params: { n }, text: "" });
    expect([1, 2, 5, 22, 1.5].map((n) => renderMessage(m(n), pl, { locale: "pl" }))).toEqual([
      "1 tura",
      "2 tury",
      "5 tur",
      "22 tury",
      "1.5 tury",
    ]);
    // Without a locale, English rules: 1 is `one`, the rest `other`.
    expect(formatMessage(turns, { n: 2 })).toBe("2 tury");
    expect(formatMessage(turns, { n: 5 }, MESSAGES_EN, false, { locale: "pl" })).toBe("5 tur");
    // An exact match still comes first; a missing category falls back to `other`.
    expect(
      formatMessage("{n, plural, =2 {two!} other {#}}", { n: 2 }, MESSAGES_EN, false, {
        locale: "pl",
      }),
    ).toBe("two!");
    expect(
      formatMessage("{n, plural, one {#!} other {# x}}", { n: 5 }, MESSAGES_EN, false, {
        locale: "pl",
      }),
    ).toBe("5 x");
  });

  it("list joiners come from the catalog, English when it has none", () => {
    const names = ["Brakka", "Lute", "Pip"];
    const it = { "list.or": " o ", "list.and": " e " };
    expect(formatMessage("{a, list, or} / {a, list, and} / {a}", { a: names }, it)).toBe(
      "Brakka o Lute o Pip / Brakka e Lute e Pip / Brakka, Lute, Pip",
    );
    expect(formatMessage("{a, list, or}", { a: names })).toBe("Brakka or Lute or Pip");
    expect(formatMessage("{a, list, or}", { a: names }, {})).toBe("Brakka or Lute or Pip");
  });

  it("the builder's step titles, alignments and stat labels have codes", () => {
    expect(MESSAGES_EN["step.abilities"]).toBe(STEP_TITLES.abilities);
    expect(MESSAGES_EN["alignment.CG"]).toBe(ALIGNMENT_NAMES.CG);
    const [ac] = builder.previewOption(
      fighterBuild(),
      catalog,
      "class:fighter#fighting_style",
      "defense",
    );
    expect(ac?.label_message).toMatchObject({ code: "stat.armor_class", text: ac?.label });
  });
});

describe("encounter results", () => {
  // A catalog that marks every code: a coded message renders through it, `text` doesn't.
  const marked = Object.fromEntries(
    Object.entries(MESSAGES_EN).map(([code, t]) => [code, code === "text" ? t : `‹${t}›`]),
  );

  it("carry a message for every note, with a known code; English renders back to the note", () => {
    let e = createEncounter();
    const rng = seededRng(3);
    const actions: EncounterAction[] = [
      { type: "add_monster", monster: "mage" },
      { type: "add_monster", monster: "ogre" },
      { type: "add_monster", monster: "goblin-warrior", side: "party" },
      { type: "set_terrain", squares: [{ x: 4, y: 4 }], kind: "difficult" },
      { type: "roll_initiative" },
      { type: "set_initiative", id: "mage", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 15 },
      { type: "set_initiative", id: "ogre", value: 10 },
      { type: "start" },
      { type: "cast", id: "mage", spell: "fireball", targets: ["ogre"] },
      { type: "next_turn" },
      { type: "dodge", id: "goblin-warrior" },
      { type: "next_turn" },
      { type: "attack", id: "ogre", target: "goblin-warrior", attack: "Greatclub" },
      { type: "end" },
    ];
    const codes = new Set<string>();
    for (const action of actions) {
      const r = applyEncounterAction(e, action, { catalog, rng });
      e = r.encounter;
      expect(r.messages.map((m) => m.text)).toEqual(r.notes);
      for (const m of r.messages) {
        expect(m.code in MESSAGES_EN).toBe(true);
        expect(renderMessage(m)).toBe(m.text);
        if (m.code !== "text") expect(renderMessage(m, marked)).toMatch(/^‹.*›$/);
        codes.add(m.code);
      }
    }
    expect([...codes]).toEqual(
      expect.arrayContaining(["map.terrain", "initiative.rolled", "turn.starts", "spell.cast"]),
    );
    expect([...codes]).toEqual(expect.arrayContaining(["action.dodge", "fight.ends"]));
  });

  it("every English template parses", () => {
    for (const template of Object.values(MESSAGES_EN)) {
      expect(() => formatMessage(template, {})).not.toThrow();
    }
  });
});

describe("play results", () => {
  it("every note is a coded message: damage, death saves, rests, shopping", () => {
    const build = fighterBuild();
    let state = createState(build, catalog);
    const rng = seededRng(5);
    const actions: PlayAction[] = [
      { type: "set_temp_hp", amount: 3 },
      { type: "damage", instances: [{ amount: 16, type: "slashing" }] },
      { type: "death_save", roll: 12 },
      { type: "heal", amount: 5 },
      { type: "short_rest", hit_dice: [{ die: 10, roll: 6 }] },
      { type: "adjust_currency", changes: { gp: 20 } },
      { type: "buy", item: "rope", qty: 1 },
      { type: "long_rest" },
    ];
    const codes: string[] = [];
    for (const action of actions) {
      const r = applyAction(build, state, catalog, action, { rng });
      state = r.state;
      expect(r.messages.map((m) => m.text)).toEqual(r.notes);
      for (const m of r.messages) {
        expect(m.code).not.toBe("text");
        expect(renderMessage(m)).toBe(m.text);
        codes.push(m.code);
      }
    }
    expect(codes).toEqual([
      "damage.absorbed",
      "play.down",
      "death_save.rolled",
      "play.conscious",
      "rest.hit_die",
      "rest.short",
      "shop.bought",
      "rest.heroic_inspiration",
      "rest.long",
    ]);
  });

  it("roll reasons are messages too: the condition behind Advantage", () => {
    let e = createEncounter();
    const rng = seededRng(2);
    for (const action of [
      { type: "add_monster", monster: "ogre" },
      { type: "add_monster", monster: "goblin-warrior", side: "party" },
      { type: "set_initiative", id: "ogre", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 10 },
      { type: "start" },
      {
        type: "effects",
        id: "goblin-warrior",
        actions: [{ type: "add_condition", condition: "prone" }],
      },
    ] as EncounterAction[]) {
      e = applyEncounterAction(e, action, { catalog, rng }).encounter;
    }
    const r = applyEncounterAction(
      e,
      { type: "attack", id: "ogre", target: "goblin-warrior", attack: "Greatclub" },
      { catalog, rng },
    );
    const attack = r.result as AttackResult;
    expect(attack.reason_messages.map((m) => m.text)).toEqual(attack.reasons);
    expect(attack.reason_messages[0]?.code).toBe("roll.reason");
    const it = {
      "roll.reason": "{mode, select, advantage {Vantaggio} other {Svantaggio}}: {why}",
      "reason.is_at": "{name} è {condition}",
    };
    expect(renderMessage(attack.reason_messages[0] as Message, it)).toBe(
      "Vantaggio: Goblin Warrior è Prone",
    );
  });
});

describe("refusals", () => {
  const it_ = {
    "refusal.isnt_turn_reaction": "Non è il turno di {name}: solo una reazione può {what}",
    "refusal.no_level_spell_slots": "Nessuno slot di livello {level} rimasto",
  };

  it("an encounter refusal has a code, its parameters and the English text", () => {
    let e = createEncounter();
    for (const action of [
      { type: "add_monster", monster: "ogre" },
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "set_initiative", id: "ogre", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 10 },
      { type: "start" },
    ] as EncounterAction[]) {
      e = applyEncounterAction(e, action, { catalog }).encounter;
    }
    try {
      applyEncounterAction(e, { type: "dodge", id: "goblin-warrior" }, { catalog });
      expect.unreachable();
    } catch (error) {
      if (!(error instanceof EncounterError)) throw error;
      expect(error.codes).toEqual(["not_your_turn"]);
      const [detail] = error.details;
      expect(detail).toMatchObject({
        code: "refusal.isnt_turn_reaction",
        params: { name: "Goblin Warrior", what: "Dodge" },
      });
      expect(detail?.text).toBe(error.messages[0]);
      expect(renderMessage(detail as Message, it_)).toBe(
        "Non è il turno di Goblin Warrior: solo una reazione può Dodge",
      );
    }
  });

  it("a play refusal too", () => {
    const build = fighterBuild();
    try {
      applyAction(build, createState(build, catalog), catalog, { type: "spend_slot", level: 3 });
      expect.unreachable();
    } catch (error) {
      if (!(error instanceof PlayError)) throw error;
      expect(renderMessage(error.details[0] as Message, it_)).toBe(
        "Nessuno slot di livello 3 rimasto",
      );
    }
  });

  it("a rule's refusal is a RuleError (a RangeError) with its reason as a message", () => {
    let e = createEncounter();
    e = applyEncounterAction(e, { type: "add_monster", monster: "ogre" }, { catalog }).encounter;
    const ogre = encounterCombatant(e, "ogre", { catalog });
    try {
      makeAttack(ogre, "Bite", ogre);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect((error as RuleError).detail).toMatchObject({
        code: "rule.no_attack_named",
        params: { name: "Ogre", attack: "Bite" },
      });
    }
  });
});

describe("the builder and options", () => {
  /** Every message in a value (nested too), by walking it. */
  const messagesIn = (value: unknown, out: Message[] = []): Message[] => {
    if (Array.isArray(value)) for (const v of value) messagesIn(v, out);
    else if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      if (typeof v.code === "string" && typeof v.text === "string" && "params" in v) {
        out.push(v as unknown as Message);
      }
      for (const x of Object.values(v)) messagesIn(x, out);
    }
    return out;
  };

  it("validation issues, option reasons and repairs are coded messages", () => {
    const empty = createBuild();
    const report = validateBuild(empty, catalog);
    expect(report.issues.length).toBeGreaterThan(0);
    for (const i of report.issues) expect(i.detail.text).toBe(i.message);
    const build = fighterBuild();
    const res = resolve(build, catalog);
    const views = res.choices.flatMap((c) => res.options(c));
    const reasons = views.filter((v) => v.unavailable_message);
    expect(reasons.length).toBeGreaterThan(0);
    for (const v of reasons) expect(v.unavailable_message?.text).toBe(v.unavailable);
    const all = messagesIn([report, reasons, validateBuild(build, catalog)]);
    expect(all.filter((m) => m.code === "text")).toEqual([]);
    // A setter's refusal and its repair notes.
    try {
      builder.setChoice(build, catalog, "class:fighter#skills", ["athletics", "athletics"]);
      expect.unreachable();
    } catch (error) {
      expect((error as BuildError).details.map((d) => d.code)).toContain("builder.once_each");
    }
    const evil = builder.setAlignment(build, catalog, "CE");
    expect(evil.messages.map((m) => m.code)).toEqual(["builder.evil_alignment"]);
  });

  it("every option label, note and reason of a fighter's turn is a coded message", () => {
    let e = createEncounter();
    const build = fighterBuild();
    const characters = { brakka: { build, state: createState(build, catalog) } };
    for (const action of [
      { type: "add_character", character: "brakka" },
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "set_initiative", id: "brakka", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 10 },
      { type: "start" },
    ] as EncounterAction[]) {
      e = applyEncounterAction(e, action, { catalog, characters }).encounter;
    }
    const options = combatantOptions(e, "brakka", { catalog, characters });
    const all = messagesIn(options);
    expect(all.length).toBeGreaterThan(20);
    expect(all.filter((m) => m.code === "text")).toEqual([]);
    for (const m of all) expect(renderMessage(m)).toBe(m.text);
  });
});
