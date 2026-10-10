/**
 * Fight mode: run an encounter in the terminal with saved characters and SRD monsters. Every
 * command becomes an encounter action (`applyEncounterAction`); decisions after a roll (Bardic
 * Inspiration, Legendary Resistance, Uncanny Dodge) are asked as yes/no questions in `ask` mode.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Catalog, lookup } from "../content/catalog";
import type { CharacterBuild } from "../models/build";
import { ABILITIES, type Ability, type DamageType, SKILLS, type Skill } from "../models/content";
import type { Encounter, EncounterAction, EncounterCombatant } from "../models/encounter";
import type { EncounterHistory } from "../models/history";
import type { OptionEntry } from "../models/options";
import type { CharacterState } from "../models/state";
import { type DamagePart, formatDamage } from "../rules/damage";
import { mathRng, type Rng } from "../rules/rng";
import {
  applyEncounterAction,
  createEncounter,
  currentCombatant,
  EncounterError,
  encounterCombatant,
  mapWalls,
  zoneArea,
} from "../services/encounter";
import { createHistory, recordAction, undoAction } from "../services/history";
import { combatantOptions } from "../services/options";
import { computePlaySheet, createState } from "../services/play";
import { BackToMenu, type Console, QuitBuilder } from "./console";

export interface FightAppOptions {
  /** The characters, keyed by the slug of their name (their state file: `<key>.state.json`). */
  builds: CharacterBuild[];
  /** Saved states by key (default: a fresh state). */
  states?: Record<string, CharacterState>;
  /** Monster ids to add (repeat an id for several). */
  monsters?: string[];
  /** Resume a saved encounter instead of setting one up. */
  encounter?: Encounter;
  rng?: Rng;
  saveDir?: string;
  /** Ask the players (and the GM) to make decisions after a roll. */
  ask?: boolean;
}

const HELP = `Commands (the combatant whose turn it is acts; "as <who> …" acts for someone else).
Targets are ids, names or numbers from the status table.
  attack <target> [weapon] [adv|dis] [2h] [+rider] [light|cleave|granted|opp] [nomastery]
         [thrown] [half|3/4|total] (the target's cover)
  cast <spell> [targets…] [near …] [at <level>] [type <damage>] [spare <who…>]
  use <ability> [targets…]   (a monster's save effect)
  zone <id> save <who…> · zone <id> move <x> <y> [onto <who>] · zone <id> end   (lasting areas)
  areas: instead of targets, @x,y places a Sphere or Cube, >x,y aims a Cone or Line at a square;
         a wall spell: cast <spell> from x,y to x,y [left|right] (squares, or grid corners)
  feature <name> [target] [amount]           legend <action> [target…]  (as <monster> legend …)
  dash · disengage · dodge [bonus]   help <target> [skill]   grapple <t> · shove <t> prone|push
  escape · stand · move <feet> · move <x> <y> · check <skill|ability> [dc]
  hide [bonus] [obscured] · reveal · search [target] · utilize [what] · release (a readied action)
  place <who> <x> <y>   put a combatant on the grid (5-foot squares)    map   show the grid
  terrain difficult|blocked|clear <x> <y> [<x2> <y2>]   (a square or a rectangle)
  wall [remove] <x1> <y1> <x2> <y2>   a wall between grid corners (corner x,y: square x,y's top left)
  dmg <t> <n> [type] · heal <t> <n> · cond <t> <condition> · cond <t> -<condition>
  ask on|off [<t>]   decisions after a roll: ask, or let the engine decide (auto)
  options [<who>]    what a combatant can do now, and why not (dimmed)
  next · status · undo (the last action) · end · save · quit`;

export function slugOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "character"
  );
}

export class FightApp {
  private encounter: Encounter;
  private readonly builds: Record<string, CharacterBuild> = {};
  private readonly states: Record<string, CharacterState> = {};
  private readonly rng: Rng;
  private readonly saveDir: string;
  private readonly monsters: string[];
  private readonly ask: boolean;
  private dirty = false;
  /** Every action applied since the start, with its dice: `undo` replays all but the last. */
  private history: EncounterHistory;

  constructor(
    private readonly con: Console,
    private readonly catalog: Catalog,
    { builds, states = {}, monsters = [], encounter, rng, saveDir, ask = false }: FightAppOptions,
  ) {
    for (const build of builds) {
      let key = slugOf(build.name);
      for (let n = 2; key in this.builds; n++) key = `${slugOf(build.name)}-${n}`;
      this.builds[key] = build;
      this.states[key] = states[key] ?? createState(build, catalog);
    }
    this.rng = rng ?? mathRng;
    this.saveDir = saveDir ?? "characters";
    this.monsters = monsters;
    this.ask = ask;
    this.encounter = encounter ?? createEncounter({ decisions: ask ? "ask" : "auto" });
    this.history = createHistory(this.encounter, this.states);
  }

  get current(): { encounter: Encounter; states: Record<string, CharacterState> } {
    return { encounter: this.encounter, states: this.states };
  }

  async run(): Promise<{ encounter: Encounter; states: Record<string, CharacterState> }> {
    const con = this.con;
    con.title("Fight");
    con.info("Type 'help' for commands.");
    try {
      if (this.encounter.round === 0) await this.setup();
      let shown = "";
      for (;;) {
        const turn = `${this.encounter.round}:${this.encounter.turn}`;
        if (turn !== shown) {
          this.status();
          shown = turn;
        }
        const who = currentCombatant(this.encounter);
        let line: string;
        try {
          line = await con.ask(`${who?.name ?? "GM"}>`);
        } catch (error) {
          if (error instanceof BackToMenu) continue;
          throw error;
        }
        if (line) await this.command(line);
      }
    } catch (error) {
      if (!(error instanceof QuitBuilder)) throw error;
      if (this.dirty) {
        try {
          if (await con.confirm("Save the characters' states and the encounter?")) this.save();
        } catch (e) {
          if (!(e instanceof QuitBuilder || e instanceof BackToMenu)) throw e;
        }
      }
    }
    return this.current;
  }

  // --- setup and status -------------------------------------------------------------------

  private async setup(): Promise<void> {
    const actions: EncounterAction[] = [
      ...Object.keys(this.builds).map(
        (character) => ({ type: "add_character", character }) as const,
      ),
      ...this.monsters.map(
        (monster) => ({ type: "add_monster", monster, side: "enemies" }) as const,
      ),
    ];
    for (const action of actions) await this.apply(action);
    if (!this.encounter.combatants.length) {
      this.con.warn("Nobody to fight: give characters with --load and monsters with --monster.");
      throw new QuitBuilder();
    }
    await this.apply({ type: "roll_initiative", group: true });
    await this.apply({ type: "start" });
  }

  private status(): void {
    const e = this.encounter;
    this.con.title(`Round ${e.round}`);
    e.order.forEach((id, i) => {
      const c = e.combatants.find((x) => x.id === id) as EncounterCombatant;
      const mark = i === e.turn ? this.con.style("▶", "bold", "green") : " ";
      this.con.say(`${mark} ${i + 1}. ${this.line(c)}`);
    });
    for (const z of e.zones) {
      const by = e.combatants.find((c) => c.id === z.by)?.name ?? z.by;
      const where = z.point
        ? ` at ${z.point.x},${z.point.y}`
        : z.area.shape === "emanation"
          ? ` around ${by}`
          : "";
      this.con.say(`  ${z.id}: ${z.label} (${by})${where}`);
    }
  }

  private line(c: EncounterCombatant): string {
    const view = encounterCombatant(this.encounter, c.id, this.context());
    const hp = c.defeated ? this.con.style("defeated", "red") : `HP ${view.hp}/${view.max_hp}`;
    const temp = view.temp_hp ? ` +${view.temp_hp} temp` : "";
    const conditions = view.conditions.length ? ` · ${view.conditions.join(", ")}` : "";
    const extra = [
      c.concentration ? `concentrating on ${c.concentration}` : "",
      c.inspiration ? `inspired (d${c.inspiration.die})` : "",
      c.dodging ? "dodging" : "",
    ].filter(Boolean);
    const tail = extra.length ? ` · ${extra.join(", ")}` : "";
    const at = c.position ? ` · at ${c.position.x},${c.position.y}` : "";
    return `${c.name} [${c.id}] AC ${view.armor_class} · ${hp}${temp}${conditions}${tail} · Init ${c.initiative}${at}`;
  }

  /**
   * The grid around the positioned combatants, each shown by its number in the order: `#`
   * blocked, `~` Difficult Terrain, `*` a zone; walls as `|` and `—` between squares.
   */
  private map(): void {
    const e = this.encounter;
    const ctx = this.context();
    const placed = e.order
      .map((id, i) => [e.combatants.find((c) => c.id === id) as EncounterCombatant, i + 1] as const)
      .filter(([c]) => c.position && !c.defeated);
    const { difficult, blocked } = e.map;
    const walls = mapWalls(e);
    if (!placed.length && !walls.length && !difficult.length && !blocked.length) {
      this.con.info("Nobody is on the grid: 'place <who> <x> <y>'.");
      return;
    }
    const cells = new Map<string, string>();
    const at = (p: { x: number; y: number }) => `${p.x},${p.y}`;
    for (const z of e.zones) {
      for (const sq of zoneArea(e, ctx, z) ?? []) cells.set(sq, z.difficult ? "~" : "*");
    }
    for (const p of difficult) cells.set(at(p), "~");
    for (const p of blocked) cells.set(at(p), "#");
    const bounds: { x: number; y: number }[] = [...difficult, ...blocked];
    for (const w of walls) bounds.push(w.from, { x: w.to.x - 1, y: w.to.y - 1 });
    for (const [c, n] of placed) {
      const pos = c.position as { x: number; y: number };
      const size =
        { large: 2, huge: 3, gargantuan: 4 }[
          (encounterCombatant(e, c.id, ctx).size ?? "") as "large"
        ] ?? 1;
      const mark = n < 10 ? String(n) : String.fromCharCode(87 + n); // 10 → a
      for (let dx = 0; dx < size; dx++)
        for (let dy = 0; dy < size; dy++) {
          cells.set(`${pos.x + dx},${pos.y + dy}`, mark);
          bounds.push({ x: pos.x + dx, y: pos.y + dy });
        }
    }
    const xs = bounds.map((p) => p.x);
    const ys = bounds.map((p) => p.y);
    const [x0, x1, y0, y1] = [
      Math.min(...xs) - 1,
      Math.max(...xs) + 1,
      Math.min(...ys) - 1,
      Math.max(...ys) + 1,
    ];
    // A wall along grid line x (vertical) or y (horizontal) covering one square's edge.
    const vertical = (x: number, y: number) =>
      walls.some(
        (w) =>
          w.from.x === x &&
          w.to.x === x &&
          Math.min(w.from.y, w.to.y) <= y &&
          y + 1 <= Math.max(w.from.y, w.to.y),
      );
    const horizontal = (x: number, y: number) =>
      walls.some(
        (w) =>
          w.from.y === y &&
          w.to.y === y &&
          Math.min(w.from.x, w.to.x) <= x &&
          x + 1 <= Math.max(w.from.x, w.to.x),
      );
    this.con.info(`x ${x0}…${x1}, y ${y0}…${y1}; each square is 5 feet`);
    for (let y = y0; y <= y1; y++) {
      let edge = "  ";
      let any = false;
      for (let x = x0; x <= x1; x++) {
        const wall = horizontal(x, y);
        any ||= wall;
        edge += wall ? "— " : "  ";
      }
      if (any) this.con.say(edge.trimEnd());
      let row = ` ${vertical(x0, y) ? "|" : " "}`;
      for (let x = x0; x <= x1; x++) {
        row += `${cells.get(`${x},${y}`) ?? "·"}${vertical(x + 1, y) ? "|" : " "}`;
      }
      this.con.say(row);
    }
  }

  /**
   * What `c` can do now (`combatantOptions`): what it has left, then each option with its cost;
   * the ones the engine would refuse are dimmed, with the reason.
   */
  private options(c: EncounterCombatant): void {
    const ctx = this.context();
    const o = combatantOptions(this.encounter, c.id, ctx);
    const view = encounterCombatant(this.encounter, c.id, ctx);
    const con = this.con;
    const left = [
      o.economy.action ? "action" : "",
      o.economy.bonus_action ? "bonus action" : "",
      o.economy.reaction ? "reaction" : "",
      `${o.economy.movement} ft`,
      o.economy.attacks_left ? `${o.economy.attacks_left} attacks left` : "",
      o.economy.legendary ? `legendary ${o.economy.legendary.left}/${o.economy.legendary.max}` : "",
    ].filter(Boolean);
    con.say(`  ${o.name}${o.turn ? " (its turn)" : ""}: ${left.join(" · ")}`);
    const list = (
      title: string,
      entries: readonly OptionEntry[],
      extra?: (x: OptionEntry) => string,
    ) => {
      if (!entries.length) return;
      con.say(con.style(`  ${title}`, "bold"));
      for (const x of entries) {
        const uses = x.uses ? ` · ${x.uses.left}/${x.uses.max} left` : "";
        const slots = x.slot_levels.length ? ` · slots ${x.slot_levels.join(", ")}` : "";
        const pact = x.pact_slot !== null ? ` · pact slot ${x.pact_slot}` : "";
        const note = x.note ? ` · ${x.note}` : "";
        const pct = (n: number) => `${Math.round(n * 100)}%`;
        const odds = x.odds
          ? ` · ${[
              x.odds.hit !== null ? `${pct(x.odds.hit)} to hit` : "",
              x.odds.fail_save !== null ? `${pct(x.odds.fail_save)} to fail the save` : "",
              x.odds.average_damage ? `~${x.odds.average_damage.toFixed(1)} damage` : "",
            ]
              .filter(Boolean)
              .join(", ")}`
          : "";
        const line = `${x.label}${extra?.(x) ?? ""} (${x.cost.replace("_", " ")})${uses}${slots}${pact}${odds}${note}`;
        con.say(x.available ? `    ${line}` : con.style(`    ${line} — ${x.reason}`, "dim"));
      }
    };
    list("Attacks", o.attacks, (x) => {
      const a = x.action.type === "attack" ? x.action : null;
      const line = view.attacks.find((l) => l.name === a?.attack);
      if (!line || a?.cleave || a?.light_extra || a?.opportunity) return "";
      const riders = line.riders.length ? ` · +${line.riders.map((r) => r.id).join(" +")}` : "";
      return `${line.mastery ? ` · ${line.mastery}` : ""}${riders}`;
    });
    if (c.character) {
      const sheet = computePlaySheet(
        this.builds[c.character] as CharacterBuild,
        this.states[c.character] as CharacterState,
        this.catalog,
      );
      const slots = sheet.play.spell_slots
        .filter((x) => x.total > 0)
        .map((x) => `level ${x.level}: ${x.total - x.spent}/${x.total}`);
      if (slots.length) con.say(`  ${con.style("Spell slots", "bold")} ${slots.join(" · ")}`);
    }
    list("Spells", o.spells);
    list("Features", o.features);
    list("Abilities (use)", o.save_actions);
    list("Legendary actions (as <id> legend …)", o.legendary);
    list("Zones", o.zones);
    list("Standard actions", o.standard);
  }

  // --- commands ---------------------------------------------------------------------------

  private async command(line: string): Promise<void> {
    let words = line.split(/\s+/).filter(Boolean);
    let actor = currentCombatant(this.encounter);
    if (words[0]?.toLowerCase() === "as") {
      actor = this.find(words[1] ?? "");
      if (!actor) return;
      words = words.slice(2);
    }
    const [word = "", ...args] = words;
    const cmd = word.toLowerCase();
    const id = actor?.id ?? "";
    switch (cmd) {
      case "help":
      case "?":
        if (cmd === "help" && args.length) return this.helpAction(id, args);
        this.con.say(HELP);
        return;
      case "status":
      case "s":
        return this.status();
      case "options":
      case "o": {
        const who = args[0] ? this.find(args[0]) : actor;
        if (who) this.options(who);
        return;
      }
      case "next":
      case "n":
        return this.apply({ type: "next_turn" });
      case "undo":
        return this.undo();
      case "end":
        return this.apply({ type: "end" });
      case "save":
        this.save();
        return;
      case "quit":
        throw new QuitBuilder();
      case "attack":
      case "a":
        return this.attack(id, args);
      case "cast":
      case "c":
        return this.cast(id, args);
      case "use":
        return this.saveAction(id, args);
      case "legend":
        return this.legendary(id, args);
      case "feature":
      case "f":
        return this.feature(id, args);
      case "dash":
      case "disengage":
      case "dodge":
        return this.apply({ type: cmd, id, bonus_action: args.includes("bonus") || undefined });
      case "grapple":
      case "shove": {
        const t = this.find(args[0] ?? "");
        if (!t) return;
        const shove = args.find((a) => a === "prone" || a === "push") as
          | "prone"
          | "push"
          | undefined;
        return this.apply({ type: "unarmed", id, target: t.id, option: cmd, shove });
      }
      case "escape":
        return this.apply({ type: "escape", id });
      case "hide":
        return this.apply({
          type: "hide",
          id,
          bonus_action: args.includes("bonus") || undefined,
          obscured: args.includes("obscured") || undefined,
        });
      case "reveal":
        return this.apply({ type: "reveal", id });
      case "search": {
        const t = args[0] ? this.find(args[0]) : null;
        if (args[0] && !t) return;
        return this.apply({ type: "search", id, target: t?.id });
      }
      case "utilize":
        return this.apply({ type: "utilize", id, what: args.join(" ") || undefined });
      case "release":
        return this.apply({ type: "release", id });
      case "zone": {
        const [zone = "", verb, ...rest] = args;
        if (verb === "end") return this.apply({ type: "end_zone", zone });
        if (verb === "move") {
          const [x, y] = rest.map(Number);
          if (!Number.isInteger(x) || !Number.isInteger(y)) {
            return this.con.error("Usage: zone <id> move <x> <y>");
          }
          const onto = rest[2] === "onto" ? this.find(rest[3] ?? "") : undefined;
          if (rest[2] === "onto" && !onto) return;
          return this.apply({
            type: "move_zone",
            zone,
            point: { x: x as number, y: y as number },
            onto: onto?.id,
          });
        }
        if (verb === "save") {
          const targets = rest.map((w) => this.find(w));
          if (!targets.length || targets.some((t) => !t)) return;
          const ids = targets.map((t) => (t as EncounterCombatant).id);
          return this.apply({ type: "zone_save", zone, targets: ids });
        }
        return this.con.error("Usage: zone <id> save <who…> | move <x> <y> | end");
      }
      case "stand":
        return this.apply({ type: "stand", id });
      case "move": {
        const [a, b] = args.map(Number);
        if (args.length >= 2) return this.apply({ type: "move", id, to: { x: a ?? 0, y: b ?? 0 } });
        return this.apply({ type: "move", id, feet: a ?? 0 });
      }
      case "place": {
        const t = this.find(args[0] ?? "");
        const [x, y] = args.slice(1).map(Number);
        if (!t || !Number.isInteger(x) || !Number.isInteger(y)) {
          return this.con.error("Usage: place <who> <x> <y>");
        }
        return this.apply({ type: "place", id: t.id, x: x as number, y: y as number });
      }
      case "map":
        return this.map();
      case "terrain": {
        const [kind, ...rest] = args;
        const [x, y, x2 = x, y2 = y] = rest.map(Number);
        if (
          !["difficult", "blocked", "clear"].includes(kind ?? "") ||
          ![x, y, x2, y2].every(Number.isInteger)
        ) {
          return this.con.error("Usage: terrain difficult|blocked|clear <x> <y> [<x2> <y2>]");
        }
        const squares: { x: number; y: number }[] = [];
        const [ax, bx] = [Math.min(x as number, x2 as number), Math.max(x as number, x2 as number)];
        const [ay, by] = [Math.min(y as number, y2 as number), Math.max(y as number, y2 as number)];
        for (let i = ax; i <= bx; i++) for (let j = ay; j <= by; j++) squares.push({ x: i, y: j });
        return this.apply({
          type: "set_terrain",
          squares,
          kind: kind as "difficult" | "blocked" | "clear",
        });
      }
      case "wall": {
        const remove = args[0] === "remove";
        const [x1, y1, x2, y2] = args.slice(remove ? 1 : 0).map(Number);
        if (![x1, y1, x2, y2].every(Number.isInteger)) {
          return this.con.error("Usage: wall [remove] <x1> <y1> <x2> <y2> (grid corners)");
        }
        return this.apply({
          type: remove ? "remove_wall" : "add_wall",
          from: { x: x1 as number, y: y1 as number },
          to: { x: x2 as number, y: y2 as number },
        });
      }
      case "check":
        return this.check(id, args);
      case "dmg":
      case "heal": {
        const t = this.find(args[0] ?? "");
        const amount = Number(args[1]);
        if (!t || !Number.isInteger(amount))
          return this.con.error(`Usage: ${cmd} <target> <amount>`);
        const effect =
          cmd === "dmg"
            ? ({ type: "damage", amount, damage_type: args[2] } as const)
            : ({ type: "heal", amount } as const);
        return this.apply({ type: "effects", id: t.id, actions: [effect] });
      }
      case "cond": {
        const t = this.find(args[0] ?? "");
        const name = args[1] ?? "";
        if (!t || !name)
          return this.con.error("Usage: cond <target> <condition> (or -<condition>)");
        const remove = name.startsWith("-");
        const condition = name.replace(/^-/, "").toLowerCase();
        const effect = remove
          ? ({ type: "remove_condition", condition } as const)
          : ({ type: "add_condition", condition } as const);
        return this.apply({ type: "effects", id: t.id, actions: [effect] });
      }
      case "ask": {
        const mode = args[0] === "on" ? "ask" : args[0] === "off" ? "auto" : null;
        if (!mode) return this.con.error("Usage: ask on|off [<target>]");
        const t = args[1] ? this.find(args[1]) : null;
        if (args[1] && !t) return;
        return this.apply({ type: "set_decisions", id: t?.id, mode });
      }
      default:
        this.con.error(`Unknown command '${word}' (try 'help')`);
    }
  }

  private async attack(id: string, args: string[]): Promise<void> {
    const t = this.find(args[0] ?? "");
    if (!t) return;
    const attacks = encounterCombatant(this.encounter, id, this.context()).attacks;
    const flags = new Set(args.slice(1).map((a) => a.toLowerCase()));
    const named = args.slice(1).filter((a) => !this.isFlag(a));
    let attack = named.length
      ? pick(
          attacks.map((a) => a.name),
          named.join(" "),
        )
      : null;
    if (!attack && attacks.length === 1) attack = attacks[0]?.name ?? null;
    if (!attack) {
      attacks.forEach((a, i) => {
        this.con.say(
          `  ${i + 1}. ${a.name} ${signedBonus(a.attack_bonus)} · ${damageText(a.damage_parts)}`,
        );
      });
      attack = pick(
        attacks.map((a) => a.name),
        await this.con.ask("Which attack?"),
      );
      if (!attack) return this.con.error("No such attack");
    }
    const riders = args.filter((a) => a.startsWith("+")).map((a) => ({ rider: a.slice(1) }));
    await this.apply({
      type: "attack",
      id,
      target: t.id,
      attack,
      mode: flags.has("adv") ? "advantage" : flags.has("dis") ? "disadvantage" : undefined,
      two_handed: flags.has("2h") || undefined,
      riders: riders.length ? riders : undefined,
      light_extra: flags.has("light") || undefined,
      cleave: flags.has("cleave") || undefined,
      granted: flags.has("granted") || undefined,
      opportunity: flags.has("opp") || undefined,
      mastery: flags.has("nomastery") ? false : undefined,
      thrown: flags.has("thrown") || undefined,
      cover: flags.has("half")
        ? "half"
        : flags.has("3/4")
          ? "three_quarters"
          : flags.has("total")
            ? "total"
            : undefined,
    });
  }

  private isFlag(word: string): boolean {
    return (
      word.startsWith("+") ||
      [
        "adv",
        "dis",
        "2h",
        "light",
        "cleave",
        "granted",
        "opp",
        "nomastery",
        "thrown",
        "half",
        "3/4",
        "total",
      ].includes(word.toLowerCase())
    );
  }

  private async cast(id: string, all: string[]): Promise<void> {
    const { area, rest: placed } = areaOf(all);
    // A wall: `from x,y to x,y [left|right]`.
    const fromAt = placed.indexOf("from");
    const square = (w?: string) => {
      const m = /^(-?\d+),(-?\d+)$/.exec(w ?? "");
      return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
    };
    let wall:
      | { from: { x: number; y: number }; to: { x: number; y: number }; side?: "left" | "right" }
      | undefined;
    let args = placed;
    if (fromAt >= 0) {
      const from = square(placed[fromAt + 1]);
      const to = placed[fromAt + 2] === "to" ? square(placed[fromAt + 3]) : null;
      if (!from || !to)
        return this.con.error("Usage: cast <wall spell> from x,y to x,y [left|right]");
      const side = placed[fromAt + 4];
      wall = { from, to, ...(side === "left" || side === "right" ? { side } : {}) };
      args = [...placed.slice(0, fromAt), ...placed.slice(fromAt + (wall.side ? 5 : 4))];
    }
    const at = args.indexOf("at");
    const slot_level = at >= 0 ? Number(args[at + 1]) : undefined;
    // `type <damage>`: the damage type picked; `spare …`: creatures a zone doesn't affect.
    const typed = args.indexOf("type");
    const damage_type = typed >= 0 ? (args[typed + 1]?.toLowerCase() as DamageType) : undefined;
    const spareAt = args.indexOf("spare");
    const ends = (from: number) =>
      [at, typed, spareAt].filter((i) => i > from).reduce((a, b) => Math.min(a, b), args.length);
    const spare =
      spareAt >= 0 ? args.slice(spareAt + 1, ends(spareAt)).map((w) => this.find(w)) : [];
    if (spare.some((t) => !t)) return;
    const first = [at, typed, spareAt].filter((i) => i >= 0);
    const before = first.length ? args.slice(0, Math.min(...first)) : args;
    // `near …`: the creatures next to the target of a follow-up save (Ice Knife) without positions.
    const near = before.indexOf("near");
    const words = near >= 0 ? before.slice(0, near) : before;
    const nearby = near >= 0 ? before.slice(near + 1).map((w) => this.find(w)) : undefined;
    if (nearby?.some((t) => !t)) return;
    // The spell is the longest prefix of words naming a catalog spell; the rest are targets.
    for (let n = words.length; n >= 1; n--) {
      const spell = this.spellId(words.slice(0, n).join(" "));
      if (!spell) continue;
      const targets = words.slice(n).map((w) => this.find(w));
      if (targets.some((t) => !t)) return;
      return this.apply({
        type: "cast",
        id,
        spell,
        targets: area || wall ? undefined : targets.map((t) => (t as EncounterCombatant).id),
        area,
        wall,
        slot_level,
        nearby: nearby?.map((t) => (t as EncounterCombatant).id),
        damage_type,
        unaffected: spare.length ? spare.map((t) => (t as EncounterCombatant).id) : undefined,
      });
    }
    this.con.error(
      "Usage: cast <spell> [targets…] [near <creatures…>] [at <level>] [type <damage>] [spare <who…>]",
    );
  }

  /** A catalog spell by id, name, or a prefix of its name that only one spell has. */
  private spellId(text: string): string | null {
    const slug = slugOf(text);
    if (lookup(this.catalog.spells, slug)) return slug;
    const spells = Object.values(this.catalog.spells);
    const name = pick(
      spells.map((s) => s.name),
      text,
    );
    return spells.find((s) => s.name === name)?.id ?? null;
  }

  private async saveAction(id: string, all: string[]): Promise<void> {
    const { area, rest: args } = areaOf(all);
    const names = encounterCombatant(this.encounter, id, this.context()).save_actions.map(
      (a) => a.name,
    );
    // Names of several words ("fire breath"): the longest prefix of words that names one.
    for (let n = args.length; n >= 1; n--) {
      const name = pick(names, args.slice(0, n).join(" "));
      if (!name) continue;
      const targets = args.slice(n).map((w) => this.find(w));
      if (targets.some((t) => !t)) return;
      return this.apply({
        type: "save_action",
        id,
        ability: name,
        targets: area ? undefined : targets.map((t) => (t as EncounterCombatant).id),
        area,
      });
    }
    this.con.error(`Usage: use <ability> [targets…] (${names.join(", ") || "none"})`);
  }

  private async legendary(id: string, all: string[]): Promise<void> {
    const { area, rest: args } = areaOf(all);
    const lines = encounterCombatant(this.encounter, id, this.context()).legendary_actions;
    const name = args.length
      ? pick(
          lines.map((a) => a.name),
          args[0] as string,
        )
      : null;
    if (!name) {
      const known = lines.map((a) => a.name).join(", ") || "none";
      return this.con.error(`Usage: as <monster> legend <action> [targets…] (${known})`);
    }
    const targets = args.slice(1).map((w) => this.find(w));
    if (targets.some((t) => !t)) return;
    const ids = targets.map((t) => (t as EncounterCombatant).id);
    await this.apply({ type: "legendary", id, action: name, target: ids[0], targets: ids, area });
  }

  private async feature(id: string, args: string[]): Promise<void> {
    const actor = this.encounter.combatants.find((c) => c.id === id);
    if (!actor?.character) return this.con.error("Only characters have class features");
    const sheet = computePlaySheet(
      this.builds[actor.character] as CharacterBuild,
      this.states[actor.character] as CharacterState,
      this.catalog,
    );
    const names = sheet.actions.map((a) => a.name);
    const amount = args.find((a) => /^\d+$/.test(a));
    const words = args.filter((a) => a !== amount);
    // The feature is the longest prefix of words naming one; then an optional target.
    for (let n = words.length; n >= 1; n--) {
      const name = pick(names, words.slice(0, n).join(" "));
      if (!name) continue;
      const target = words[n] ? this.find(words[n] as string) : null;
      if (words[n] && !target) return;
      return this.apply({
        type: "feature",
        id,
        feature: name,
        target: target?.id,
        amount: amount ? Number(amount) : undefined,
      });
    }
    this.con.error(`Usage: feature <name> [target] [amount] (${names.join(", ") || "none"})`);
  }

  private async helpAction(id: string, args: string[]): Promise<void> {
    const t = this.find(args[0] ?? "");
    if (!t) return;
    const skill = args[1] ? (slugOf(args.slice(1).join(" ")) as Skill) : undefined;
    if (skill && !(SKILLS as readonly string[]).includes(skill)) {
      return this.con.error(`Unknown skill '${args.slice(1).join(" ")}'`);
    }
    await this.apply({ type: "help", id, target: t.id, skill });
  }

  private async check(id: string, args: string[]): Promise<void> {
    const dc = args.find((a) => /^\d+$/.test(a));
    const what = slugOf(args.filter((a) => a !== dc).join(" "));
    const ability = (ABILITIES as readonly string[]).includes(what.slice(0, 3))
      ? (what.slice(0, 3) as Ability)
      : undefined;
    const skill = (SKILLS as readonly string[]).includes(what) ? (what as Skill) : undefined;
    if (!skill && !ability) return this.con.error("Usage: check <skill|ability> [dc]");
    await this.apply({
      type: "check",
      id,
      skill,
      ability: skill ? undefined : ability,
      dc: dc ? Number(dc) : undefined,
    });
  }

  // --- applying actions -------------------------------------------------------------------

  private context() {
    const characters = Object.fromEntries(
      Object.entries(this.builds).map(([k, build]) => [
        k,
        { build, state: this.states[k] as CharacterState },
      ]),
    );
    return { catalog: this.catalog, characters, rng: this.rng };
  }

  /** Apply an action, show its notes, and ask the pending decisions it stops for. */
  private async apply(action: EncounterAction): Promise<void> {
    let next: EncounterAction | null = action;
    while (next) {
      let result: ReturnType<typeof applyEncounterAction>;
      try {
        result = applyEncounterAction(this.encounter, next, this.context());
      } catch (error) {
        if (error instanceof EncounterError) {
          for (const message of error.messages) this.con.error(message);
          return;
        }
        throw error;
      }
      this.encounter = result.encounter;
      Object.assign(this.states, result.states);
      this.history = recordAction(this.history, next, result);
      this.dirty = true;
      next = null;
      if (result.pending) {
        // The default answer is the engine's recommendation.
        const use = await this.con.confirm(result.pending.question, result.pending.recommended);
        next = { type: "decide", use };
      } else {
        for (const note of result.notes) this.con.say(`  ${note}`);
      }
    }
    if (this.encounter.round > 0 && this.encounter.combatants.some((c) => c.side === "enemies")) {
      const enemies = this.encounter.combatants.filter((c) => c.side === "enemies");
      if (enemies.every((c) => c.defeated)) {
        this.con.say(this.con.style("  All enemies are down ('end' ends the fight).", "green"));
      }
    }
  }

  /** Take back the last action: replay the history without it. */
  private undo(): void {
    const last = this.history.steps.at(-1);
    if (!last) {
      this.con.error("Nothing to undo");
      return;
    }
    const r = undoAction(this.history, this.context());
    this.history = r.history;
    this.encounter = r.encounter;
    Object.assign(this.states, r.states);
    this.dirty = true;
    this.con.say(`  Undone: ${last.action.type}.`);
  }

  /** A combatant by number (status order), id, name, or the start of a word in either. */
  private find(ref: string): EncounterCombatant | null {
    const e = this.encounter;
    if (/^\d+$/.test(ref)) {
      const id = e.order[Number(ref) - 1];
      const c = e.combatants.find((x) => x.id === id);
      if (c) return c;
    }
    const lower = ref.toLowerCase();
    const exact = e.combatants.find((c) => c.id === lower || c.name.toLowerCase() === lower);
    if (exact) return exact;
    // "dragon" finds "Adult Red Dragon": any word of the id or name can start the match.
    const words = (c: EncounterCombatant) => [
      c.id,
      c.name.toLowerCase(),
      ...c.id.split("-"),
      ...c.name.toLowerCase().split(" "),
    ];
    const partial = e.combatants.filter((c) => words(c).some((w) => w.startsWith(lower)));
    if (partial.length === 1) return partial[0] as EncounterCombatant;
    this.con.error(
      partial.length
        ? `'${ref}' could be ${partial.map((c) => c.id).join(" or ")}`
        : `No combatant '${ref}'`,
    );
    return null;
  }

  private save(): void {
    mkdirSync(this.saveDir, { recursive: true });
    for (const [key, state] of Object.entries(this.states)) {
      writeFileSync(join(this.saveDir, `${key}.state.json`), `${JSON.stringify(state, null, 2)}\n`);
    }
    const path = join(this.saveDir, "encounter.json");
    writeFileSync(path, `${JSON.stringify(this.encounter, null, 2)}\n`);
    this.dirty = false;
    this.con.say(this.con.style(`Saved the states and ${path}`, "green"));
  }
}

/** The one name matching `text` exactly or by prefix (case-insensitive), else `null`. */
function pick(names: readonly string[], text: string): string | null {
  const lower = text.toLowerCase();
  const exact = names.find((n) => n.toLowerCase() === lower);
  if (exact) return exact;
  const partial = names.filter((n) => n.toLowerCase().startsWith(lower));
  return partial.length === 1 ? (partial[0] as string) : null;
}

/** `1d10+8 slashing + 2d4 fire`: each part with its own type. */
function damageText(parts: readonly DamagePart[]): string {
  return parts.map((p) => `${formatDamage([p])} ${p.type}`).join(" + ");
}

function signedBonus(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

type Placement = { point?: { x: number; y: number }; toward?: { x: number; y: number } };

/** `@x,y` (a point) or `>x,y` (a direction) among command words, and the words left. */
function areaOf(words: readonly string[]): { area: Placement | undefined; rest: string[] } {
  let area: Placement | undefined;
  const rest: string[] = [];
  for (const word of words) {
    const m = /^([@>])(-?\d+),(-?\d+)$/.exec(word);
    if (!m) {
      rest.push(word);
      continue;
    }
    const square = { x: Number(m[2]), y: Number(m[3]) };
    area = m[1] === "@" ? { point: square } : { toward: square };
  }
  return { area, rest };
}
