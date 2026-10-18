/**
 * Encounters: initiative, rounds and turns, the action economy, and applying the results of
 * attacks, spells and saving throw effects to monsters and characters.
 *
 * Like play, every change is a JSON action applied by `applyEncounterAction`, which checks it
 * against the rules and throws `EncounterError` otherwise. Characters are referenced by key: the
 * caller passes their build and state in `characters`, and gets changed states back in `states`.
 */

import { type Catalog, lookup } from "../content/catalog";
import type { CharacterBuild } from "../models/build";
import type {
  Ability,
  DamageType,
  MonsterDef,
  Skill,
  SpellArea,
  SpellDef,
} from "../models/content";
import {
  type EffectEnd,
  type Encounter,
  type EncounterAction,
  type EncounterCombatant,
  EncounterCombatantSchema,
  type EncounterEffect,
  EncounterSchema,
  type Help,
  type MasteryMark,
  type Pending,
  type PointOfInterest,
  type SpellMark,
  type Zone,
} from "../models/encounter";
import { type EncounterEvent, FORCEABLE_REFUSALS, type RefusalCode } from "../models/events";
import type { Message } from "../models/messages";
import type { CharacterState, PlayAction } from "../models/state";
import {
  type AreaPlacement,
  areaSquares,
  distanceToPoint,
  type GridPoint,
  type GridSpace,
  inArea,
} from "../rules/areas";
import {
  castSpell,
  type SaveActionResult,
  type SpellCastResult,
  type SpellTargetResult,
  saveAgainst,
  useSaveAction,
} from "../rules/casting";
import {
  type AttackResult,
  type CheckResult,
  type Combatant,
  combatantFromMonster,
  type D20TestResult,
  type Decide,
  type Decision,
  decision,
  type ModeReason,
  makeAttack,
  modeReason,
  monsterSpells,
  type RollMode,
  resolveMode,
  rollAbilityCheck,
  rollD20,
  rollD20Test,
  rollSavingThrow,
  type SaveActionLine,
  type SaveResult,
} from "../rules/combatant";
import { formatDamage, type RolledDamage, rollDamage, takeDamage } from "../rules/damage";
import { parseDiceExpression, roll } from "../rules/dice";
import {
  type CoverDegree,
  coverDegree,
  findPath,
  type Wall as GridWall,
  gridDistance,
  lineClear,
  type Occupant,
  obstacles,
  spaceCorners,
  spaceForSize,
  key as squareKey,
  stepBlocked,
  stepCost,
  straightPath,
  type Terrain,
} from "../rules/grid";
import { message, plainMessage, ruleReason, texts, toMessage } from "../rules/messages";
import { mathRng, type Rng } from "../rules/rng";
import type { AttackLine } from "../rules/sheet";
import {
  type ByHandRoll,
  type CheckedCost,
  checkCosts,
  type DeclaredRolls,
  monsterCastLine,
  rollWith,
  spellcastingOf,
  strikeDice,
} from "./by-hand";
import { encounterEvents } from "./events";
import { applyAction, combatantFromCharacter, computePlaySheet, PlayError } from "./play";
import { refusalCode } from "./refusals";

export class EncounterError extends Error {
  override name = "EncounterError";
  readonly messages: readonly string[];
  /** A code per message, for a UI (`REFUSAL_CODES`). */
  readonly codes: readonly RefusalCode[];
  /** The same as `messages`, as data to translate: a code, its parameters and the English text. */
  readonly details: readonly Message[];
  /** With `force`: the refusals overridden before the one that stopped the action. */
  overridden: readonly Message[] = [];
  constructor(messages: readonly (Message | string)[]) {
    const details = messages.map(toMessage);
    super(texts(details).join("; "));
    this.details = details;
    this.messages = texts(details);
    this.codes = this.messages.map(refusalCode);
  }
}

export interface CharacterRef {
  readonly build: CharacterBuild;
  readonly state: CharacterState;
}

export interface EncounterContext {
  readonly catalog: Catalog;
  /** Characters by the key their combatants use (`character`). */
  readonly characters?: Readonly<Record<string, CharacterRef>>;
  readonly rng?: Rng;
}

/**
 * An action rolled by hand (`roll`), a free roll: the actor's dice, with no target, no action
 * economy, nothing spent and no outcome. The table applies what happens (`effects`) and pays
 * its costs (`spend`) if it wants to.
 */
export interface DeclaredResult {
  readonly manual: true;
  /** Who acted (combatant id). */
  readonly by: string;
  readonly action: "attack" | "unarmed" | "cast" | "feature" | "save_action" | "legendary";
  /** The attack, spell, feature, saving throw effect or legendary action. */
  readonly name: string;
  /** A spell's slot level (`null` for a cantrip or anything else). */
  readonly slot_level: number | null;
  readonly rolls: DeclaredRolls;
  /**
   * What it costs, nothing spent: each cost and whether it can be paid now, with the reason when
   * it can't (`spend` pays them).
   */
  readonly costs: readonly CheckedCost[];
}

export interface EncounterResult {
  readonly encounter: Encounter;
  /** Character states changed by the action, by character key. */
  readonly states: Readonly<Record<string, CharacterState>>;
  /** What happened, in English (each one is `messages[i].text`). */
  readonly notes: readonly string[];
  /** The same as `notes`, as data to translate: a code, its parameters and the English text. */
  readonly messages: readonly Message[];
  /**
   * The rolls of an `attack`, `save_action`, `cast`, `legendary`, `check`, `unarmed` or `escape`;
   * what was declared for one played by hand (`manual`).
   */
  readonly result:
    | DeclaredResult
    | AttackResult
    | SaveActionResult
    | SpellCastResult
    | CheckResult
    | SaveResult
    | D20TestResult
    | null;
  /** The decision the action stopped for (also in `encounter.pending`), if any. */
  readonly pending?: Pending | null;
  /** What changed, as data (turns, moves, HP, conditions, resources, effects, zones…). */
  readonly events: readonly EncounterEvent[];
  /**
   * The dice the action drew from `rng`, in order: replaying the action with them (`scriptedRng`)
   * gives the same result (`replayHistory`).
   */
  readonly rolls: readonly number[];
}

/** A new encounter. `auto_death_saves: false` leaves Death Saving Throws to the players. */
export function createEncounter(
  options: { auto_death_saves?: boolean; decisions?: "ask" | "auto" } = {},
): Encounter {
  return EncounterSchema.parse(options);
}

/** Whose turn it is, or `null` before the fight starts. */
export function currentCombatant(encounter: Encounter): EncounterCombatant | null {
  if (encounter.round === 0) return null;
  const id = encounter.order[encounter.turn];
  return encounter.combatants.find((c) => c.id === id) ?? null;
}

/** A combatant as combat sees it (for `makeAttack`, `castSpell`, `useSaveAction`). */
export function encounterCombatant(
  encounter: Encounter,
  id: string,
  ctx: EncounterContext,
): Combatant {
  const c =
    encounter.combatants.find((x) => x.id === id) ??
    fail(message("refusal.no_combatant_encounter", { id }));
  if (c.monster !== null) {
    const def = monsterDef(ctx, c);
    const base = combatantFromMonster(
      def,
      {
        hp: c.hp ?? def.hit_points,
        temp_hp: c.temp_hp,
        conditions: c.conditions,
        in_lair: c.in_lair,
        legendary_resistance_used: c.legendary_resistance_used,
        auto_legendary_resistance: c.auto_legendary_resistance,
      },
      { conditions: ctx.catalog.conditions },
    );
    // An ability waiting to recharge can't be used.
    const ready = (name: string) => !c.expended.includes(name);
    return withDodge(ctx, encounter, c, {
      ...base,
      id: c.id,
      name: c.name,
      inspiration_die: c.inspiration?.die ?? null,
      attacks: base.attacks.filter((a) => ready(a.name)),
      save_actions: base.save_actions.filter((a) => ready(a.name)),
    });
  }
  const ref = characterRef(ctx, c);
  return withDodge(ctx, encounter, c, {
    ...combatantFromCharacter(ref.build, ref.state, ctx.catalog),
    id: c.id,
    name: c.name,
    inspiration_die: c.inspiration?.die ?? null,
  });
}

/**
 * The Dodge action's benefits (SRD "Dodge"): attack rolls against it have Disadvantage, and it
 * makes Dexterity saves with Advantage; lost while Incapacitated or at Speed 0.
 */
/**
 * The monster whose Aura of Authority covers `c` (it or an ally on its side within the aura, not
 * Incapacitated), by name, or `null`; positions only.
 */
export function authorityOver(
  e: Encounter,
  ctx: EncounterContext,
  c: EncounterCombatant,
): string | null {
  if (!c.position) return null;
  for (const x of e.combatants) {
    if (x.monster === null || x.defeated || !x.position || x.side !== c.side) continue;
    const aura = monsterDef(ctx, x).traits.find((t) => t.advantage_aura)?.advantage_aura;
    if (!aura) continue;
    const d = x.id === c.id ? 0 : feetApart(ctx, x, c);
    if (d === null || d > aura.size) continue;
    if (conditionsOf(ctx, x).has("incapacitated")) continue;
    return x.name;
  }
  return null;
}

function withDodge(
  ctx: EncounterContext,
  encounter: Encounter,
  c: EncounterCombatant,
  original: Combatant,
): Combatant {
  // Aura of Authority: Advantage on saving throws (attack rolls: in the encounter's modes).
  const view = authorityOver(encounter, ctx, c)
    ? {
        ...original,
        advantages: [
          ...original.advantages,
          ...(["str", "dex", "con", "int", "wis", "cha"] as const).map((a) => `save.${a}` as const),
        ],
      }
    : original;
  // Staggering Blow: Disadvantage on its next saving throw.
  const base = encounter.marks.some((m) => m.kind === "staggered" && m.on === c.id)
    ? {
        ...view,
        condition_rolls: {
          ...view.condition_rolls,
          save_disadvantage: Object.fromEntries(
            (["str", "dex", "con", "int", "wis", "cha"] as const).map((a) => [a, "staggered"]),
          ),
        },
      }
    : view;
  if (!c.dodging || base.conditions.includes("incapacitated") || speedOf(ctx, c, encounter) === 0) {
    return base;
  }
  const dodge = {
    mode: "disadvantage",
    condition: "Dodging",
    id: "dodging",
    except_against_source: false,
  } as const;
  const rolls = base.condition_rolls;
  return {
    ...base,
    advantages: [...base.advantages, "save.dex"],
    condition_rolls: {
      ...rolls,
      attacked: [...rolls.attacked, dodge],
      attacked_beyond_5ft: [...rolls.attacked_beyond_5ft, dodge],
    },
  };
}

export function applyEncounterAction(
  encounter: Encounter,
  action: EncounterAction,
  outer: EncounterContext,
  /** `events: false` skips working out `events` (a dry run doesn't need them). */
  { events: withEvents = true }: { events?: boolean } = {},
): EncounterResult {
  const pending = encounter.pending;
  const drawn: number[] = [];
  const base = outer.rng ?? mathRng;
  const counted: EncounterContext = {
    ...outer,
    rng: {
      int: (min, max) => {
        const value = base.int(min, max);
        drawn.push(value);
        return value;
      },
    },
  };
  let r: Omit<EncounterResult, "events" | "rolls">;
  if (action.type === "decide") {
    if (!pending) fail(message("refusal.there_no_decision_make"));
    // Replay the stopped action with the same dice and one more answer.
    const clear = { ...encounter, pending: null };
    r = attempt(clear, pending.action, counted, pending.rolls, [...pending.answers, action.use]);
  } else {
    if (pending) {
      const question = pending.question_message ?? plainMessage(pending.question);
      fail(message("refusal.waiting_decision", { question }));
    }
    r = attempt(encounter, action, counted, [], []);
  }
  if (!withEvents) return { ...r, events: [], rolls: drawn };
  const events = encounterEvents(
    encounter,
    r.encounter,
    outer.catalog,
    outer.characters,
    r.states,
    action.type === "decide" && pending ? pending.action : action,
  );
  return { ...r, events, rolls: drawn };
}

/** Thrown when an action needs an answer it doesn't have: the action stops with nothing applied. */
class PendingDecision {
  constructor(
    readonly combatant: string,
    readonly kind: Decision["kind"],
    readonly question: Message,
    readonly recommended: boolean,
  ) {}
}

/** Run an action with recorded dice; a decision without an answer leaves it pending. */
function attempt(
  encounter: Encounter,
  action: EncounterAction,
  outer: EncounterContext,
  rolls: readonly number[],
  answers: readonly boolean[],
): Omit<EncounterResult, "events" | "rolls"> {
  const recorded: number[] = [];
  const base = outer.rng ?? mathRng;
  const rng: Rng = {
    int: (min, max) => {
      const value =
        recorded.length < rolls.length ? (rolls[recorded.length] as number) : base.int(min, max);
      recorded.push(value);
      return value;
    },
  };
  const overridden: Message[] = [];
  try {
    return run(encounter, action, { ...outer, rng }, answers, overridden);
  } catch (error) {
    if (error instanceof EncounterError) error.overridden = overridden;
    if (!(error instanceof PendingDecision)) throw error;
    const stopped = {
      action,
      rolls: recorded,
      answers: [...answers],
      combatant: error.combatant,
      kind: error.kind,
      question: error.question.text,
      question_message: error.question,
      recommended: error.recommended,
    };
    return {
      encounter: EncounterSchema.parse({ ...encounter, pending: stopped }),
      states: {},
      notes: [error.question.text],
      messages: [error.question],
      result: null,
      pending: stopped,
    };
  }
}

function run(
  encounter: Encounter,
  action: EncounterAction,
  outer: EncounterContext,
  answers: readonly boolean[],
  overridden: Message[],
): Omit<EncounterResult, "events" | "rolls"> {
  const e = structuredClone(encounter) as Encounter;
  // What happened, as messages; sentences from play and damage have code `text` for now.
  const notes: Message[] = [];
  const states: Record<string, CharacterState> = {};
  // `force`: the GM overrides a refusal of legality (`FORCEABLE_REFUSALS`), noted in the log.
  const forcing = "force" in action && action.force === true;
  const forceable = (reason: Message) =>
    forcing && (FORCEABLE_REFUSALS as readonly string[]).includes(refusalCode(reason.text));
  /** A refusal the GM can override: with `force`, a note instead, and the action goes on. */
  const refuse = (reason: Message): void => {
    if (!forceable(reason)) fail(reason);
    overridden.push(reason);
    notes.push(message("override.applied", { reason }));
  };
  // `release`: the readied action, taken with the reaction (checked here, spent at the end).
  let releasing: { id: string; held: boolean } | null = null;
  if (action.type === "release") {
    const id = action.id;
    const c =
      e.combatants.find((x) => x.id === id) ??
      fail(message("refusal.no_combatant_encounter", { id }));
    const readied = c.readied ?? fail(message("refusal.nothing_readied", { name: c.name }));
    if (c.used.reaction) refuse(message("refusal.already_used_reaction", { name: c.name }));
    releasing = { id: c.id, held: readied.held };
    notes.push(message("readied.taken", { name: c.name, trigger: readied.trigger }));
    action = readied.action as EncounterAction;
  }
  // A working copy of the characters: several can change in one action (attacker and target).
  const chars: Record<string, CharacterRef> = { ...(outer.characters ?? {}) };
  const ctx: EncounterContext = { ...outer, characters: chars };
  const rng = ctx.rng ?? mathRng;
  let result: EncounterResult["result"] = null;
  /** An action played by hand: its note, the dice rolled and their notes. */
  const byHand = (
    c: EncounterCombatant,
    kind: DeclaredResult["action"],
    name: string,
    slot: number | null,
    rolled: Partial<DeclaredRolls>,
    costs: readonly CheckedCost[],
  ): DeclaredResult => {
    const rolls = { attacks: [], damage: null, healing: null, save: null, ...rolled };
    notes.push(message("manual.declared", { name: c.name, what: name, level: slot ?? 0 }));
    for (const a of rolls.attacks) {
      notes.push(
        message("manual.attack", {
          attack: a.attack,
          total: a.total,
          d20: a.roll.d20,
          critical: a.critical_hit ? "hit" : a.critical_miss ? "miss" : "none",
          count: a.reasons.length,
          reasons: [...a.reason_messages],
        }),
      );
      if (a.damage) notes.push(damageRolled(a.attack, a.damage));
    }
    if (rolls.save) {
      notes.push(
        message("manual.save", {
          what: name,
          ability: rolls.save.ability ? abilityMsg(rolls.save.ability) : "none",
          dc: rolls.save.dc,
        }),
      );
    }
    if (rolls.damage) notes.push(damageRolled(name, rolls.damage));
    if (rolls.healing !== null) {
      notes.push(message("manual.healing", { what: name, amount: rolls.healing }));
    }
    return { manual: true, by: c.id, action: kind, name, slot_level: slot, rolls, costs };
  };
  // Decisions after a roll: `auto` takes the recommendation; `ask` uses the next answer given,
  // or stops the action for one.
  let answered = 0;
  const decide: Decide = (d) => {
    const c = d.combatant.id ? e.combatants.find((x) => x.id === d.combatant.id) : undefined;
    if (!c || (c.decisions ?? e.decisions) === "auto") return d.recommended;
    if (answered < answers.length) return answers[answered++] as boolean;
    throw new PendingDecision(c.id, d.kind, d.message, d.recommended);
  };
  const play = (c: EncounterCombatant, a: PlayAction): void => {
    const ref = characterRef(ctx, c);
    let r: ReturnType<typeof applyAction>;
    try {
      r = applyAction(ref.build, ref.state, ctx.catalog, a, { rng });
    } catch (error) {
      // Forced, a cost the character can't pay (a slot, a feature's use) isn't spent.
      if (error instanceof PlayError && error.details.every(forceable)) {
        overridden.push(...error.details);
        notes.push(...error.details.map((reason) => message("override.applied", { reason })));
        return;
      }
      if (error instanceof PlayError) {
        throw new EncounterError(
          error.details.map((reason) => message("refusal.character", { name: c.name, reason })),
        );
      }
      throw error;
    }
    chars[c.character as string] = { build: ref.build, state: r.state };
    states[c.character as string] = r.state;
    notes.push(...r.messages);
  };
  const concentrationOf = (c: EncounterCombatant): string | null =>
    c.monster !== null ? c.concentration : characterRef(ctx, c).state.concentration;
  /** Apply play actions to a combatant; a concentrating one saves against damage. */
  const applyTo = (c: EncounterCombatant, actions: readonly PlayAction[]): void => {
    for (const a of actions) {
      let dc: number | null = null;
      let dealt = 0;
      if (a.type === "damage") {
        const t = encounterCombatant(e, c.id, ctx);
        const instances = a.instances ?? [{ amount: a.amount ?? 0, type: a.damage_type ?? null }];
        const vitals = { hp: t.hp, temp: t.temp_hp, max: t.max_hp };
        const taken = takeDamage(vitals, instances, t.defenses, { critical: a.critical });
        dc = taken.concentration_dc;
        dealt = taken.dealt;
      }
      if (c.monster !== null) {
        const alive = !c.defeated;
        notes.push(...monsterEffect(ctx, c, a));
        if (alive && c.defeated) deathBurst(c);
      } else {
        const relentless = a.type === "damage" ? relentlessRage(c, a) : null;
        if (relentless === null) play(c, a);
        else {
          // "your Hit Points instead change to a number equal to twice your Barbarian level":
          // the damage takes its Temporary Hit Points, then its Hit Points become that number.
          const view = encounterCombatant(e, c.id, ctx);
          if (view.hp + view.temp_hp > relentless) {
            play(c, { type: "damage", amount: view.hp + view.temp_hp - relentless });
          } else {
            if (view.temp_hp) play(c, { type: "set_temp_hp", amount: 0 });
            if (relentless > view.hp) play(c, { type: "heal", amount: relentless - view.hp });
          }
          notes.push(message("relentless_rage.hp", { name: c.name, hp: relentless }));
        }
        if (a.type === "activate") {
          c.toggled_on.push(a.key);
          const ref = characterRef(ctx, c);
          const t = computePlaySheet(ref.build, ref.state, ctx.catalog).toggles.find(
            (x) => x.key === a.key,
          );
          if (t?.rounds) c.toggle_rounds[a.key] = t.rounds;
        }
      }
      // "This effect ends early on the creature if it takes any damage" (Turn Undead).
      if (dealt > 0) {
        for (const effect of e.effects.filter(
          (x) => x.target === c.id && x.ends_on.includes("damage"),
        )) {
          endEffect(effect, message("why.took_damage"));
        }
      }
      const spell = concentrationOf(c);
      if (dc !== null && spell) {
        const save = rollSavingThrow(encounterCombatant(e, c.id, ctx), "con", dc, { rng, decide });
        spendLegendaryResistance(c, save);
        const outcome = saveText(save);
        if (save.success) {
          notes.push(message("concentration.kept", { name: c.name, spell, save: outcome }));
        } else {
          notes.push(message("concentration.lost", { name: c.name, spell, save: outcome }));
          if (c.monster !== null) c.concentration = null;
          else play(c, { type: "set_concentration", spell: null });
        }
      }
    }
  };
  /**
   * Relentless Rage (SRD): damage that would drop a raging Barbarian to 0 Hit Points without
   * killing it outright allows a Constitution save, DC 10 + 5 per use since its last rest; on a
   * success its Hit Points become twice its Barbarian level (returned), else `null`.
   */
  const relentlessRage = (
    c: EncounterCombatant,
    a: Extract<PlayAction, { type: "damage" }>,
  ): number | null => {
    const ref = characterRef(ctx, c);
    const sheet = computePlaySheet(ref.build, ref.state, ctx.catalog);
    if (!sheet.rules.includes("relentless_rage")) return null;
    if (!sheet.toggles.some((t) => t.active && t.key.endsWith(":rage"))) return null;
    const view = encounterCombatant(e, c.id, ctx);
    const instances = a.instances ?? [{ amount: a.amount ?? 0, type: a.damage_type ?? null }];
    const taken = takeDamage(
      { hp: view.hp, temp: view.temp_hp, max: view.max_hp },
      instances,
      view.defenses,
      { critical: a.critical },
    );
    if (!taken.dropped_to_zero || taken.died) return null;
    const use = sheet.play.uses.find((u) => u.key.endsWith(":relentless-rage"));
    const dc = 10 + 5 * (use?.spent ?? 0);
    const question = message("decision.relentless_rage", { name: c.name, dc });
    if (!decide(decision("relentless_rage", view, question, true))) return null;
    if (use) play(c, { type: "use", key: use.key });
    const save = rollSavingThrow(view, "con", dc, { rng, decide });
    notes.push(
      message("relentless_rage.save", {
        name: c.name,
        success: save.success,
        save: saveText(save),
      }),
    );
    if (!save.success) return null;
    return 2 * (sheet.classes.find((x) => x.class_id === "barbarian")?.level ?? 0);
  };
  /** End an effect; its condition goes unless another effect still gives it. */
  const endEffect = (effect: EncounterEffect, why: Message): void => {
    e.effects = e.effects.filter((x) => x.id !== effect.id);
    const target = e.combatants.find((c) => c.id === effect.target);
    const still = e.effects.some(
      (x) => x.target === effect.target && x.condition === effect.condition,
    );
    const name = lookup(ctx.catalog.conditions, effect.condition)?.name ?? effect.condition;
    notes.push(
      message("effect.ends", {
        condition: name,
        target: target?.name ?? effect.target,
        label: effect.label,
        why,
      }),
    );
    if (!target || still) return;
    if (target.monster !== null) {
      target.conditions = target.conditions.filter((x) => x !== effect.condition);
    } else if (characterRef(ctx, target).state.conditions.includes(effect.condition)) {
      play(target, { type: "remove_condition", condition: effect.condition });
    }
  };
  /** Register timed or Concentration effects for the conditions a target now has. */
  const addEffects = (
    target: EncounterCombatant,
    conditions: readonly string[],
    opts: {
      source: string | null;
      label: string;
      concentration: boolean;
      ends: EffectEnd | null;
      escape_dc?: number | null;
      escape_skill?: "athletics" | "acrobatics" | null;
      ends_on?: ("damage" | "source_incapacitated")[];
      repeat_save?: { ability: Ability; dc: number } | null;
    },
  ): void => {
    const has = conditionsOf(ctx, target);
    for (const condition of conditions) {
      if (!has.has(condition)) continue; // immune
      e.effects.push({
        id: `effect-${e.next_effect++}`,
        target: target.id,
        condition,
        ...opts,
        escape_dc: opts.escape_dc ?? null,
        escape_skill: opts.escape_skill ?? null,
        ends_on: opts.ends_on ?? [],
        repeat_save: opts.repeat_save ?? null,
      });
    }
  };
  const endsFrom = (
    target: string,
    source: string | undefined,
    rounds: number | undefined,
    until: { at: "start" | "end"; of?: string } | undefined,
  ): EffectEnd | null => {
    if (rounds !== undefined) {
      return { at: "start", of: source ?? target, count: rounds, skip_current: false };
    }
    if (until) {
      const of = until.of ?? source ?? target;
      find(of);
      return {
        at: until.at,
        of,
        count: 1,
        skip_current: until.at === "end" && current()?.id === of,
      };
    }
    return null;
  };
  /** Count down effects that end at the start or end of `c`'s turn. */
  const tick = (c: EncounterCombatant, at: "start" | "end"): void => {
    for (const effect of [...e.effects]) {
      const ends = effect.ends;
      if (!ends || ends.at !== at || ends.of !== c.id) continue;
      if (ends.skip_current) {
        ends.skip_current = false;
        continue;
      }
      ends.count -= 1;
      if (ends.count <= 0) endEffect(effect, message("why.duration_over"));
    }
    for (const mark of [...e.masteries]) {
      const ends = mark.ends;
      if (ends.at !== at || ends.of !== c.id) continue;
      if (ends.skip_current) ends.skip_current = false;
      else if (--ends.count <= 0) e.masteries = e.masteries.filter((m) => m !== mark);
    }
    for (const mark of [...e.marks]) {
      const ends = mark.ends;
      if (!ends || ends.at !== at || ends.of !== c.id) continue;
      if (ends.skip_current) ends.skip_current = false;
      else if (--ends.count <= 0) e.marks = e.marks.filter((m) => m !== mark);
    }
    for (const zone of [...e.zones]) {
      const ends = zone.ends;
      if (!ends || ends.at !== at || ends.of !== c.id) continue;
      if (ends.skip_current) ends.skip_current = false;
      else if (--ends.count <= 0) endZone(zone, message("why.duration_over"));
    }
  };
  /**
   * The squares' origin of a zone: its point, or for an Emanation its caster's space, or the
   * space at its point (`space` squares wide).
   */
  const zoneSquares = (z: Zone): Set<string> | null => zoneArea(e, ctx, z);
  /** Whether `x`, at its position now, is in the zone (an Emanation doesn't include its caster). */
  const inZoneNow = (z: Zone, squares: ReadonlySet<string> | null, x: EncounterCombatant) =>
    !!squares &&
    !!x.position &&
    !outOfFight(ctx, x) &&
    !(z.area.shape === "emanation" && !z.point && x.id === z.by) &&
    inArea(squares, { position: x.position, size: spaceOf(ctx, x) });
  /** The positioned creatures in a zone. */
  const inZone = (z: Zone): string[] => {
    const squares = zoneSquares(z);
    return e.combatants.filter((x) => inZoneNow(z, squares, x)).map((x) => x.id);
  };
  /**
   * Creatures save against a zone (`why`: "ends its turn in it"), each once per turn when the
   * spell says so; the damage is rolled once for all of them. When the save is the caster's to
   * force (Conjure Animals), the caster decides for each creature.
   */
  const zoneSave = (z: Zone, ids: readonly string[], why: Message): void => {
    const save = z.save;
    if (!save) {
      if (z.no_save && z.damage.length) zoneDamage(z, ids, why);
      return;
    }
    const caster = e.combatants.find((x) => x.id === z.by);
    const who = ids.map(find).filter((t) => {
      if (z.unaffected.includes(t.id) || outOfFight(ctx, t)) return false;
      if (z.once_per_turn && z.saved.includes(t.id)) return false;
      if (!z.optional || !caster) return true;
      if (t.id === caster.id) return false; // the caster doesn't force itself
      const question = message("decision.zone_force", {
        name: caster.name,
        target: t.name,
        why,
        ability: abilityMsg(save.ability),
        label: z.label,
      });
      const view = encounterCombatant(e, caster.id, ctx);
      return decide(decision("zone_force", view, question, !alliesOf(e, t.id, caster)));
    });
    if (!who.length) return;
    const views = who.map((t) => encounterCombatant(e, t.id, ctx));
    const r = saveAgainst({ ...save, conditions: z.conditions }, z.damage, views, { rng, decide });
    notes.push(
      message("zone.save", {
        label: z.label,
        names: who.map((t) => t.name),
        why,
        ability: abilityMsg(save.ability),
        dc: save.dc,
      }),
    );
    for (const hit of r.targets) {
      const t = who[hit.target] as EncounterCombatant;
      z.saved.push(t.id);
      spendLegendaryResistance(t, hit.save);
      notes.push(targetNote(t.name, hit));
      applyTo(t, hit.actions);
      if (hit.save?.success) continue;
      if (hit.conditions.length && (z.concentration || z.until)) {
        addEffects(t, hit.conditions, {
          source: z.by,
          label: z.label,
          // "until the end of the current turn" (Stinking Cloud), else while the spell lasts.
          concentration: z.until ? false : z.concentration,
          ends: z.until ? { at: "end", of: t.id, count: 1, skip_current: false } : null,
          escape_dc: z.escape_dc,
          escape_skill: z.escape_skill,
        });
      }
      if (z.on_fail.includes("no_actions") && current()?.id === t.id) {
        t.used.action = true;
        t.used.bonus_action = true;
        notes.push(message("zone.no_actions", { name: t.name }));
      }
      const spell = z.on_fail.includes("lose_concentration") ? concentrationOf(t) : null;
      if (spell) {
        notes.push(message("zone.lose_concentration", { name: t.name, spell, label: z.label }));
        if (t.monster !== null) t.concentration = null;
        else play(t, { type: "set_concentration", spell: null });
      }
    }
  };
  /** A zone's damage without a save (Wall of Fire), rolled once, each creature once per turn. */
  const zoneDamage = (z: Zone, ids: readonly string[], why: Message): void => {
    const who = ids
      .map(find)
      .filter(
        (t) =>
          !z.unaffected.includes(t.id) &&
          !outOfFight(ctx, t) &&
          !(z.once_per_turn && z.saved.includes(t.id)),
      );
    if (!who.length) return;
    const rolled = rollDamage(z.damage, { rng });
    const instances = rolled.parts.map((p) => ({ amount: p.total, type: p.type }));
    for (const t of who) {
      z.saved.push(t.id);
      notes.push(
        message("zone.damage", { label: z.label, name: t.name, why, dealt: dealtMsg(instances) }),
      );
      applyTo(t, [{ type: "damage", instances }]);
    }
  };
  /** Damage for every 5 feet moved into or within zones that deal it (Spike Growth). */
  const zoneMoveDamage = (c: EncounterCombatant, steps: Map<string, number>): void => {
    for (const z of [...e.zones]) {
      const n = steps.get(z.id) ?? 0;
      if (!n || z.unaffected.includes(c.id) || outOfFight(ctx, c)) continue;
      const parts = z.damage.map((d) => {
        if (!d.dice) return { ...d, bonus: d.bonus * n };
        const { count, sides } = parseDiceExpression(d.dice);
        return { ...d, dice: `${count * n}d${sides}`, bonus: d.bonus * n };
      });
      const rolled = rollDamage(parts, { rng });
      const instances = rolled.parts.map((p) => ({ amount: p.total, type: p.type }));
      notes.push(
        message("zone.move_damage", {
          label: z.label,
          name: c.name,
          feet: n * 5,
          dealt: dealtMsg(instances),
        }),
      );
      applyTo(c, [{ type: "damage", instances }]);
    }
  };
  /** Who is in each zone now, to find who enters one after a move. */
  const zoneOccupants = (): Map<string, Set<string>> =>
    new Map(e.zones.map((z) => [z.id, new Set(inZone(z))]));
  /** Creatures now in a zone that weren't before (they entered it, or it moved onto them) save. */
  const zoneEntries = (before: Map<string, Set<string>>): void => {
    for (const z of [...e.zones]) {
      if (!z.triggers.includes("enter")) continue;
      const was = before.get(z.id) ?? new Set<string>();
      const entered = inZone(z).filter((id) => !was.has(id));
      if (entered.length)
        zoneSave(z, entered, message("why.enters_zone", { count: entered.length }));
    }
  };
  /** Zones with this trigger that `c` is in make it save. */
  const zoneTurn = (c: EncounterCombatant, at: "start_turn" | "end_turn"): void => {
    for (const z of [...e.zones]) {
      if (!z.triggers.includes(at) || !inZone(z).includes(c.id)) continue;
      zoneSave(z, [c.id], message(at === "start_turn" ? "why.starts_turn_in" : "why.ends_turn_in"));
    }
  };
  const endZone = (z: Zone, why: Message): void => {
    e.zones = e.zones.filter((x) => x.id !== z.id);
    notes.push(message("zone.ends", { label: z.label, why }));
  };
  /** The creatures in an Emanation of `size` feet around `c` (not `c`), by position. */
  const emanationAround = (c: EncounterCombatant, size: number): EncounterCombatant[] | null => {
    if (!c.position) return null;
    const squares = areaSquares(
      { shape: "emanation", size, width: 5 },
      { position: c.position, size: spaceOf(ctx, c) },
      {},
    );
    return e.combatants.filter(
      (x) =>
        x.id !== c.id &&
        x.position &&
        !outOfFight(ctx, x) &&
        inArea(squares, { position: x.position, size: spaceOf(ctx, x) }),
    );
  };
  /** A monster's trait that saves when it dies (Death Burst, Death Throes), around its space. */
  const deathBurst = (c: EncounterCombatant): void => {
    const trait = monsterDef(ctx, c).traits.find((t) => t.trigger === "death" && t.save?.area);
    const save = trait?.save;
    if (!trait || !save?.area) return;
    const around = emanationAround(c, save.area.size);
    if (!around) {
      notes.push(
        message("trait.burst_unplaced", {
          trait: trait.name,
          feet: save.area.size,
          name: c.name,
          ability: abilityMsg(save.ability),
          dc: save.dc,
        }),
      );
      return;
    }
    notes.push(
      message("trait.burst", {
        trait: trait.name,
        name: c.name,
        ability: abilityMsg(save.ability),
        dc: save.dc,
      }),
    );
    if (!around.length) return;
    const parts = save.damage.map((d) => ({ dice: d.dice, bonus: d.bonus, type: d.type }));
    const views = around.map((x) => encounterCombatant(e, x.id, ctx));
    const r = saveAgainst(
      {
        ability: save.ability,
        dc: save.dc,
        on_success: save.on_success,
        conditions: save.conditions,
      },
      parts,
      views,
      { rng, decide },
    );
    for (const hit of r.targets) {
      const t = around[hit.target] as EncounterCombatant;
      spendLegendaryResistance(t, hit.save);
      notes.push(targetNote(t.name, hit));
      applyTo(t, hit.actions);
    }
  };
  /** A monster's damage aura at the end of its turn (Fire Aura), to the creatures around it. */
  const auraDamage = (c: EncounterCombatant): void => {
    if (c.monster === null || c.defeated) return;
    for (const trait of monsterDef(ctx, c).traits) {
      const aura = trait.aura;
      if (!aura) continue;
      if (aura.not_incapacitated && conditionsOf(ctx, c).has("incapacitated")) continue;
      const around = emanationAround(c, aura.size);
      const dice = aura.damage.map((d) => ({ dice: d.dice, bonus: d.bonus, type: d.type }));
      if (!around) {
        notes.push(
          message("trait.aura_unplaced", {
            trait: trait.name,
            feet: aura.size,
            name: c.name,
            dice: formatDamage(dice),
            type: aura.damage[0]?.type ?? "",
          }),
        );
        continue;
      }
      // "each creature of the azer's choice": its enemies, unless the caller says otherwise.
      const who = aura.choice ? around.filter((x) => !alliesOf(e, x.id, c)) : around;
      if (!who.length) continue;
      const rolled = rollDamage(dice, { rng });
      const instances = rolled.parts.map((p) => ({ amount: p.total, type: p.type }));
      for (const t of who) {
        notes.push(
          message("trait.aura_damage", {
            trait: trait.name,
            name: t.name,
            dealt: dealtMsg(instances),
          }),
        );
        applyTo(t, [{ type: "damage", instances }]);
      }
    }
  };
  /** Regeneration at the start of its turn: Hit Points back, or death at 0 if it can't. */
  const regenerate = (c: EncounterCombatant): void => {
    if (c.monster === null || c.defeated) return;
    const def = monsterDef(ctx, c);
    const regen = def.traits.find((t) => t.regeneration);
    if (!regen?.regeneration) return;
    const hp = c.hp ?? def.hit_points;
    if (c.regeneration_blocked) {
      c.regeneration_blocked = false;
      if (hp === 0) {
        c.defeated = true;
        notes.push(message("regeneration.dies", { name: c.name }));
        deathBurst(c);
      } else notes.push(message("regeneration.blocked", { name: c.name, trait: regen.name }));
      return;
    }
    if (hp >= def.hit_points) return;
    c.hp = Math.min(def.hit_points, hp + regen.regeneration.amount);
    if (hp === 0) c.conditions = c.conditions.filter((x) => x !== "unconscious");
    notes.push(
      message("regeneration.heals", { name: c.name, amount: c.hp - hp, trait: regen.name }),
    );
  };
  /** The end of `c`'s turn: effects, and toggles that weren't extended (Rage). */
  const endTurn = (c: EncounterCombatant): void => {
    auraDamage(c);
    zoneTurn(c, "end_turn");
    // "At the end of each of its turns … repeats the save, ending the effect on itself on a success."
    for (const effect of e.effects.filter((x) => x.target === c.id && x.repeat_save)) {
      const again = effect.repeat_save as { ability: Ability; dc: number };
      const save = rollSavingThrow(encounterCombatant(e, c.id, ctx), again.ability, again.dc, {
        rng,
        decide,
      });
      spendLegendaryResistance(c, save);
      notes.push(
        message("effect.repeat_save", { name: c.name, label: effect.label, save: saveText(save) }),
      );
      if (save.success) endEffect(effect, message("why.saved"));
    }
    tick(c, "end");
    if (c.character !== null) {
      const ref = characterRef(ctx, c);
      const sheet = computePlaySheet(ref.build, ref.state, ctx.catalog);
      for (const t of sheet.toggles) {
        if (t.active && t.extends_each_turn && !c.extended && !c.toggled_on.includes(t.key)) {
          notes.push(message("toggle.not_extended", { toggle: t.name }));
          play(c, { type: "deactivate", key: t.key });
        }
      }
    }
    c.toggled_on = [];
    c.extended = false;
    c.disengaged = false;
    c.light_attacks = [];
    c.nick_used = false;
    c.cleave = null;
    c.cleave_used = false;
    c.surged = false;
    c.granted_attacks = null;
    c.hits = [];
    c.last_hit = null;
    c.features_used = [];
  };
  /** The start of `c`'s turn: effects, recharges; once-per-turn riders reset for everyone. */
  const startTurn = (c: EncounterCombatant): void => {
    regenerate(c);
    // A dying character makes a Death Saving Throw at the start of its turn (SRD).
    if (c.character !== null) {
      const ref = characterRef(ctx, c);
      const play = computePlaySheet(ref.build, ref.state, ctx.catalog).play;
      if (play.dying && e.auto_death_saves) applyTo(c, [{ type: "death_save" }]);
      else if (play.dying) notes.push(message("turn.death_save", { name: c.name }));
    }
    for (const x of e.combatants) x.riders_used = [];
    // "Only once per turn": every creature's turn is a new one.
    for (const z of e.zones) z.saved = [];
    // Toggles that last until the start of your next turn (Reckless Attack) end; those with a
    // duration (Rage's 10 minutes) count it down.
    if (c.character !== null) {
      const ref = characterRef(ctx, c);
      for (const t of computePlaySheet(ref.build, ref.state, ctx.catalog).toggles) {
        if (!t.active) {
          delete c.toggle_rounds[t.key];
          continue;
        }
        if (t.ends_at_turn_start) {
          notes.push(message("toggle.turn_start", { toggle: t.name, name: c.name }));
          play(c, { type: "deactivate", key: t.key });
          continue;
        }
        const left = c.toggle_rounds[t.key];
        if (left === undefined || c.toggled_on.includes(t.key)) continue;
        if (left <= 1) {
          delete c.toggle_rounds[t.key];
          notes.push(message("toggle.duration_over", { toggle: t.name }));
          play(c, { type: "deactivate", key: t.key });
        } else c.toggle_rounds[t.key] = left - 1;
      }
    }
    // A readied action lasts until the start of its next turn; a held spell is lost.
    if (c.readied) {
      const spell = c.readied.held ? c.readied.action : null;
      notes.push(message("readied.lost", { name: c.name }));
      c.readied = null;
      if (spell?.type === "cast") {
        const name = lookup(ctx.catalog.spells, spell.spell)?.name ?? spell.spell;
        if (concentrationOf(c) === name) {
          if (c.monster !== null) c.concentration = null;
          else play(c, { type: "set_concentration", spell: null });
        }
      }
    }
    // Dodge lasts, and Help can be used, until the start of the creature's next turn.
    c.dodging = false;
    e.helps = e.helps.filter((h) => h.by !== c.id);
    // Legendary action uses come back at the start of the monster's turn.
    c.legendary_used = 0;
    c.legendary_taken = [];
    tick(c, "start");
    zoneTurn(c, "start_turn");
    if (c.monster !== null && c.expended.length) {
      const def = monsterDef(ctx, c);
      const all = [
        ...def.actions,
        ...def.bonus_actions,
        ...def.reactions,
        ...def.legendary_actions,
      ];
      for (const name of [...c.expended]) {
        const min = Number(
          /^(\d)/.exec(all.find((a) => a.name === name)?.recharge ?? "")?.[1] ?? 7,
        );
        const d6 = rng.int(1, 6);
        if (d6 >= min) {
          c.expended = c.expended.filter((x) => x !== name);
          notes.push(message("recharge.yes", { name: c.name, action: name, roll: d6 }));
        } else notes.push(message("recharge.no", { name: c.name, action: name, roll: d6 }));
      }
    }
  };
  /** A monster's save turned into a success by Legendary Resistance: one use spent. */
  /** A Bardic Inspiration die added to a roll is gone. */
  const useInspiration = (c: EncounterCombatant, rolled: number | null | undefined): void => {
    if (rolled === null || rolled === undefined || !c.inspiration) return;
    notes.push(message("inspiration.used", { name: c.name, roll: rolled }));
    c.inspiration = null;
  };
  const spendLegendaryResistance = (c: EncounterCombatant, save: SaveResult | null): void => {
    // Staggering Blow's Disadvantage is on the next saving throw only.
    if (save) e.marks = e.marks.filter((m) => !(m.kind === "staggered" && m.on === c.id));
    if (save?.indomitable && c.character !== null) {
      const ref = characterRef(ctx, c);
      const use = computePlaySheet(ref.build, ref.state, ctx.catalog).play.uses.find((u) =>
        u.key.endsWith(":indomitable"),
      );
      if (use) play(c, { type: "use", key: use.key });
      notes.push(message("indomitable.used", { name: c.name }));
    }
    useInspiration(c, save?.inspiration);
    if (!save?.legendary_resistance || c.monster === null) return;
    c.legendary_resistance_used += 1;
    const def = monsterDef(ctx, c);
    const max = def.legendary_resistance
      ? c.in_lair && def.legendary_resistance.in_lair !== null
        ? def.legendary_resistance.in_lair
        : def.legendary_resistance.uses
      : 0;
    const left = Math.max(0, max - c.legendary_resistance_used);
    notes.push(message("legendary_resistance.used", { name: c.name, left }));
  };
  /** Put `c` on a square; another creature's space can't be the end of a move. */
  const occupy = (c: EncounterCombatant, to: { x: number; y: number }): void => {
    const size = spaceOf(ctx, c);
    const blocked = new Set(e.map.blocked.map(squareKey));
    for (let dx = 0; dx < size; dx++) {
      for (let dy = 0; dy < size; dy++) {
        if (blocked.has(`${to.x + dx},${to.y + dy}`))
          fail(message("refusal.square_blocked", { x: to.x + dx, y: to.y + dy }));
      }
    }
    const taken = spaceTaken(c, to);
    if (taken) fail(message("refusal.space", { taken: taken.name }));
    c.position = { ...to };
  };
  /**
   * The hidden points a character (not a monster) notices where it stands now, by its Passive
   * Perception; they're added to `noticed_by` (for the GM, who reveals them or not).
   */
  const notice = (c: EncounterCombatant): PointOfInterest[] => {
    if (c.character === null) return [];
    const passive = combatantPassivePerception(e, ctx, c.id);
    const found = pointsInSight(e, ctx, c).filter(
      (p) => !p.noticed_by.includes(c.id) && passive >= (p.dc as number),
    );
    for (const p of found) p.noticed_by.push(c.id);
    if (found.length) notes.push(message("explore.notices", { name: c.name }));
    halt(found);
    return found;
  };
  /** Outside a fight, with `notice_stops: everyone`, a noticed point holds every move. */
  const halt = (found: readonly PointOfInterest[]): void => {
    const first = found[0];
    if (first && e.round === 0 && e.notice_stops === "everyone" && !e.halted) e.halted = first.id;
  };
  const noticeAll = (): void => {
    for (const c of e.combatants) notice(c);
  };
  const point = (id: string): PointOfInterest =>
    e.points.find((p) => p.id === id) ?? fail(message("refusal.no_point_interest", { id }));
  /** The words for a move outside a fight: how far, and how many turns of Speed it takes. */
  const exploreNote = (c: EncounterCombatant, feet: number, speed: number): Message => {
    const turns = turnsFor(feet, speed);
    return message("explore.moves", { name: c.name, feet, turns, speed, seconds: turns * 6 });
  };
  /** Another creature whose space overlaps `c`'s at `to`. */
  const spaceTaken = (c: EncounterCombatant, to: GridPoint): EncounterCombatant | undefined =>
    spaceTakenBy(e, ctx, c, to);
  const feetBetween = (a: EncounterCombatant, b: EncounterCombatant): number | null =>
    feetApart(ctx, a, b);
  /**
   * The distance an action checks (reach, range): with `positions: required` and the map in use,
   * a creature off the map is refused instead of passing as unknown.
   */
  const checkedFeet = (a: EncounterCombatant, b: EncounterCombatant): number | null => {
    if (a.id === b.id) return 0;
    offMap(a, b);
    return feetBetween(a, b);
  };
  /** With `positions: required` and anyone on the map, a creature off it is refused. */
  const offMap = (...who: EncounterCombatant[]): void => {
    if (e.positions !== "required" || !e.combatants.some((x) => x.position)) return;
    for (const x of who) if (!x.position) refuse(message("refusal.off_map", { name: x.name }));
  };
  const enemiesNear = (c: EncounterCombatant): EncounterCombatant[] => enemiesWithin5(e, ctx, c);
  /**
   * What positions say about an attack: a melee attack within reach, a ranged one within long
   * range (Disadvantage beyond normal range, and with an enemy within 5 feet), whether it's
   * within 5 feet, and whether an ally of the attacker is next to the target (Sneak Attack).
   */
  const attackGeometry = (
    c: EncounterCombatant,
    t: EncounterCombatant,
    line: AttackLine,
    options: {
      thrown?: boolean;
      within_5ft?: boolean;
      ally_adjacent?: boolean;
      opportunity?: boolean;
    },
  ) => {
    const modes: ModeReason[] = [];
    if (options.thrown && !line.properties.includes("thrown")) {
      fail(message("refusal.cant_thrown", { attack: line.name }));
    }
    const ranged = line.kind === "ranged" || Boolean(options.thrown);
    const distance = checkedFeet(c, t);
    let within_5ft = options.within_5ft;
    let ally_adjacent = options.ally_adjacent;
    if (distance === null) {
      if (options.thrown) within_5ft ??= false;
      return { modes, within_5ft, ally_adjacent };
    }
    within_5ft ??= distance <= 5;
    if (!ranged) {
      // An Opportunity Attack happens just before the target leaves the reach.
      const reach = line.reach ?? 5;
      if (!options.opportunity && distance > reach) {
        refuse(
          message("refusal.feet_away_out_reach", {
            target: t.name,
            distance,
            attack: line.name,
            reach,
          }),
        );
      }
    } else {
      const range = line.range;
      if (range && distance > range.long) {
        refuse(
          message("refusal.feet_away_beyond_range", {
            target: t.name,
            distance,
            attack: line.name,
            long: range.long,
          }),
        );
      }
      if (range && distance > range.normal) {
        modes.push(
          modeReason(
            "disadvantage",
            message("reason.beyond_range", { name: t.name, feet: range.normal }),
          ),
        );
      }
      const near = enemiesNear(c)[0];
      if (near)
        modes.push(modeReason("disadvantage", message("reason.within_5ft", { name: near.name })));
    }
    ally_adjacent ??= e.combatants.some((x) => {
      if (x.id === c.id || x.id === t.id || x.defeated || !alliesOf(e, x.id, c)) return false;
      const d = feetBetween(x, t);
      return d !== null && d <= 5 && !conditionsOf(ctx, x).has("incapacitated");
    });
    return { modes, within_5ft, ally_adjacent };
  };
  /**
   * The positioned creatures in an area placed by `c` (rules/areas.ts), after checking that its
   * point is within `range` feet; a Cube "originating from" `c` (no range) must touch its space.
   */
  const areaTargets = (
    c: EncounterCombatant,
    area: SpellArea,
    placement: AreaPlacement,
    range: number | null,
    label: string,
  ): string[] => {
    const placed = placeArea(e, ctx, c, area, placement, range, label);
    areaCover.clear();
    for (const id of placed.total) {
      notes.push(message("cover.total_from_origin", { name: find(id).name, label }));
    }
    for (const [id, cover] of placed.cover) areaCover.set(id, cover);
    return placed.ids;
  };
  /** Cover worked out for the creatures of the last area placed, by id. */
  const areaCover = new Map<string, MapCover>();
  /**
   * `t`'s cover against `c`: the cover given, else (both positioned) worked out from the map,
   * from `c`'s space or from the last area's point of origin; noted when it changes the roll.
   */
  const coverFor = (
    c: EncounterCombatant,
    t: EncounterCombatant,
    given: Cover | undefined,
    { area = false, relevant = true }: { area?: boolean; relevant?: boolean } = {},
  ): Cover | undefined => {
    if (given) return given;
    let found: MapCover | undefined;
    if (area) found = areaCover.get(t.id);
    else if (c.position && t.position && c.id !== t.id) {
      const corners = spaceCorners({ position: c.position, size: spaceOf(ctx, c) });
      found = mapCover(e, ctx, corners, t, [c.id]);
    }
    if (!found || found.degree === "none") return undefined;
    const cover = found.degree;
    if (relevant && cover !== "total") {
      notes.push(
        message("cover.has", { name: t.name, cover, by: found.by ?? message("cover.obstacle") }),
      );
    }
    return cover;
  };
  /** Targets of a saving throw effect: from its area, or given (checked against its range). */
  const saveTargets = (
    c: EncounterCombatant,
    line: SaveActionLine,
    placement: AreaPlacement | undefined,
    given: readonly string[] | undefined,
  ): string[] => {
    if (placement) {
      if (!line.area) fail(message("refusal.no_area_give_targets", { attack: line.name }));
      if (given?.length) fail(message("refusal.give_targets_area_not"));
      const ids = areaTargets(c, line.area, placement, line.range ?? null, line.name);
      notes.push(areaNote(line.name, line.area, ids));
      return ids;
    }
    for (const id of given ?? []) {
      const d = checkedFeet(c, find(id));
      if (line.range && d !== null && d > line.range) {
        refuse(
          message("refusal.out_of_range_ft", {
            target: find(id).name,
            d,
            what: line.name,
            range: line.range,
          }),
        );
      }
    }
    return [...(given ?? [])];
  };
  /** "Fireball's Sphere covers Brakka and Lute." */
  const areaNote = (label: string, area: SpellArea, ids: readonly string[]): Message =>
    message("area.covers", {
      label,
      shape: area.shape,
      count: ids.length,
      names: ids.map((id) => find(id).name),
    });
  /** The creatures in a spell's area (its point within the spell's range), noted. */
  const spellArea = (
    c: EncounterCombatant,
    spell: SpellDef,
    placement: AreaPlacement,
  ): string[] => {
    const area =
      spell.mechanics?.area ?? fail(message("refusal.no_area_place", { spell: spell.name }));
    const ids = areaTargets(c, area, placement, spellRangeFeet(spell), spell.name);
    notes.push(areaNote(spell.name, area, ids));
    return ids;
  };
  /** A zone's point out of a positioned caster's spell range is refused. */
  const checkZonePoint = (c: EncounterCombatant, spell: SpellDef, point?: GridPoint) => {
    const reach = spellRangeFeet(spell);
    if (point && reach !== null) offMap(c);
    if (!point || !c.position || reach === null) return;
    const d = gridDistance(point, 1, c.position, spaceOf(ctx, c));
    if (d > reach)
      refuse(message("refusal.point_feet_away_out", { d, spell: spell.name, range: spell.range }));
  };
  /** A target out of a positioned caster's spell range is refused ("60 feet", "Touch"). */
  const checkSpellRange = (
    c: EncounterCombatant,
    spell: SpellDef,
    targets: EncounterCombatant[],
  ) => {
    const limit = spellTargetRange(spell);
    if (limit === null) return;
    for (const t of targets) {
      const d = checkedFeet(c, t);
      if (d !== null && d > limit) {
        refuse(
          message("refusal.feet_away_out_range", {
            target: t.name,
            d,
            spell: spell.name,
            range: spell.range,
          }),
        );
      }
    }
  };
  /** `t`'s feature that halves an attack's damage as its reaction (Uncanny Dodge), if usable. */
  const reactionThatHalves = (t: EncounterCombatant): string | null => {
    if (t.character === null || t.used.reaction) return null;
    if (conditionsOf(ctx, t).has("incapacitated")) return null;
    const ref = characterRef(ctx, t);
    const sheet = computePlaySheet(ref.build, ref.state, ctx.catalog);
    return sheet.actions.find((a) => a.halves_attack_damage)?.name ?? null;
  };
  /** `t`'s feature that reduces an attack's damage as its reaction (Deflect Attacks), if usable. */
  const reactionThatReduces = (t: EncounterCombatant) => {
    if (t.character === null || t.used.reaction) return null;
    if (conditionsOf(ctx, t).has("incapacitated")) return null;
    const ref = characterRef(ctx, t);
    const f = computePlaySheet(ref.build, ref.state, ctx.catalog).actions.find(
      (a) => a.reduces_attack_damage,
    );
    return f?.reduces_attack_damage ? { name: f.name, ...f.reduces_attack_damage } : null;
  };
  /** One attack by `c` on `t`, applied: riders once per turn, notes, damage. */
  const attackOn = (
    c: EncounterCombatant,
    t: EncounterCombatant,
    attackName: string,
    options: {
      mode?: "normal" | "advantage" | "disadvantage";
      two_handed?: boolean;
      riders?: readonly { rider: string; type?: string }[];
      ally_adjacent?: boolean;
      within_5ft?: boolean;
      light_extra?: boolean;
      cleave?: boolean;
      mastery?: boolean;
      thrown?: boolean;
      cover?: Cover;
      opportunity?: boolean;
      cunning?: readonly ("poison" | "trip" | "withdraw")[];
      brutal?: readonly ("forceful" | "hamstring" | "staggering" | "sundering")[];
    },
  ): AttackResult => {
    const attacker = encounterCombatant(e, c.id, ctx);
    const strikes = strikeOptions(c, attacker, attackName, options);
    const line = attacker.attacks.find((a) => a.name === attackName);
    // Positions: reach, range, close combat, within 5 feet and an ally next to the target.
    const spatial = line
      ? attackGeometry(c, t, line, options)
      : {
          modes: [] as ModeReason[],
          within_5ft: options.within_5ft,
          ally_adjacent: options.ally_adjacent,
        };
    const riders = options.riders ?? [];
    const onceIds = riders.flatMap((r) => {
      const rider = line?.riders.find((x) => x.id === r.rider || x.name === r.rider);
      return rider?.once_per_turn ? [rider.id] : [];
    });
    const again = onceIds.find((id) => c.riders_used.includes(id));
    if (again) refuse(message("refusal.already_used_turn", { name: c.name, again }));
    for (const r of riders) {
      const rider = line?.riders.find((x) => x.id === r.rider || x.name === r.rider);
      if (rider?.own_turn && current()?.id !== c.id) {
        fail(message("refusal.used_own_turns", { rider: rider.name, name: c.name }));
      }
    }
    const target = withCover(encounterCombatant(e, t.id, ctx), coverFor(c, t, options.cover));
    // Help: Advantage on the next attack roll by one of the helper's allies against the target.
    const help = e.helps.find(
      (h) => h.on === t.id && h.skill === null && h.by !== c.id && alliesOf(e, h.by, c),
    );
    const modes: ModeReason[] = help ? [modeReason("advantage", helpReason(help.by, t))] : [];
    modes.push(...spatial.modes);
    // Vex: Advantage on c's next attack roll against t; Sap: Disadvantage on c's next attack roll.
    const vex = e.masteries.find((m) => m.mastery === "vex" && m.by === c.id && m.on === t.id);
    const sap = e.masteries.find((m) => m.mastery === "sap" && m.on === c.id);
    if (vex) modes.push(modeReason("advantage", vexReason(c, t)));
    if (sap) modes.push(modeReason("disadvantage", sapReason(sap.by)));
    // Guiding Bolt: Advantage on the next attack roll against t, whoever makes it.
    const mark = e.marks.find((m) => m.on === t.id && m.kind === "advantage_against");
    if (mark) modes.push(modeReason("advantage", markReason(mark)));
    // Aura of Authority: Advantage on attack rolls.
    const authority = authorityOver(e, ctx, c);
    if (authority) {
      modes.push(modeReason("advantage", message("reason.aura_of_authority", { name: authority })));
    }
    // Hunter's Mark, Hex: extra damage when its caster hits the marked creature.
    const quarry = e.marks.filter(
      (m) => m.kind === "quarry" && m.by === c.id && m.on === t.id && m.damage,
    );
    // Sundering Blow: +5 to the next attack roll against it by another creature.
    const sundered = e.marks.find((m) => m.on === t.id && m.kind === "sundered" && m.by !== c.id);
    if (sundered) notes.push(message("brutal.sundered_bonus", { name: c.name, target: t.name }));
    let hit: AttackResult;
    try {
      // The attacker's conditions caused by this target (Grappled by it), from the effects.
      const against_source_of = e.effects
        .filter((x) => x.target === c.id && x.source === t.id)
        .map((x) => x.condition);
      hit = makeAttack(attacker, attackName, target, {
        rng,
        decide,
        mode: options.mode,
        two_handed: options.two_handed,
        riders,
        ally_adjacent: spatial.ally_adjacent,
        within_5ft: spatial.within_5ft,
        against_source_of,
        modes,
        light_extra: options.light_extra,
        cleave: options.cleave,
        forgo: strikes.forgo,
        extra_damage: [
          ...strikes.extra_damage,
          ...quarry.map((m) => m.damage as { dice: string; type: string }),
        ],
        forgo_advantage: strikes.forgo_advantage,
        bonus: sundered ? 5 : 0,
      });
    } catch (error) {
      if (error instanceof RangeError) fail(ruleReason(error));
      throw error;
    }
    c.extended = true; // an attack roll extends Rage
    unhide(c, message("why.attack_roll"));
    useInspiration(c, hit.inspiration);
    if (help) e.helps = e.helps.filter((h) => h !== help);
    e.masteries = e.masteries.filter((m) => m !== vex && m !== sap);
    e.marks = e.marks.filter((m) => m !== mark && m !== sundered);
    const rollMsg = message("attack.roll", {
      total: hit.total,
      ac: hit.target_ac,
      count: hit.reasons.length,
      reasons: [...hit.reason_messages],
    });
    if (!hit.hit) {
      notes.push(
        message("attack.miss", { name: c.name, target: t.name, attack: hit.attack, roll: rollMsg }),
      );
    } else {
      c.riders_used.push(...onceIds);
      c.hits.push(t.id);
      c.last_hit = {
        target: t.id,
        melee: line?.kind === "melee" && !options.thrown,
        critical: hit.critical_hit,
      };
      notes.push(
        message("attack.hit", {
          critical: hit.critical_hit,
          name: c.name,
          target: t.name,
          attack: hit.attack,
          roll: rollMsg,
          dealt: dealtMsg(hit.instances),
        }),
      );
      let instances = [...hit.instances];
      // Uncanny Dodge: the target's reaction once it knows it's hit.
      const dodge = reactionThatHalves(t);
      const hits = { name: c.name, target: t.name, attack: hit.attack, roll: rollMsg };
      if (
        dodge &&
        decide(
          decision(
            "uncanny_dodge",
            target,
            message("decision.halve", { ...hits, reaction: dodge }),
            true,
          ),
        )
      ) {
        t.used.reaction = true;
        instances = instances.map((d) => ({ ...d, amount: Math.floor(d.amount / 2) }));
        notes.push(message("reaction.halves", { name: t.name, reaction: dodge }));
      }
      // Deflect Attacks: the target's reaction takes 1d10 + modifiers off the attack's damage.
      const deflect = reactionThatReduces(t);
      if (
        deflect &&
        (!deflect.types.length || instances.some((d) => deflect.types.includes(d.type ?? "")))
      ) {
        const ask = message("decision.reduce", { ...hits, reaction: deflect.name });
        const view = encounterCombatant(e, t.id, ctx);
        if (decide(decision("deflect_attacks", view, ask, true))) {
          t.used.reaction = true;
          const reduce = [{ dice: deflect.dice, bonus: deflect.bonus, type: "none" }];
          let cut = rollDamage(reduce, { rng }).total;
          const total = instances.reduce((a, d) => a + d.amount, 0);
          notes.push(
            message("reaction.reduces", {
              name: t.name,
              reaction: deflect.name,
              amount: Math.min(cut, total),
            }),
          );
          instances = instances.map((d) => {
            const off = Math.min(d.amount, cut);
            cut -= off;
            return { ...d, amount: d.amount - off };
          });
        }
      }
      applyTo(t, [{ type: "damage", instances, critical: hit.critical_hit }]);
    }
    if (line?.mastery && options.mastery !== false) {
      applyMastery(c, t, attacker, line, hit, options.cleave ?? false);
    }
    if (hit.hit) applyStrikes(c, t, attacker, options);
    return hit;
  };
  /**
   * Cunning Strike and Brutal Strike on an attack: checked before it's rolled (the features, the
   * Sneak Attack dice to forgo, Reckless Attack), and what changes in the roll.
   */
  const strikeOptions = (
    c: EncounterCombatant,
    attacker: Combatant,
    attackName: string,
    options: {
      riders?: readonly { rider: string }[];
      cunning?: readonly string[];
      brutal?: readonly string[];
      opportunity?: boolean;
    },
  ) => {
    if (!options.cunning?.length && !options.brutal?.length) {
      return { forgo: [], extra_damage: [], forgo_advantage: false };
    }
    const ref = c.character !== null ? characterRef(ctx, c) : null;
    const character = ref
      ? { sheet: computePlaySheet(ref.build, ref.state, ctx.catalog), state: ref.state }
      : null;
    // "Brutal Strike": on your turn, not with an Opportunity Attack.
    const turn = options.opportunity || current()?.id !== c.id ? false : undefined;
    try {
      return strikeDice(attacker, attackName, options, character, { turn });
    } catch (error) {
      if (error instanceof RangeError) fail(ruleReason(error));
      throw error;
    }
  };
  /** The Cunning Strike and Brutal Strike effects of a hit (SRD "Cunning Strike", "Brutal Strike"). */
  const applyStrikes = (
    c: EncounterCombatant,
    t: EncounterCombatant,
    attacker: Combatant,
    options: { cunning?: readonly string[]; brutal?: readonly string[] },
  ): void => {
    if (outOfFight(ctx, t) || t.defeated) return;
    const until = { at: "start" as const, of: c.id, count: 1, skip_current: false };
    // "the DC equals 8 plus your Dexterity modifier and Proficiency Bonus"
    const dc = 8 + attacker.modifiers.dex + attacker.proficiency_bonus;
    for (const effect of options.cunning ?? []) {
      if (effect === "withdraw") {
        const half = Math.floor(speedOf(ctx, c, e) / 2);
        c.extra_movement += half;
        c.disengaged = true;
        notes.push(message("cunning.withdraw", { name: c.name, feet: half }));
        continue;
      }
      if (effect === "trip" && ["huge", "gargantuan"].includes(sizeOf(ctx, t) ?? "")) {
        notes.push(message("cunning.too_large", { name: t.name }));
        continue;
      }
      const ability = effect === "poison" ? "con" : "dex";
      const save = rollSavingThrow(encounterCombatant(e, t.id, ctx), ability, dc, { rng, decide });
      notes.push(
        message("cunning.save", {
          effect,
          name: t.name,
          success: save.success,
          save: saveText(save),
        }),
      );
      spendLegendaryResistance(t, save);
      if (save.success) continue;
      if (effect === "trip") applyTo(t, [{ type: "add_condition", condition: "prone" }]);
      else {
        applyTo(t, [{ type: "add_condition", condition: "poisoned" }]);
        // "for 1 minute. At the end of each of its turns, the Poisoned target repeats the save"
        addEffects(t, ["poisoned"], {
          source: c.id,
          label: "Cunning Strike",
          concentration: false,
          ends: { at: "start", of: c.id, count: 10, skip_current: false },
          repeat_save: { ability: "con", dc },
        });
      }
    }
    const mark = (kind: "hamstrung" | "staggered" | "sundered", text: Message) => {
      e.marks = e.marks.filter((m) => !(m.on === t.id && m.kind === kind));
      e.marks.push({
        kind,
        label: "Brutal Strike",
        by: c.id,
        on: t.id,
        ends: { ...until },
        damage: null,
      });
      notes.push(text);
    };
    for (const effect of options.brutal ?? []) {
      if (effect === "forceful") {
        notes.push(message("brutal.forceful", { target: t.name, name: c.name }));
      } else if (effect === "hamstring") {
        mark("hamstrung", message("brutal.hamstring", { target: t.name, name: c.name }));
      } else if (effect === "staggering") {
        mark("staggered", message("brutal.staggering", { target: t.name, name: c.name }));
      } else {
        mark("sundered", message("brutal.sundering", { target: t.name }));
      }
    }
  };
  /** The attack's weapon mastery property (SRD "Mastery Properties"), after the attack. */
  const applyMastery = (
    c: EncounterCombatant,
    t: EncounterCombatant,
    attacker: Combatant,
    line: AttackLine,
    hit: AttackResult,
    cleaving: boolean,
  ): void => {
    const mastery = line.mastery?.toLowerCase();
    const modifier = line.ability ? attacker.modifiers[line.ability] : 0;
    const dealt = (hit.outcome?.dealt ?? 0) > 0;
    const until = (at: "start" | "end") => ({
      at,
      of: c.id,
      count: 1,
      skip_current: at === "end" && current()?.id === c.id,
    });
    if (!hit.hit) {
      // Graze: damage equal to the ability modifier on a miss.
      if (mastery === "graze" && modifier > 0 && !outOfFight(ctx, t)) {
        notes.push(
          message("mastery.graze", { target: t.name, amount: modifier, type: line.damage_type }),
        );
        applyTo(t, [{ type: "damage", instances: [{ amount: modifier, type: line.damage_type }] }]);
      }
      return;
    }
    if (outOfFight(ctx, t) || t.defeated) return;
    if (mastery === "vex" && dealt) {
      e.masteries.push({ mastery: "vex", by: c.id, on: t.id, ends: until("end") });
      notes.push(message("mastery.vex", { name: c.name, target: t.name }));
    } else if (mastery === "sap") {
      e.masteries.push({ mastery: "sap", by: c.id, on: t.id, ends: until("start") });
      notes.push(message("mastery.sap", { target: t.name }));
    } else if (mastery === "slow" && dealt) {
      e.masteries.push({ mastery: "slow", by: c.id, on: t.id, ends: until("start") });
      notes.push(message("mastery.slow", { target: t.name, name: c.name }));
    } else if (mastery === "topple") {
      const dc = 8 + modifier + attacker.proficiency_bonus;
      const save = rollSavingThrow(encounterCombatant(e, t.id, ctx), "con", dc, { rng, decide });
      notes.push(
        message("mastery.topple", { target: t.name, success: save.success, save: saveText(save) }),
      );
      spendLegendaryResistance(t, save);
      if (!save.success) applyTo(t, [{ type: "add_condition", condition: "prone" }]);
    } else if (mastery === "push") {
      const size = encounterCombatant(e, t.id, ctx).size;
      if (!["huge", "gargantuan"].includes(size ?? "")) {
        notes.push(message("mastery.push", { name: c.name, target: t.name }));
      }
    } else if (mastery === "cleave" && line.kind === "melee" && !cleaving && !c.cleave_used) {
      c.cleave = { attack: line.name, target: t.id };
      notes.push(message("mastery.cleave", { name: c.name, target: t.name, attack: line.name }));
    }
  };
  /** A saving throw effect used by `user` against targets, applied. */
  const saveEffectOn = (
    c: EncounterCombatant,
    user: Combatant,
    name: string,
    targetIds: readonly string[],
    cover?: Readonly<Record<string, Cover>>,
    area = false,
  ): SaveActionResult => {
    const targets = targetIds.map(find);
    const line = user.save_actions.find((a) => a.name === name);
    const relevant = line?.ability === "dex";
    let r: SaveActionResult;
    try {
      const combatants = targets.map((t) =>
        withCover(
          encounterCombatant(e, t.id, ctx),
          coverFor(c, t, cover?.[t.id], { area, relevant }),
        ),
      );
      r = useSaveAction(user, name, combatants, { rng, decide });
    } catch (error) {
      if (error instanceof RangeError) fail(ruleReason(error));
      throw error;
    }
    c.extended = true; // forcing a saving throw extends Rage
    for (const hit of r.targets) {
      const t = targets[hit.target] as EncounterCombatant;
      spendLegendaryResistance(t, hit.save); // notes Bardic Inspiration first: it changed the roll
      notes.push(targetNote(t.name, hit));
      applyTo(t, hit.actions);
    }
    return r;
  };
  /**
   * A wall spell placed from `from` to `to` (SRD wall spells): within the spell's range and its
   * length. Between squares, a segment from corner to corner; otherwise the squares of the line
   * (and, for Wall of Fire, those within its reach on the chosen side), with the creatures in the
   * wall's squares as the targets of its first save.
   */
  const placeWall = (
    c: EncounterCombatant,
    spell: SpellDef,
    at: { from: GridPoint; to: GridPoint; side?: "left" | "right" },
  ): PlacedWall => {
    const spec = spell.mechanics?.wall ?? fail(message("refusal.isnt_wall", { spell: spell.name }));
    if (!c.position) fail(message("refusal.no_position_wall_needs", { name: c.name }));
    const me = { position: c.position, size: spaceOf(ctx, c) };
    const range = spellRangeFeet(spell);
    const steps = Math.max(Math.abs(at.to.x - at.from.x), Math.abs(at.to.y - at.from.y));
    if (spec.between) {
      if (steps * 5 > spec.length) {
        fail(
          message("refusal.wall_too_long", {
            spell: spell.name,
            max: spec.length,
            feet: steps * 5,
          }),
        );
      }
      for (const p of [at.from, at.to]) {
        const d = distanceToPoint(me, p);
        if (range !== null && d > range)
          refuse(message("refusal.point_feet_away_out_2", { d, spell: spell.name }));
      }
      return {
        squares: [],
        zone: [],
        segments: [{ from: { ...at.from }, to: { ...at.to } }],
        targets: [],
      };
    }
    const line = [at.from, ...straightPath(at.from, at.to)];
    if (line.length * 5 > spec.length) {
      fail(
        message("refusal.wall_too_long", {
          spell: spell.name,
          max: spec.length,
          feet: line.length * 5,
        }),
      );
    }
    for (const p of [at.from, at.to]) {
      const d = gridDistance(p, 1, me.position, me.size);
      if (range !== null && d > range)
        refuse(message("refusal.feet_away_out_range_2", { x: p.x, y: p.y, d, spell: spell.name }));
    }
    const keys = new Set(line.map(squareKey));
    const zone = [...line];
    if (spec.side) {
      if (!at.side) fail(message("refusal.choose_damaging_side_side", { spell: spell.name }));
      const dx = Math.sign(at.to.x - at.from.x);
      const dy = Math.sign(at.to.y - at.from.y);
      if (!dx && !dy) fail(message("refusal.one_square_wall_no", { spell: spell.name }));
      // Left of the direction from `from` to `to` (y grows downward).
      const [nx, ny] = at.side === "left" ? [dy, -dx] : [-dy, dx];
      for (const p of line) {
        for (let k = 1; k <= spec.side / 5; k++) {
          const q = { x: p.x + nx * k, y: p.y + ny * k };
          if (!keys.has(squareKey(q))) {
            keys.add(squareKey(q));
            zone.push(q);
          }
        }
      }
    }
    const own = new Set(line.map(squareKey));
    const targets = spell.mechanics?.save
      ? e.combatants
          .filter((x) => x.position && !outOfFight(ctx, x))
          .filter((x) => inArea(own, { position: x.position as GridPoint, size: spaceOf(ctx, x) }))
          .map((x) => x.id)
      : [];
    return {
      squares: line.map((p) => ({ x: p.x, y: p.y })),
      zone: zone.map((p) => ({ x: p.x, y: p.y })),
      segments: [],
      targets,
    };
  };
  /**
   * `c` casts a spell at targets (`castSpell`) and the results are applied; a Concentration
   * spell's conditions become effects for its duration. Economy and limits are the caller's.
   */
  const castBy = (
    c: EncounterCombatant,
    spell: SpellDef,
    targetIds: readonly string[],
    options: {
      slot_level?: number;
      pact?: boolean;
      mode?: RollMode;
      spellcasting?: string;
      cover?: Readonly<Record<string, Cover>>;
      /** The targets come from an area: its point was checked against the range instead. */
      area?: boolean;
      /** A follow-up saving throw's other creatures (Ice Knife), when positions aren't used. */
      nearby?: readonly string[];
      damage_type?: DamageType;
      /** A zone's point (its area's), and the creatures it doesn't affect. */
      point?: GridPoint;
      unaffected?: readonly string[];
      /** A readied spell, its slot spent when it was readied. */
      held?: boolean;
      /** A wall's placement (`placeWall`). */
      wall?: PlacedWall;
      /** A smite riding a Critical Hit: its dice are doubled. */
      critical?: boolean;
    },
  ): SpellCastResult => {
    const zone = spell.mechanics?.zone ?? null;
    if (options.unaffected?.length && !zone?.designate) {
      fail(message("refusal.doesnt_let_caster_designate", { spell: spell.name }));
    }
    if (zone && !zone.on_cast && targetIds.length && !options.area) {
      fail(message("refusal.creatures_dont_save_when", { spell: spell.name }));
    }
    const targets = targetIds.map(find);
    if (!options.area) checkSpellRange(c, spell, targets);
    // Positions: an enemy within 5 feet hinders ranged spell attacks; Prone targets within 5 ft.
    const near = enemiesNear(c)[0];
    const modes: ModeReason[] = near
      ? [modeReason("disadvantage", message("reason.within_5ft", { name: near.name }))]
      : [];
    const within_5ft = targets.map((t) => {
      const d = feetBetween(c, t);
      return d === null ? undefined : d <= 5;
    });
    const nearby = followUpNearby(spell, targets, options.nearby);
    const {
      cover,
      area: _area,
      nearby: _nearby,
      point: _point,
      unaffected: _unaffected,
      held,
      wall: placedWall,
      ...cast
    } = options;
    const relevant = !!spell.mechanics?.attack || spell.mechanics?.save?.ability === "dex";
    const views = targets.map((t) =>
      withCover(
        encounterCombatant(e, t.id, ctx),
        coverFor(c, t, cover?.[t.id], { area: options.area, relevant }),
      ),
    );
    const nearbyViews = nearby.map((t) =>
      withCover(encounterCombatant(e, t.id, ctx), cover?.[t.id]),
    );
    // Help, Vex, Sap and Guiding Bolt reach spell attack rolls too, each used by one roll.
    const used = { helps: [] as Help[], masteries: [] as MasteryMark[], marks: [] as SpellMark[] };
    const modesFor = (index: number): ModeReason[] => {
      const t = targets[index] as EncounterCombatant;
      const out: ModeReason[] = [];
      const help = e.helps.find(
        (h) =>
          h.on === t.id &&
          h.skill === null &&
          h.by !== c.id &&
          alliesOf(e, h.by, c) &&
          !used.helps.includes(h),
      );
      if (help) {
        used.helps.push(help);
        out.push(modeReason("advantage", helpReason(help.by, t)));
      }
      const fresh = (m: MasteryMark) => !used.masteries.includes(m);
      const vex = e.masteries.find(
        (m) => m.mastery === "vex" && m.by === c.id && m.on === t.id && fresh(m),
      );
      if (vex) {
        used.masteries.push(vex);
        out.push(modeReason("advantage", vexReason(c, t)));
      }
      const sap = e.masteries.find((m) => m.mastery === "sap" && m.on === c.id && fresh(m));
      if (sap) {
        used.masteries.push(sap);
        out.push(modeReason("disadvantage", sapReason(sap.by)));
      }
      const mark = e.marks.find(
        (m) => m.on === t.id && m.kind === "advantage_against" && !used.marks.includes(m),
      );
      if (mark) {
        used.marks.push(mark);
        out.push(modeReason("advantage", markReason(mark)));
      }
      return out;
    };
    let r: SpellCastResult;
    try {
      r = castSpell(encounterCombatant(e, c.id, ctx), spell, views, {
        ...cast,
        rng,
        decide,
        modes,
        modesFor,
        within_5ft,
        nearby: nearbyViews,
      });
    } catch (error) {
      if (error instanceof RangeError) fail(ruleReason(error));
      throw error;
    }
    e.helps = e.helps.filter((h) => !used.helps.includes(h));
    e.masteries = e.masteries.filter((m) => !used.masteries.includes(m));
    e.marks = e.marks.filter((m) => !used.marks.includes(m));
    c.extended = true;
    const upcast = r.slot_level !== null && r.slot_level > spell.level ? r.slot_level : 0;
    notes.push(
      message("spell.cast", { name: c.name, spell: spell.name, level: upcast }),
      ...r.messages,
    );
    // A held spell's slot was spent when it was readied.
    applyTo(
      c,
      r.caster_actions.filter(
        (a) => !held || (a.type !== "spend_slot" && a.type !== "spend_pact_slot"),
      ),
    );
    // "you make … or you cast a spell with a Verbal component": no longer hidden.
    if (/\bV\b/.test(spell.components)) unhide(c, message("why.cast_spell", { spell: spell.name }));
    for (const hit of r.targets) {
      const t = targets[hit.target] as EncounterCombatant;
      useInspiration(c, hit.attack?.inspiration);
      spendLegendaryResistance(t, hit.save);
      notes.push(targetNote(t.name, hit, views[hit.target]?.armor_class));
      applyTo(t, hit.actions);
      if (hit.on_hit.includes("advantage_against") && !outOfFight(ctx, t)) {
        e.marks = e.marks.filter((m) => !(m.on === t.id && m.label === spell.name));
        e.marks.push({
          kind: "advantage_against",
          label: spell.name,
          by: c.id,
          on: t.id,
          ends: until("end"),
          damage: null,
        });
        notes.push(message("mark.advantage_against", { label: spell.name, target: t.name }));
      }
    }
    // Divine Smite's extra die against a Fiend or an Undead (doubled on a Critical Hit).
    const versus = spell.mechanics?.bonus_vs;
    if (versus) {
      for (const hit of r.targets) {
        const t = targets[hit.target] as EncounterCombatant;
        const type = creatureTypeOf(ctx, t).toLowerCase();
        if (!versus.creature_types.some((x) => x.toLowerCase() === type) || outOfFight(ctx, t)) {
          continue;
        }
        const kind = spell.mechanics?.damage[0]?.type ?? "radiant";
        const more = rollDamage([{ dice: versus.dice, bonus: 0, type: kind }], {
          rng,
          critical: options.critical,
        }).total;
        notes.push(
          message("spell.bonus_vs", {
            spell: spell.name,
            amount: more,
            type: kind,
            creature_type: creatureTypeOf(ctx, t),
          }),
        );
        applyTo(t, [{ type: "damage", instances: [{ amount: more, type: kind }] }]);
      }
    }
    // Hunter's Mark, Hex: the target is marked while the caster concentrates.
    const marking = spell.mechanics?.mark;
    if (marking) {
      e.marks = e.marks.filter(
        (m) => !(m.kind === "quarry" && m.by === c.id && m.label === spell.name),
      );
      for (const hit of r.targets) {
        const t = targets[hit.target] as EncounterCombatant;
        e.marks.push({
          kind: "quarry",
          label: spell.name,
          by: c.id,
          on: t.id,
          ends: null,
          damage: { ...marking },
        });
        notes.push(
          message("spell.mark", {
            spell: spell.name,
            name: c.name,
            target: t.name,
            dice: marking.dice,
            type: marking.type,
          }),
        );
      }
    }
    if (r.follow_up) {
      const all = [...targets, ...nearby];
      notes.push(
        message("spell.follow_up", {
          spell: spell.name,
          ability: abilityMsg(r.follow_up.ability),
          dc: r.follow_up.dc,
          count: r.follow_up.targets.length,
        }),
      );
      for (const hit of r.follow_up.targets) {
        const t = all[hit.target] as EncounterCombatant;
        spendLegendaryResistance(t, hit.save);
        notes.push(targetNote(t.name, hit));
        applyTo(t, hit.actions);
      }
    }
    // A hold that an action's check ends (Black Tentacles, Web).
    const hold = spell.mechanics?.conditions.find((x) => x.escape)?.escape ?? null;
    const escapeDc = hold ? r.save_dc : null;
    // Conditions with a duration in the spell's text end at the start or end of the caster's
    // next turn; a Concentration spell's others last while it concentrates, up to its duration.
    const timed = new Map(
      (spell.mechanics?.conditions ?? []).flatMap((x) => (x.until ? [[x.condition, x.until]] : [])),
    );
    const rounds = durationRounds(spell);
    for (const hit of r.targets) {
      const t = targets[hit.target] as EncounterCombatant;
      for (const at of ["start", "end"] as const) {
        const conditions = hit.conditions.filter((x) => timed.get(x) === `${at}_of_your_next_turn`);
        if (conditions.length) {
          addEffects(t, conditions, {
            source: c.id,
            label: spell.name,
            concentration: false,
            ends: until(at),
          });
        }
      }
      const lasting = hit.conditions.filter((x) => !timed.has(x));
      // Conditions that end when the creature takes damage (Mass Suggestion).
      const fragile = new Set(
        (spell.mechanics?.conditions ?? []).filter((x) => x.ends_on_damage).map((x) => x.condition),
      );
      if (!spell.concentration && lasting.some((x) => fragile.has(x))) {
        addEffects(
          t,
          lasting.filter((x) => fragile.has(x)),
          {
            source: c.id,
            label: spell.name,
            concentration: false,
            ends: rounds ? { at: "start", of: c.id, count: rounds, skip_current: false } : null,
            ends_on: ["damage"],
          },
        );
      }
      if (spell.concentration && lasting.length) {
        addEffects(t, lasting, {
          source: c.id,
          label: spell.name,
          concentration: true,
          ends: rounds ? { at: "start", of: c.id, count: rounds, skip_current: false } : null,
          escape_dc: escapeDc,
          escape_skill: hold,
        });
      }
    }
    if ((zone && spell.mechanics?.area) || placedWall) {
      const m = spell.mechanics as NonNullable<SpellDef["mechanics"]>;
      const wallSpec = m.wall;
      const triggers = zone?.triggers ?? [];
      const id = `zone-${e.next_effect++}`;
      const followsCaster = m.area?.shape === "emanation" && zone?.anchor === "caster";
      const until = m.conditions.find((x) => x.until === "end_of_its_turn")
        ? "end_of_its_turn"
        : null;
      e.zones.push({
        id,
        spell: spell.id,
        label: spell.name,
        by: c.id,
        area: (m.area ?? { shape: "line", size: wallSpec?.length ?? 5, width: 5 }) as SpellArea,
        point: followsCaster ? null : (options.point ?? null),
        save: m.save && wallSpec?.later !== "damage" ? { ...m.save, dc: r.save_dc ?? 0 } : null,
        damage: r.damage_parts.map((d) => ({ ...d, type: wallSpec?.later_type ?? d.type })),
        conditions: m.conditions.filter((x) => x.on === "failed_save").map((x) => x.condition),
        escape_dc: escapeDc,
        escape_skill: hold,
        until,
        triggers: [...triggers],
        once_per_turn: zone?.once_per_turn ?? true,
        optional: zone?.optional ?? false,
        space: zone?.space ?? 1,
        ram: zone?.ram ?? false,
        difficult: (zone?.difficult ?? false) || (wallSpec?.difficult ?? false),
        squares: placedWall ? placedWall.zone : null,
        segments: placedWall ? placedWall.segments : [],
        wall_squares: placedWall ? placedWall.squares : [],
        cover: wallSpec?.cover ?? null,
        cost: wallSpec?.cost ?? 1,
        no_save: wallSpec?.later === "damage",
        speed_halved: zone?.speed_halved ?? false,
        on_fail: [...(zone?.on_fail ?? [])],
        unaffected: [...(options.unaffected ?? [])].map((x) => find(x).id),
        concentration: spell.concentration,
        ends: rounds ? { at: "start", of: c.id, count: rounds, skip_current: false } : null,
        // The save on casting counts as this turn's.
        saved: r.targets.map((x) => (targets[x.target] as EncounterCombatant).id),
      });
      const when = triggers
        .filter((t) => t !== "move")
        .map((t) => message(`zone.when.${t as "enter" | "start_turn" | "end_turn"}`));
      notes.push(
        message("zone.lasts", {
          spell: spell.name,
          id,
          count: when.length,
          damage: wallSpec?.later === "damage",
          when,
        }),
      );
      if (triggers.includes("move")) {
        notes.push(message("zone.lasts_move", { spell: spell.name, id }));
      }
    }
    return r;

    /** Until the start or end of `c`'s next turn. */
    function until(at: "start" | "end"): EffectEnd {
      return { at, of: c.id, count: 1, skip_current: at === "end" && current()?.id === c.id };
    }
  };
  /**
   * A follow-up saving throw's other creatures (Ice Knife): those given, else the positioned
   * creatures within its radius of the target.
   */
  const followUpNearby = (
    spell: SpellDef,
    targets: readonly EncounterCombatant[],
    ids: readonly string[] | undefined,
  ): EncounterCombatant[] => {
    const f = spell.mechanics?.follow_up;
    if (!f) {
      if (ids?.length) fail(message("refusal.no_saving_throw_creatures", { spell: spell.name }));
      return [];
    }
    if (ids) return ids.map(find);
    const target = targets[0];
    if (!target?.position) return [];
    return e.combatants.filter((x) => {
      if (targets.includes(x) || outOfFight(ctx, x) || !x.position) return false;
      const d = feetBetween(target, x);
      return d !== null && d <= f.radius;
    });
  };
  /** A monster action's daily uses ("(2/Day)"): refused when spent, else counted. */
  const spendDaily = (c: EncounterCombatant, key: string, perDay: number | null, what: string) => {
    if (perDay === null) return;
    const used = c.daily_used[key] ?? 0;
    if (used >= perDay) fail(message("refusal.used_today", { name: c.name, what, count: perDay }));
    c.daily_used[key] = used + 1;
  };
  /** After every action: Concentration effects whose source stopped concentrating end. */
  const sweep = (): void => {
    const present = (id: string) => e.combatants.some((c) => c.id === id);
    for (const c of e.combatants) {
      // Its Invisible condition from hiding was removed some other way: not hidden any more.
      if (c.hidden !== null && !e.effects.some((x) => x.target === c.id && x.label === "Hidden")) {
        c.hidden = null;
      }
      // "If your Concentration is broken, the spell dissipates without taking effect."
      const held = c.readied?.held && c.readied.action.type === "cast" ? c.readied.action : null;
      if (held?.type === "cast") {
        const name = lookup(ctx.catalog.spells, held.spell)?.name ?? held.spell;
        if (concentrationOf(c) !== name) {
          c.readied = null;
          notes.push(message("readied.dissipates", { name: c.name, spell: name }));
        }
      }
    }
    e.masteries = e.masteries.filter((m) => present(m.by) && present(m.on));
    // A spell's mark stays when its caster leaves: the light is on the target. A mark tied to
    // Concentration (Hunter's Mark) ends with it.
    e.marks = e.marks.filter((m) => {
      if (!present(m.on)) return false;
      if (m.kind !== "quarry") return true;
      const by = e.combatants.find((x) => x.id === m.by);
      return !!by && concentrationOf(by) === m.label;
    });
    for (const z of [...e.zones]) {
      const source = e.combatants.find((c) => c.id === z.by);
      if (z.concentration && !source) endZone(z, message("why.caster_left"));
      else if (z.concentration && source && concentrationOf(source) !== z.label) {
        endZone(z, message("why.concentration_ended"));
      }
    }
    for (const effect of [...e.effects]) {
      const target = e.combatants.find((c) => c.id === effect.target);
      const source = effect.source ? e.combatants.find((c) => c.id === effect.source) : null;
      if (!target) endEffect(effect, message("why.target_left"));
      else if (!conditionsOf(ctx, target).has(effect.condition)) {
        // The condition was removed some other way (remove_condition, a rest): forget it.
        e.effects = e.effects.filter((x) => x.id !== effect.id);
      } else if (effect.source && !source) endEffect(effect, message("why.source_left"));
      else if (
        effect.condition === "grappled" &&
        source &&
        conditionsOf(ctx, source).has("incapacitated")
      ) {
        // SRD "Grappling": the condition ends if the grappler has the Incapacitated condition.
        endEffect(effect, message("why.source_incapacitated", { name: source.name }));
      } else if (
        effect.ends_on.includes("source_incapacitated") &&
        source &&
        (conditionsOf(ctx, source).has("incapacitated") || outOfFight(ctx, source))
      ) {
        endEffect(effect, message("why.source_incapacitated", { name: source.name }));
      } else if (effect.concentration && source && concentrationOf(source) !== effect.label) {
        endEffect(effect, message("why.concentration_ended"));
      }
    }
  };
  /** Why an attack roll has Advantage from a spell's mark: `Guiding Bolt (Ilse's hit on Goblin)`. */
  const markReason = (mark: SpellMark): Message => {
    const by = e.combatants.find((x) => x.id === mark.by)?.name ?? mark.by;
    return message("reason.mark", { label: mark.label, name: by, target: find(mark.on).name });
  };
  const helpReason = (by: string, t: EncounterCombatant): Message =>
    message("reason.help_against", { name: find(by).name, target: t.name });
  const vexReason = (c: EncounterCombatant, t: EncounterCombatant): Message =>
    message("reason.vex", { name: c.name, target: t.name });
  const sapReason = (by: string): Message => message("reason.sap", { name: find(by).name });
  const find = (id: string) =>
    e.combatants.find((c) => c.id === id) ??
    fail(message("refusal.no_combatant_encounter", { id }));
  const current = () => currentCombatant(e);
  const onTurn = (c: EncounterCombatant, what: string) => {
    if (e.round === 0) fail(message("refusal.fight_hasnt_started"));
    if (releasing?.id === c.id) return; // a readied action, with the reaction
    if (current()?.id !== c.id)
      refuse(message("refusal.isnt_turn_reaction", { name: c.name, what }));
  };
  const canAct = (c: EncounterCombatant) => {
    if (c.defeated) fail(message("refusal.defeated", { name: c.name }));
    if (conditionsOf(ctx, c).has("incapacitated"))
      refuse(message("refusal.incapacitated", { name: c.name }));
  };
  /** One attack's place in the economy: the Attack action (and its extra attacks) or a reaction. */
  const spendAttack = (c: EncounterCombatant, reaction: boolean | undefined): void => {
    if (releasing?.id === c.id) return; // the reaction, spent at the end
    if (reaction) {
      if (e.round === 0) fail(message("refusal.fight_hasnt_started"));
      if (c.used.reaction) refuse(message("refusal.already_used_reaction", { name: c.name }));
      c.used.reaction = true;
      return;
    }
    onTurn(c, "attack");
    if (c.attacks_left > 0) c.attacks_left -= 1;
    else if (c.used.action) refuse(message("refusal.no_attacks_left_turn", { name: c.name }));
    else {
      // The Attack action: Extra Attack or Multiattack give more attacks with it.
      c.used.action = true;
      c.attacks_left = encounterCombatant(e, c.id, ctx).attacks_per_action - 1;
    }
  };
  /** An action on its turn (or a Bonus Action, when a feature allows it: Cunning Action). */
  const takeAction = (c: EncounterCombatant, name: string, bonus?: boolean): void => {
    onTurn(c, name);
    canAct(c);
    if (releasing?.id === c.id) return; // the reaction, spent at the end
    const what = bonus ? "bonus_action" : "action";
    if (c.used[what]) refuse(message("refusal.economy_used_turn", { name: c.name, what }));
    c.used[what] = true;
    if (bonus) c.extended = true; // a Bonus Action extends Rage
  };
  /** It stops being hidden (SRD "Hide"): its Invisible condition from hiding ends. */
  const unhide = (c: EncounterCombatant, why: Message): void => {
    if (c.hidden === null) return;
    c.hidden = null;
    const effect = e.effects.find((x) => x.target === c.id && x.label === "Hidden");
    if (effect) endEffect(effect, why);
    else notes.push(message("hide.ends", { name: c.name, why }));
  };
  /** An ability check, noted: `check`, and the actions that are checks (Search, Study…). */
  const checkRoll = (
    c: EncounterCombatant,
    what: { skill: Skill } | { ability: Ability },
    dc: number | null,
    mode?: RollMode,
  ): CheckResult => {
    const skill = "skill" in what ? what.skill : null;
    const check = rollAbilityCheck(encounterCombatant(e, c.id, ctx), what, dc, {
      rng,
      decide,
      mode,
      modes: helpOnCheck(c, skill),
    });
    result = check;
    useInspiration(c, check.inspiration);
    notes.push(
      message("check.result", {
        name: c.name,
        label: check.skill ? message(`skill.${check.skill as Skill}`) : abilityMsg(check.ability),
        total: check.total,
        dc: check.dc ?? "none",
        count: check.reasons.length,
        reasons: [...check.reason_messages],
        outcome: check.success === null ? "none" : check.success,
      }),
    );
    return check;
  };
  /** Help on `c`'s next check with `skill`, used up by it. */
  const helpOnCheck = (c: EncounterCombatant, skill: string | null): ModeReason[] => {
    const help = skill ? e.helps.find((h) => h.on === c.id && h.skill === skill) : undefined;
    if (!help) return [];
    e.helps = e.helps.filter((h) => h !== help);
    return [modeReason("advantage", message("reason.help", { name: find(help.by).name }))];
  };

  switch (action.type) {
    case "add_monster": {
      const def =
        lookup(ctx.catalog.monsters, action.monster) ??
        fail(message("refusal.unknown_monster", { monster: action.monster }));
      const id = action.id ?? freeId(e, def.id);
      if (e.combatants.some((c) => c.id === id)) fail(message("refusal.already_encounter", { id }));
      let hp = action.hp ?? def.hit_points;
      if (action.roll_hp && action.hp === undefined && def.hit_dice) {
        hp = Math.max(1, roll(def.hit_dice, rng).total);
      }
      const numbered = id === def.id ? def.name : `${def.name} ${id.slice(def.id.length + 1)}`;
      e.combatants.push(
        combatant({
          id,
          name: action.name ?? numbered,
          monster: def.id,
          side: action.side,
          hp,
          in_lair: action.in_lair ?? false,
          auto_legendary_resistance: action.auto_legendary_resistance ?? true,
          decisions: action.decisions ?? null,
        }),
      );
      notes.push(message("combatant.joins_hp", { name: action.name ?? numbered, hp }));
      break;
    }
    case "add_character": {
      const ref =
        ctx.characters?.[action.character] ??
        fail(message("refusal.no_character_given", { character: action.character }));
      const id = action.id ?? freeId(e, slugify(ref.build.name || action.character));
      if (e.combatants.some((c) => c.id === id)) fail(message("refusal.already_encounter", { id }));
      if (e.combatants.some((c) => c.character === action.character)) {
        fail(message("refusal.already_encounter_2", { character: action.character }));
      }
      const name = action.name ?? (ref.build.name || action.character);
      e.combatants.push(
        combatant({
          id,
          name,
          character: action.character,
          side: action.side ?? "party",
          decisions: action.decisions ?? null,
        }),
      );
      notes.push(message("combatant.joins", { name }));
      break;
    }
    case "decide":
      return fail(message("refusal.there_no_decision_make"));
    case "set_decisions": {
      if (action.id !== undefined) find(action.id).decisions = action.mode;
      else e.decisions = action.mode ?? fail(message("refusal.encounter_mode_ask_auto"));
      break;
    }
    case "remove": {
      const c = find(action.id);
      const index = e.order.indexOf(c.id);
      e.combatants = e.combatants.filter((x) => x.id !== c.id);
      if (index >= 0) {
        e.order.splice(index, 1);
        if (index < e.turn) e.turn -= 1;
        if (e.turn >= e.order.length) e.turn = 0;
      }
      notes.push(message("combatant.leaves", { name: c.name }));
      break;
    }
    case "roll_initiative": {
      const ids = action.ids ?? e.combatants.filter((c) => c.initiative === null).map((c) => c.id);
      const surprised = new Set(action.surprised ?? []);
      const groupRolls = new Map<string, number>();
      for (const id of ids) {
        const c = find(id);
        const bonus = initiativeBonus(ctx, c);
        const key = action.group && c.monster ? c.monster : null;
        let d20 = key !== null ? groupRolls.get(key) : undefined;
        if (d20 === undefined) {
          // Surprised: Disadvantage; conditions too (Invisible: Advantage, Incapacitated:
          // Disadvantage); features (Feral Instinct: Advantage).
          const view = encounterCombatant(e, c.id, ctx);
          const reasons: ModeReason[] = view.condition_rolls.initiative.map((x) =>
            modeReason(x.mode, message("reason.is", { name: c.name, condition: x.condition })),
          );
          if (view.advantages.includes("initiative")) {
            reasons.push(modeReason("advantage", message("reason.features", { name: c.name })));
          }
          if (surprised.has(c.id)) {
            reasons.push(modeReason("disadvantage", message("reason.surprised")));
          }
          d20 = rollD20({ mode: resolveMode("normal", reasons).mode, rng }).d20;
          if (key !== null) groupRolls.set(key, d20);
        }
        c.initiative = d20 + bonus;
        notes.push(
          message("initiative.rolled", {
            name: c.name,
            total: c.initiative,
            d20,
            bonus: signedText(bonus),
          }),
        );
      }
      if (e.round > 0) reorder(e, ctx);
      break;
    }
    case "set_initiative": {
      find(action.id).initiative = action.value;
      if (e.round > 0) reorder(e, ctx);
      break;
    }
    case "set_order": {
      const everyone = e.combatants.map((c) => c.id);
      const same =
        action.ids.length === everyone.length && everyone.every((id) => action.ids.includes(id));
      if (!same) fail(message("refusal.set_order_needs_every_combatant"));
      const now = current()?.id;
      const byId = new Map(e.combatants.map((c) => [c.id, c]));
      // Only ties can be reordered: the Initiative counts must still go down.
      const counts = action.ids.map((id) => byId.get(id)?.initiative ?? null);
      for (let i = 1; i < counts.length; i++) {
        const [a, b] = [counts[i - 1], counts[i]];
        if (a != null && b != null && b > a)
          fail(message("refusal.set_order_reorder_tied_initiatives"));
      }
      e.order = [...action.ids];
      if (now) e.turn = e.order.indexOf(now);
      break;
    }
    case "start": {
      if (e.round > 0) fail(message("refusal.fight_already_started"));
      if (!e.combatants.length) fail(message("refusal.no_combatants"));
      const missing = e.combatants.filter((c) => c.initiative === null).map((c) => c.name);
      if (missing.length) fail(message("refusal.roll_initiative_first", { names: missing }));
      e.halted = null; // a fight doesn't wait on a noticed point
      e.round = 1;
      e.order = [];
      reorder(e, ctx);
      for (const c of e.combatants) resetTurn(c);
      e.turn = 0;
      const first = skipToActive(e, ctx, notes, false);
      notes.push(message("turn.starts", { round: 1, name: first.name }));
      startTurn(first);
      break;
    }
    case "next_turn": {
      if (e.round === 0) fail(message("refusal.fight_hasnt_started"));
      const ending = current();
      if (ending) endTurn(ending);
      const next = skipToActive(e, ctx, notes, true);
      notes.push(message("turn.starts", { round: e.round, name: next.name }));
      startTurn(next);
      break;
    }
    case "end": {
      if (e.round === 0) fail(message("refusal.fight_hasnt_started"));
      e.round = 0;
      e.turn = 0;
      e.order = [];
      for (const c of e.combatants) resetTurn(c);
      notes.push(message("fight.ends"));
      break;
    }
    case "use": {
      const c = find(action.id);
      if (action.what === "reaction") {
        if (e.round === 0) fail(message("refusal.fight_hasnt_started"));
      } else onTurn(c, "act");
      canAct(c);
      if (c.used[action.what]) {
        fail(
          action.what === "reaction"
            ? message("refusal.reaction_used", { name: c.name })
            : message("refusal.economy_used_turn", { name: c.name, what: action.what }),
        );
      }
      c.used[action.what] = true;
      // A Bonus Action extends Rage.
      if (action.what === "bonus_action") c.extended = true;
      break;
    }
    case "move": {
      const c = find(action.id);
      if (e.round === 0) {
        // Exploring: no turns and no limit; the engine says how many turns of Speed it takes.
        if (c.defeated) fail(message("refusal.defeated", { name: c.name }));
        if (e.halted) {
          const by = e.combatants.find((x) => point(e.halted as string).noticed_by.includes(x.id));
          fail(message("refusal.everyone_waits", { name: by?.name ?? message("word.someone") }));
        }
        const speed = speedOf(ctx, c, e);
        if (speed === 0) refuse(message("refusal.cant_move_speed", { name: c.name }));
        if (!action.to && !action.path) {
          notes.push(
            exploreNote(c, action.feet ?? fail(message("refusal.give_feet_moved_square")), speed),
          );
          break;
        }
        const from = c.position ?? fail(message("refusal.no_position_place", { name: c.name }));
        const planned = planMove(e, ctx, c, action, { left: explorationBudget(from, action) });
        let walked = 0;
        for (const [i, square] of planned.path.entries()) {
          const last = i === planned.path.length - 1;
          if (last) occupy(c, square);
          else c.position = { ...square };
          walked += planned.steps[i] ?? 5;
          const found = notice(c);
          // Noticing stops it here (when the square is free); `halt` holds everyone else.
          if (found.length && !last && !spaceTaken(c, square)) {
            notes.push(message("move.stops", { name: c.name, x: square.x, y: square.y }));
            break;
          }
        }
        notes.push(exploreNote(c, walked, speed));
        break;
      }
      onTurn(c, "move");
      if (c.defeated) fail(message("refusal.defeated", { name: c.name }));
      const from = c.position;
      if ((action.to || action.path) && !from)
        fail(message("refusal.no_position_place", { name: c.name }));
      if (action.to && action.path) fail(message("refusal.give_square_move_path"));
      // A readied move: up to its Speed, apart from its own turn's movement.
      const released = releasing?.id === c.id;
      const budget = released ? speedOf(ctx, c, e) : speedOf(ctx, c, e) + c.extra_movement;
      const spent = released ? 0 : c.moved;
      const left = Math.max(0, budget - spent);
      const planned =
        from && (action.to || action.path)
          ? planMove(e, ctx, c, action, released ? { left } : {})
          : null;
      const path = planned?.path ?? null;
      const steps = planned?.steps ?? [];
      const feet =
        action.feet ??
        (path ? steps.reduce((a, b) => a + b, 0) : fail(message("refusal.give_feet_moved_square")));
      if (spent + feet > budget) {
        refuse(message("refusal.move_more_feet_turn", { name: c.name, left }));
      }
      if (!path) {
        if (!released) c.moved += feet;
        break;
      }
      // Square by square: zones entered on the way, and damage for moving in some (Spike Growth);
      // leaving an enemy's reach, at the step it happens.
      const reachOf = new Map(
        e.combatants
          .filter((x) => x.id !== c.id && !x.defeated && !alliesOf(e, x.id, c) && x.position)
          .map((x) => [x, meleeReach(ctx, e, x)] as const),
      );
      const inReach = (x: EncounterCombatant, reach: number | null) => {
        const d = feetBetween(c, x);
        return reach !== null && d !== null && d <= reach;
      };
      const wasIn = new Map([...reachOf].map(([x, reach]) => [x, inReach(x, reach)]));
      const leftReach: EncounterCombatant[] = [];
      let zonesBefore = zoneOccupants();
      const zoneSteps = new Map<string, number>();
      let walked = 0;
      for (const [i, square] of path.entries()) {
        if (i === path.length - 1) occupy(c, square);
        else c.position = { ...square };
        walked += steps[i] ?? 5;
        for (const [x, reach] of reachOf) {
          const now = inReach(x, reach);
          if (wasIn.get(x) && !now && !leftReach.includes(x)) leftReach.push(x);
          wasIn.set(x, now);
        }
        for (const z of e.zones) {
          if (z.triggers.includes("move") && inZoneNow(z, zoneSquares(z), c)) {
            zoneSteps.set(z.id, (zoneSteps.get(z.id) ?? 0) + 1);
          }
        }
        zoneEntries(zonesBefore);
        zonesBefore = zoneOccupants();
        // Held on the way (Web) or out of the fight: it stops there.
        if (i < path.length - 1 && (outOfFight(ctx, c) || speedOf(ctx, c, e) === 0)) {
          notes.push(message("move.stops", { name: c.name, x: square.x, y: square.y }));
          break;
        }
      }
      if (!released) c.moved += walked;
      zoneMoveDamage(c, zoneSteps);
      // Enemies whose reach it left can make an Opportunity Attack (not after Disengage).
      for (const x of reachOf.keys()) {
        if (leftReach.includes(x) && !c.disengaged && !x.used.reaction) {
          notes.push(message("move.leaves_reach", { name: c.name, enemy: x.name }));
        }
      }
      notice(c);
      break;
    }
    case "set_terrain": {
      const keys = new Set(action.squares.map(squareKey));
      const others = (list: readonly GridPoint[]) => list.filter((p) => !keys.has(squareKey(p)));
      e.map.difficult = others(e.map.difficult);
      e.map.blocked = others(e.map.blocked);
      if (action.kind !== "clear") {
        e.map[action.kind].push(...action.squares.map((p) => ({ x: p.x, y: p.y })));
      }
      notes.push(message("map.terrain", { count: action.squares.length, kind: action.kind }));
      break;
    }
    case "add_wall":
    case "remove_wall": {
      const { from, to } = action;
      if (from.x === to.x && from.y === to.y) fail(message("refusal.wall_goes_one_corner"));
      const same = (w: { from: GridPoint; to: GridPoint }) =>
        (squareKey(w.from) === squareKey(from) && squareKey(w.to) === squareKey(to)) ||
        (squareKey(w.from) === squareKey(to) && squareKey(w.to) === squareKey(from));
      if (action.type === "add_wall") {
        if (e.map.walls.some(same)) fail(message("refusal.wall_already_there"));
        e.map.walls.push({ from: { ...from }, to: { ...to } });
        notes.push(message("map.wall_added", { x1: from.x, y1: from.y, x2: to.x, y2: to.y }));
      } else {
        if (!e.map.walls.some(same))
          fail(message("refusal.no_wall", { x: from.x, y: from.y, x2: to.x, y2: to.y }));
        e.map.walls = e.map.walls.filter((w) => !same(w));
        notes.push(message("map.wall_removed", { x1: from.x, y1: from.y, x2: to.x, y2: to.y }));
      }
      break;
    }
    case "place": {
      const c = find(action.id);
      occupy(c, { x: action.x, y: action.y });
      notice(c);
      break;
    }
    case "add_point": {
      const p: PointOfInterest = {
        id: `poi${e.next_point++}`,
        at: { x: action.at.x, y: action.at.y },
        title: action.title,
        kind: action.kind ?? "detail",
        text: action.text ?? "",
        notes: action.notes ?? "",
        revealed: action.revealed ?? false,
        dc: action.dc ?? null,
        within: action.within ?? 30,
        noticed_by: [],
      };
      e.points.push(p);
      // A hidden point's title stays the GM's: the log is everyone's.
      notes.push(
        p.revealed ? message("poi.placed", { title: p.title }) : message("poi.placed_hidden"),
      );
      noticeAll();
      break;
    }
    case "update_point": {
      const p = point(action.id);
      const { type: _, id: __, ...changes } = action;
      const wasRevealed = p.revealed;
      Object.assign(p, structuredClone(changes));
      if (p.revealed && !wasRevealed) {
        notes.push(message("poi.revealed", { title: p.title }));
        if (e.halted === p.id) e.halted = null;
      } else if (!p.revealed && wasRevealed) {
        p.noticed_by = [];
        notes.push(message("poi.hidden"));
      }
      noticeAll();
      break;
    }
    case "remove_point": {
      point(action.id);
      e.points = e.points.filter((p) => p.id !== action.id);
      if (e.halted === action.id) e.halted = null;
      notes.push(message("poi.removed"));
      break;
    }
    case "set_exploration": {
      if (action.pace) {
        e.pace = action.pace;
        notes.push(message("explore.pace", { pace: action.pace }));
      }
      if (action.notice_stops) {
        e.notice_stops = action.notice_stops;
        if (action.notice_stops === "noticer") e.halted = null;
        notes.push(message("explore.notice_stops", { who: action.notice_stops }));
      }
      noticeAll();
      break;
    }
    case "set_positions": {
      e.positions = action.mode;
      notes.push(message("positions.set", { mode: action.mode }));
      break;
    }
    case "resume": {
      if (!e.halted) fail(message("refusal.nobody_waiting"));
      e.halted = null;
      notes.push(message("explore.resume"));
      break;
    }
    case "dash": {
      const c = find(action.id);
      takeAction(c, "Dash", action.bonus_action);
      c.extra_movement += speedOf(ctx, c, e);
      notes.push(
        message("action.dash", {
          name: c.name,
          feet: speedOf(ctx, c, e) + c.extra_movement - c.moved,
        }),
      );
      break;
    }
    case "disengage": {
      const c = find(action.id);
      takeAction(c, "Disengage", action.bonus_action);
      c.disengaged = true;
      notes.push(message("action.disengage", { name: c.name }));
      break;
    }
    case "dodge": {
      const c = find(action.id);
      takeAction(c, "Dodge", action.bonus_action);
      c.dodging = true;
      notes.push(message("action.dodge", { name: c.name }));
      break;
    }
    case "help": {
      const c = find(action.id);
      const t = find(action.target);
      if (t.id === c.id) fail(message("refusal.cant_help_itself", { name: c.name }));
      if (action.skill) {
        if (!alliesOf(e, c.id, t))
          fail(message("refusal.isnt_ally", { target: t.name, name: c.name }));
        if (!proficientIn(ctx, c, action.skill)) {
          fail(
            message("refusal.isnt_proficient_help_assists", { name: c.name, skill: action.skill }),
          );
        }
      } else {
        if (c.side && c.side === t.side)
          fail(message("refusal.side", { target: t.name, name: c.name }));
        // "You momentarily distract an enemy within 5 feet of you."
        const d = checkedFeet(c, t);
        if (d !== null && d > 5)
          refuse(message("refusal.feet_away_help_distracts", { target: t.name, d }));
      }
      takeAction(c, "Help");
      e.helps.push({ by: c.id, on: t.id, skill: action.skill ?? null });
      notes.push(
        action.skill
          ? message("action.help_check", {
              name: c.name,
              target: t.name,
              skill: message(`skill.${action.skill}`),
            })
          : message("action.help_attack", { name: c.name, target: t.name }),
      );
      break;
    }
    case "unarmed": {
      const c = find(action.id);
      canAct(c);
      const t = find(action.target);
      if (action.option === "shove" && !action.shove)
        fail(message("refusal.shove_pushes_knocks_prone"));
      const user = encounterCombatant(e, c.id, ctx);
      const target = encounterCombatant(e, t.id, ctx);
      // "possible only if the target is no more than one size larger than you"
      const sizes = ["tiny", "small", "medium", "large", "huge", "gargantuan"];
      const [mine, theirs] = [sizes.indexOf(user.size ?? ""), sizes.indexOf(target.size ?? "")];
      if (mine >= 0 && theirs > mine + 1) {
        fail(message("refusal.too_large", { target: t.name, name: c.name, option: action.option }));
      }
      const d = checkedFeet(c, t);
      if (d !== null && d > 5)
        refuse(message("refusal.feet_away_unarmed_strike", { target: t.name, d }));
      spendAttack(c, action.reaction);
      c.extended = true; // forcing a saving throw extends Rage
      const dc = 8 + user.modifiers.str + user.proficiency_bonus;
      // The target chooses Strength or Dexterity: by default, its better bonus.
      const ability =
        action.save ?? (target.saving_throws.dex > target.saving_throws.str ? "dex" : "str");
      const save = rollSavingThrow(target, ability, dc, { rng, decide });
      result = save;
      notes.push(
        message("unarmed.save", {
          name: c.name,
          option: action.option,
          target: t.name,
          success: save.success,
          ability: abilityMsg(ability),
          save: saveText(save),
        }),
      );
      spendLegendaryResistance(t, save);
      if (save.success) break;
      if (action.option === "grapple") {
        applyTo(t, [{ type: "add_condition", condition: "grappled" }]);
        addEffects(t, ["grappled"], {
          source: c.id,
          label: "Grapple",
          concentration: false,
          ends: null,
          escape_dc: dc,
        });
        if (conditionsOf(ctx, t).has("grappled")) {
          notes.push(message("unarmed.grappled", { target: t.name, name: c.name, dc }));
        }
      } else if (action.shove === "prone") {
        applyTo(t, [{ type: "add_condition", condition: "prone" }]);
      } else notes.push(message("unarmed.pushed", { target: t.name, name: c.name }));
      break;
    }
    case "escape": {
      const c = find(action.id);
      const holds = e.effects.filter((x) => x.target === c.id && x.escape_dc !== null);
      const hold = action.effect
        ? (holds.find((x) => x.id === action.effect) ??
          fail(message("refusal.isnt_grapple_hold", { effect: action.effect, name: c.name })))
        : holds.length === 1
          ? (holds[0] as EncounterEffect)
          : holds.length
            ? fail(message("refusal.choose_escape", { ids: holds.map((x) => x.id) }))
            : fail(message("refusal.no_grapple_hold_escape", { name: c.name }));
      if (action.skill && hold.escape_skill && action.skill !== hold.escape_skill) {
        fail(
          message("refusal.escape_skill", {
            label: hold.label,
            skill: message(`skill.${hold.escape_skill}`),
          }),
        );
      }
      takeAction(c, "escape");
      const me = encounterCombatant(e, c.id, ctx);
      const bonus = (skill: "athletics" | "acrobatics") =>
        me.skills[skill] ?? me.ability_checks[skill === "athletics" ? "str" : "dex"];
      const skill =
        hold.escape_skill ??
        action.skill ??
        (bonus("acrobatics") > bonus("athletics") ? "acrobatics" : "athletics");
      const check = rollAbilityCheck(me, { skill }, hold.escape_dc, {
        rng,
        decide,
        modes: helpOnCheck(c, skill),
      });
      result = check;
      useInspiration(c, check.inspiration);
      const condition = lookup(ctx.catalog.conditions, hold.condition)?.name ?? hold.condition;
      notes.push(
        message("escape.result", {
          name: c.name,
          skill: message(`skill.${skill}`),
          total: check.total,
          dc: hold.escape_dc ?? "none",
          count: check.reasons.length,
          reasons: [...check.reason_messages],
          success: check.success === true,
          condition,
        }),
      );
      if (check.success) endEffect(hold, message("why.escaped"));
      break;
    }
    case "stand": {
      const c = find(action.id);
      onTurn(c, "stand up");
      if (c.defeated) fail(message("refusal.defeated", { name: c.name }));
      const own = c.monster !== null ? c.conditions : characterRef(ctx, c).state.conditions;
      if (!own.includes("prone")) fail(message("refusal.isnt_prone", { name: c.name }));
      const speed = speedOf(ctx, c, e);
      if (speed === 0) refuse(message("refusal.cant_right_itself_speed", { name: c.name }));
      // "spend an amount of movement equal to half your Speed (round down)"
      const cost = Math.floor(speed / 2);
      const budget = speed + c.extra_movement;
      if (c.moved + cost > budget)
        refuse(message("refusal.needs_feet_movement_stand", { name: c.name, cost }));
      c.moved += cost;
      applyTo(c, [{ type: "remove_condition", condition: "prone" }]);
      notes.push(message("action.stand_up", { name: c.name, feet: cost }));
      break;
    }
    case "hide": {
      const c = find(action.id);
      if (c.hidden !== null) fail(message("refusal.already_hidden", { name: c.name }));
      // "behind Three-Quarters Cover or Total Cover … out of any enemy's line of sight"
      if (c.position && !action.obscured) {
        for (const x of e.combatants) {
          if (x.id === c.id || x.defeated || outOfFight(ctx, x) || alliesOf(e, x.id, c)) continue;
          if (!x.position || conditionsOf(ctx, x).has("incapacitated")) continue;
          const corners = spaceCorners({ position: x.position, size: spaceOf(ctx, x) });
          const cover = mapCover(e, ctx, corners, c, [x.id]).degree;
          if (cover !== "three_quarters" && cover !== "total") {
            fail(message("refusal.see_hiding_needs_three", { other: x.name, name: c.name }));
          }
        }
      }
      takeAction(c, "Hide", action.bonus_action);
      const check = checkRoll(c, { skill: "stealth" }, 15);
      if (!check.success) break;
      applyTo(c, [{ type: "add_condition", condition: "invisible" }]);
      addEffects(c, ["invisible"], {
        source: c.id,
        label: "Hidden",
        concentration: false,
        ends: null,
      });
      c.hidden = check.total;
      notes.push(message("hide.hidden", { name: c.name, dc: check.total }));
      break;
    }
    case "reveal": {
      const c = find(action.id);
      if (c.hidden === null) fail(message("refusal.isnt_hidden", { name: c.name }));
      unhide(c, message("why.revealed"));
      break;
    }
    case "search": {
      const c = find(action.id);
      if (e.round > 0) takeAction(c, "Search");
      else canAct(c);
      const skill = action.skill ?? "perception";
      const target = action.target ? find(action.target) : null;
      const pace = paceModes(e)[0]?.mode;
      const check = checkRoll(
        c,
        { skill },
        action.dc ?? target?.hidden ?? null,
        skill === "perception" ? pace : undefined,
      );
      if (skill !== "perception") break;
      // SRD "Finding Hidden Objects": only the hidden points near enough to be found, in sight.
      const found = pointsInSight(e, ctx, c).filter(
        (p) => check.total >= (p.dc as number) && !p.noticed_by.includes(c.id),
      );
      for (const p of found) p.noticed_by.push(c.id);
      if (found.length) notes.push(message("search.finds", { name: c.name }));
      halt(found);
      const hidden = e.combatants.filter(
        (x) =>
          x.hidden !== null &&
          x.id !== c.id &&
          (target ? x.id === target.id : !alliesOf(e, x.id, c)),
      );
      for (const x of hidden) {
        if (check.total >= (x.hidden as number))
          unhide(x, message("why.found_by", { name: c.name }));
        else notes.push(message("search.misses", { name: c.name, target: x.name }));
      }
      break;
    }
    case "study":
    case "influence": {
      const c = find(action.id);
      takeAction(c, action.type === "study" ? "Study" : "Influence");
      let dc = action.dc ?? null;
      if (action.type === "influence" && dc === null && action.target) {
        // "a default DC equal to 15 or the monster's Intelligence score, whichever is higher"
        const t = find(action.target);
        dc = Math.max(15, t.monster !== null ? monsterDef(ctx, t).abilities.int : 0);
      }
      checkRoll(c, action.skill ? { skill: action.skill } : { ability: "int" }, dc);
      break;
    }
    case "utilize": {
      const c = find(action.id);
      takeAction(c, "Utilize");
      notes.push(
        message("action.utilize", {
          name: c.name,
          given: Boolean(action.what),
          what: action.what ?? "",
        }),
      );
      break;
    }
    case "ready": {
      const c = find(action.id);
      const then = action.action;
      if (then.id !== c.id) fail(message("refusal.readied_action_combatant_own"));
      if (then.type === "attack" && (then.reaction || then.opportunity || then.light_extra)) {
        fail(message("refusal.readied_attack_taken_reaction"));
      }
      if (c.readied) fail(message("refusal.already_readied_action", { name: c.name }));
      let held = false;
      if (then.type === "cast") {
        // "you cast it as normal (expending any resources used to cast it) but hold its energy
        // … To be readied, a spell must have a casting time of an action … Concentration".
        const spell =
          lookup(ctx.catalog.spells, then.spell) ??
          fail(message("refusal.unknown_spell", { spell: then.spell }));
        if (!/^Action/i.test(spell.casting_time)) {
          fail(
            message("refusal.takes_spell_cast_action", {
              spell: spell.name,
              casting_time: spell.casting_time,
            }),
          );
        }
        takeAction(c, "Ready");
        if (c.character !== null) {
          const ref = characterRef(ctx, c);
          const known = computePlaySheet(ref.build, ref.state, ctx.catalog).spells;
          if (!known.some((x) => x.id === spell.id))
            fail(message("refusal.cant_cast", { name: c.name, spell: spell.name }));
          if (spell.level > 0) {
            play(
              c,
              then.pact
                ? { type: "spend_pact_slot" }
                : { type: "spend_slot", level: then.slot_level ?? spell.level },
            );
          }
          play(c, { type: "set_concentration", spell: spell.name });
        } else {
          const line =
            monsterSpells(monsterDef(ctx, c)).find(
              (x) =>
                x.spell === spell.id &&
                x.section === "actions" &&
                (then.via === undefined || x.action === then.via),
            ) ?? fail(message("refusal.cant_cast_action", { name: c.name, spell: spell.name }));
          spendDaily(c, line.action, line.action_per_day, line.action);
          spendDaily(c, `${line.action}#${line.spell}`, line.per_day, spell.name);
          if (line.recharge) c.expended.push(line.action);
          c.concentration = spell.name;
        }
        held = true;
        notes.push(
          message("readied.spell", { name: c.name, spell: spell.name, trigger: action.trigger }),
        );
      } else {
        takeAction(c, "Ready");
        notes.push(
          message("readied.action", { name: c.name, kind: then.type, trigger: action.trigger }),
        );
      }
      c.readied = { trigger: action.trigger, action: then, held };
      break;
    }
    case "release":
      return fail(message("refusal.nothing_release"));
    case "effects": {
      const c = find(action.id);
      applyTo(c, action.actions);
      const source = action.source;
      if (source !== undefined) find(source);
      const ends = endsFrom(c.id, source, action.rounds, action.until);
      // Tracked when it has a duration, depends on Concentration, or has a known source (a
      // grapple: Grappled's Disadvantage doesn't apply against the grappler).
      if (ends || action.concentration || source !== undefined) {
        if (action.concentration && !source)
          fail(message("refusal.concentration_effect_needs_source"));
        const conditions = action.actions.flatMap((a) =>
          a.type === "add_condition" ? [a.condition] : [],
        );
        const label =
          action.label ??
          (action.concentration ? (concentrationOf(find(source as string)) ?? "") : "effect");
        if (action.concentration && !label)
          fail(message("refusal.not_concentrating", { name: find(source as string).name }));
        if (action.escape_dc !== undefined && !source)
          fail(message("refusal.grapple_needs_source"));
        addEffects(c, conditions, {
          source: source ?? null,
          label,
          concentration: action.concentration ?? false,
          ends,
          escape_dc: action.escape_dc,
        });
      }
      break;
    }
    case "zone_save": {
      const z =
        e.zones.find((x) => x.id === action.zone) ??
        fail(message("refusal.no_zone", { zone: action.zone }));
      for (const id of action.targets) {
        const t = find(id);
        if (z.once_per_turn && z.saved.includes(t.id)) {
          notes.push(message("zone.already_saved", { name: t.name, label: z.label }));
        }
      }
      zoneSave(z, action.targets, message("why.zone_save", { count: action.targets.length }));
      break;
    }
    case "move_zone": {
      const z =
        e.zones.find((x) => x.id === action.zone) ??
        fail(message("refusal.no_zone", { zone: action.zone }));
      if (!z.point) fail(message("refusal.moves_caster", { label: z.label }));
      if (action.onto && !z.ram)
        fail(message("refusal.doesnt_make_creature_save", { label: z.label }));
      const before = zoneOccupants();
      z.point = { ...action.point };
      notes.push(message("zone.moves", { label: z.label, x: action.point.x, y: action.point.y }));
      zoneEntries(before);
      if (action.onto) zoneSave(z, [action.onto], message("why.in_its_way"));
      break;
    }
    case "move_mark": {
      const c = find(action.id);
      const t = find(action.target);
      const marks = e.marks.filter(
        (m) =>
          m.kind === "quarry" &&
          m.by === c.id &&
          (!action.spell ||
            m.label.toLowerCase() === action.spell.toLowerCase().replace(/-/g, " ")),
      );
      const mark = marks[0] ?? fail(message("refusal.no_hunter_mark_hex", { name: c.name }));
      const old = find(mark.on);
      // "If the target drops to 0 Hit Points before this spell ends, you can take a Bonus Action".
      if (!outOfFight(ctx, old) && encounterCombatant(e, old.id, ctx).hp > 0) {
        fail(message("refusal.moves_once_drops_hit", { label: mark.label, old: old.name }));
      }
      takeAction(c, `move ${mark.label}`, true);
      mark.on = t.id;
      notes.push(message("mark.moved", { name: c.name, label: mark.label, target: t.name }));
      break;
    }
    case "end_zone": {
      const z =
        e.zones.find((x) => x.id === action.zone) ??
        fail(message("refusal.no_zone", { zone: action.zone }));
      endZone(z, message("why.ended"));
      break;
    }
    case "end_effect": {
      const effect =
        e.effects.find((x) => x.id === action.effect) ??
        fail(message("refusal.no_effect", { effect: action.effect }));
      endEffect(effect, message("why.ended"));
      break;
    }
    case "check": {
      const c = find(action.id);
      if (c.defeated) fail(message("refusal.defeated", { name: c.name }));
      if (action.save) {
        // A saving throw on demand: rolled with the combatant's conditions, nothing applied.
        const view = encounterCombatant(e, c.id, ctx);
        const save = rollD20Test(
          view,
          { save: action.save },
          { rng, mode: action.mode, dc: action.dc ?? null },
        );
        result = save;
        notes.push(
          message("save.result", {
            name: c.name,
            ability: abilityMsg(action.save),
            automatic: save.automatic_failure ?? "none",
            total: save.total,
            dc: save.dc ?? "none",
            count: save.reasons.length,
            reasons: [...save.reason_messages],
            outcome: save.success === null ? "none" : save.success,
          }),
        );
        break;
      }
      const what = action.skill
        ? { skill: action.skill }
        : { ability: action.ability ?? fail(message("refusal.check_needs_skill_ability")) };
      checkRoll(c, what, action.dc ?? null, action.mode);
      break;
    }
    case "extend": {
      find(action.id).extended = true;
      break;
    }
    case "attack": {
      const c = find(action.id);
      canAct(c);
      const t = find(action.target);
      const attacker = encounterCombatant(e, c.id, ctx);
      const line = attacker.attacks.find((a) => a.name === action.attack);
      const light = line?.properties.includes("light") ?? false;
      if (action.granted) {
        // An attack a feature granted this turn (Flurry of Blows), without spending an action.
        onTurn(c, "attack");
        const granted = c.granted_attacks;
        if (!granted || granted.count === 0)
          refuse(message("refusal.no_granted_attacks_left", { name: c.name }));
        if (granted && granted.attack !== action.attack)
          fail(message("refusal.granted_attacks_are", { attack: granted.attack }));
        if (granted && granted.count > 0) granted.count -= 1;
      } else if (action.cleave) {
        // SRD "Cleave": after a melee hit with this weapon, an attack against a second creature
        // within 5 feet of the first, once per turn; it isn't one of the Attack action's attacks.
        onTurn(c, "attack");
        if (c.cleave_used) refuse(message("refusal.already_made_cleave_attack", { name: c.name }));
        const from =
          c.cleave ?? fail(message("refusal.hasnt_hit_creature_cleave", { name: c.name }));
        if (from.attack !== action.attack)
          fail(message("refusal.cleave_attack_made", { attack: from.attack }));
        if (from.target === t.id) fail(message("refusal.cleave_attack_against_second"));
        c.cleave = null;
        c.cleave_used = true;
      } else if (action.light_extra) {
        // SRD "Light": after attacking with a Light weapon in the Attack action, one extra attack
        // as a Bonus Action with a different Light weapon.
        onTurn(c, "attack");
        if (!light) fail(message("refusal.isnt_light_weapon", { attack: action.attack }));
        if (!c.light_attacks.length) {
          fail(message("refusal.hasnt_attacked_light_weapon", { name: c.name }));
        }
        const same = attacker.attacks.filter((a) => a.name === action.attack).length;
        if (same < 2 && c.light_attacks.every((name) => name === action.attack)) {
          fail(message("refusal.extra_attack_must_made", { attack: action.attack }));
        }
        // Nick: "as part of the Attack action instead of as a Bonus Action", once per turn.
        if (line?.mastery === "Nick" && action.mastery !== false && !c.nick_used) {
          c.nick_used = true;
          notes.push(message("mastery.nick", { name: c.name }));
        } else {
          if (c.used.bonus_action)
            refuse(message("refusal.already_used_bonus_action", { name: c.name }));
          c.used.bonus_action = true;
        }
      } else {
        const reaction = action.reaction || action.opportunity;
        if (action.opportunity) {
          if (line && line.kind !== "melee")
            fail(message("refusal.opportunity_attack_melee_attack"));
          if (e.marks.some((m) => m.kind === "staggered" && m.on === c.id)) {
            fail(message("refusal.cant_make_opportunity_attacks", { name: c.name }));
          }
          if (t.disengaged)
            fail(message("refusal.disengaged_movement_doesnt_provoke", { target: t.name }));
        }
        spendAttack(c, reaction);
        if (light && !reaction) c.light_attacks.push(action.attack);
      }
      if (c.monster !== null)
        spendDaily(c, action.attack, dailyUses(ctx, c, action.attack), action.attack);
      result = attackOn(c, t, action.attack, action);
      break;
    }
    case "save_action": {
      const c = find(action.id);
      onTurn(c, "act");
      canAct(c);
      if (c.expended.includes(action.ability))
        refuse(message("refusal.hasnt_recharged", { name: c.name, ability: action.ability }));
      const user = encounterCombatant(e, c.id, ctx);
      const line = user.save_actions.find((a) => a.name === action.ability);
      if (c.used.action) refuse(message("refusal.already_used_action_turn", { name: c.name }));
      if (c.monster !== null)
        spendDaily(c, action.ability, dailyUses(ctx, c, action.ability), action.ability);
      const targets = line
        ? saveTargets(c, line, action.area, action.targets)
        : (action.targets ?? []);
      result = saveEffectOn(c, user, action.ability, targets, action.cover, !!action.area);
      c.used.action = true;
      if (line?.recharge) c.expended.push(action.ability);
      break;
    }
    case "roll": {
      // A free roll: the actor's dice (`rollByHand`) and what they cost; nothing spent or checked.
      const c = find(action.id);
      const w = action.what;
      if (w.type === "legendary" && c.monster === null) {
        fail(message("refusal.no_legendary_actions", { name: c.name }));
      }
      if (w.type === "feature" && c.character === null) {
        fail(message("refusal.no_class_features", { name: c.name }));
      }
      const ref = c.character !== null ? characterRef(ctx, c) : null;
      const character = ref ? { build: ref.build, state: ref.state } : undefined;
      // Its full stat block: an ability waiting to recharge can still be rolled (its Recharge is
      // a cost that can't be paid now).
      const whole = {
        ...e,
        combatants: e.combatants.map((x) => (x === c ? { ...x, expended: [] } : x)),
      };
      let r: ByHandRoll;
      try {
        r = rollWith(encounterCombatant(whole, c.id, ctx), w, {
          catalog: ctx.catalog,
          rng,
          ...(c.monster !== null ? { monster: monsterDef(ctx, c) } : {}),
          ...(character ? { character } : {}),
        });
      } catch (error) {
        if (error instanceof RangeError) fail(ruleReason(error));
        throw error;
      }
      const costs = checkCosts(r.costs, {
        catalog: ctx.catalog,
        name: c.name,
        ...(character ? { character } : {}),
        daily_used: c.daily_used,
        expended: c.expended,
      });
      result = byHand(c, r.action, r.name, r.slot_level, r.rolls, costs);
      notes.push(...r.messages); // a spell or legendary action whose effects are text
      break;
    }
    case "spend": {
      // A roll's costs paid: a character's through its play state, a monster's on its counters.
      const c = find(action.id);
      for (const cost of action.costs) {
        if (cost.type === "play") applyTo(c, [cost.action]);
        else if (cost.type === "daily") {
          const used = c.daily_used[cost.key] ?? 0;
          if (used < cost.per_day) c.daily_used[cost.key] = used + 1;
          else {
            refuse(
              message("refusal.used_today", { name: c.name, what: cost.name, count: cost.per_day }),
            );
          }
        } else if (!c.expended.includes(cost.name)) c.expended.push(cost.name);
        else refuse(message("refusal.hasnt_recharged_2", { name: c.name, action: cost.name }));
      }
      break;
    }
    case "legendary": {
      const c = find(action.id);
      if (c.monster === null) fail(message("refusal.no_legendary_actions", { name: c.name }));
      if (e.round === 0) fail(message("refusal.fight_hasnt_started"));
      if (current()?.id === c.id) {
        refuse(message("refusal.takes_legendary_actions_after", { name: c.name }));
      }
      canAct(c);
      const def = monsterDef(ctx, c);
      const perRound = def.legendary_uses
        ? c.in_lair && def.legendary_uses.in_lair !== null
          ? def.legendary_uses.in_lair
          : def.legendary_uses.uses
        : 0;
      if (c.legendary_used >= perRound) {
        refuse(message("refusal.no_legendary_action_uses", { name: c.name }));
      }
      const user = encounterCombatant(e, c.id, ctx);
      const line =
        user.legendary_actions.find((a) => a.name === action.action) ??
        fail(
          message("refusal.no_legendary_action", {
            name: c.name,
            action: action.action,
            known: user.legendary_actions.map((a) => a.name),
          }),
        );
      if (line.once_per_round && c.legendary_taken.includes(line.name)) {
        refuse(message("refusal.cant_take_again_until", { name: c.name, attack: line.name }));
      }
      if (c.legendary_used < perRound) c.legendary_used += 1; // forced: nothing more to spend
      if (line.once_per_round) c.legendary_taken.push(line.name);
      notes.push(
        message("legendary.action", {
          name: c.name,
          action: line.name,
          left: perRound - c.legendary_used,
        }),
      );
      const needTarget = () =>
        find(action.target ?? fail(message("refusal.needs_target", { attack: line.name })));
      const attackable = (name: string) => user.attacks.some((a) => a.name === name);
      const attackWith = (name: string) => attackOn(c, needTarget(), name, action);
      if (line.attacks.length) {
        const attack =
          action.attack ??
          (line.attacks.length === 1
            ? (line.attacks[0] as string)
            : fail(message("refusal.choose_attack", { action: line.name, attacks: line.attacks })));
        if (!line.attacks.includes(attack)) {
          fail(
            message("refusal.one_attack_of", {
              action: line.name,
              attacks: line.attacks,
              attack,
            }),
          );
        }
        if (!attackable(attack)) fail(message("refusal.no_attack_roll_resolve", { attack }));
        result = attackWith(attack);
      } else if (line.uses && attackable(line.uses)) {
        result = attackWith(line.uses);
      } else if (line.uses && user.save_actions.some((a) => a.name === line.uses)) {
        const used = user.save_actions.find((a) => a.name === line.uses) as SaveActionLine;
        result = saveEffectOn(
          c,
          user,
          line.uses,
          saveTargets(c, used, action.area, action.targets),
          undefined,
          !!action.area,
        );
      } else if (def.legendary_actions.find((a) => a.name === line.name)?.casts) {
        // "uses Spellcasting to cast Fear": the spell, at its listed level, through this action.
        const cast = monsterSpells(def).find(
          (x) => x.section === "legendary_actions" && x.action === line.name,
        ) as ReturnType<typeof monsterSpells>[number];
        const spell =
          lookup(ctx.catalog.spells, cast.spell) ??
          fail(message("refusal.unknown_spell", { spell: cast.spell }));
        const slot_level = spell.level === 0 ? undefined : (cast.level ?? spell.level);
        const area = action.area ? spellArea(c, spell, action.area) : null;
        const targets = area ?? action.targets ?? (action.target ? [action.target] : []);
        result = castBy(c, spell, targets, {
          slot_level,
          mode: action.mode,
          spellcasting: line.name,
          area: area !== null,
        });
      } else if (line.save) {
        result = saveEffectOn(
          c,
          { ...user, save_actions: [line.save] },
          line.name,
          saveTargets(c, line.save, action.area, action.targets),
          undefined,
          !!action.area,
        );
      } else {
        notes.push(message("legendary.text_only", { action: line.name }));
      }
      break;
    }
    case "feature": {
      const c = find(action.id);
      if (c.character === null) fail(message("refusal.no_class_features", { name: c.name }));
      const ref = characterRef(ctx, c);
      const f =
        computePlaySheet(ref.build, ref.state, ctx.catalog).actions.find(
          (a) => a.key === action.feature || a.name === action.feature,
        ) ?? fail(message("refusal.no_feature", { name: c.name, feature: action.feature }));
      if (f.halves_attack_damage || f.reduces_attack_damage) {
        fail(message("refusal.offered_when_attack_hits", { feature: f.name, name: c.name }));
      }
      const damageType =
        f.save?.damage &&
        (action.damage_type ??
          (f.save.damage.types.length === 1
            ? f.save.damage.types[0]
            : fail(
                message("refusal.choose_damage_type", {
                  feature: f.name,
                  types: f.save.damage.types,
                }),
              )));
      if (damageType && f.save?.damage && !f.save.damage.types.includes(damageType)) {
        fail(message("refusal.damage_types", { feature: f.name, types: f.save.damage.types }));
      }
      const t = action.target ? find(action.target) : c;
      if (f.target === "self" && t !== c)
        fail(message("refusal.used_yourself", { feature: f.name }));
      if (f.target === "other" && t === c)
        fail(message("refusal.used_another_creature", { feature: f.name }));
      // A feature that affects several creatures (Turn Undead) takes `targets`.
      const targets = f.many
        ? (
            action.targets ??
            fail(message("refusal.affects_several_creatures_give", { feature: f.name }))
          ).map(find)
        : [t];
      for (const x of targets) {
        if (f.many && x === c)
          fail(message("refusal.doesnt_affect", { feature: f.name, name: c.name }));
        const d = f.range === null ? null : checkedFeet(c, x);
        if (f.range !== null && d !== null && d > f.range) {
          refuse(
            message("refusal.feet_away_out_range_3", {
              other: x.name,
              d,
              feature: f.name,
              range: f.range,
            }),
          );
        }
        if (f.creature_types.length) {
          const type = creatureTypeOf(ctx, x).toLowerCase();
          if (!f.creature_types.some((y) => y.toLowerCase() === type)) {
            fail(message("refusal.not_creature_type", { name: x.name, types: f.creature_types }));
          }
        }
        for (const condition of f.removes) {
          if (!conditionsOf(ctx, x).has(condition)) {
            const name = lookup(ctx.catalog.conditions, condition)?.name ?? condition;
            fail(message("refusal.isnt", { other: x.name, name }));
          }
        }
      }
      if (f.economy === "reaction") {
        if (e.round === 0) fail(message("refusal.fight_hasnt_started"));
        canAct(c);
        if (c.used.reaction) refuse(message("refusal.already_used_reaction", { name: c.name }));
        c.used.reaction = true;
      } else if (f.economy === "free") {
        onTurn(c, `use ${f.name}`);
        canAct(c);
      } else takeAction(c, f.name, f.economy === "bonus_action");
      if (f.once_per_turn && c.features_used.includes(f.key)) {
        refuse(message("refusal.already_used_turn_2", { name: c.name, feature: f.name }));
      }
      if (f.after_hit && !c.hits.includes(t.id))
        fail(message("refusal.hasnt_hit_turn", { name: c.name, target: t.name }));
      if (f.extra_action && !c.used.action) {
        fail(message("refusal.take_your_action_gives", { feature: f.name }));
      }
      const on = f.many ? targets.map((x) => x.name) : t === c ? [] : [t.name];
      notes.push(
        message("feature.used", { name: c.name, feature: f.name, count: on.length, targets: on }),
      );
      play(c, { type: "use_feature", key: f.key, amount: action.amount });
      if (f.once_per_turn) c.features_used.push(f.key);
      if (f.heal && f.target !== "self") {
        const amount = f.heal.pooled
          ? (action.amount as number)
          : rollDamage([{ dice: f.heal.dice, bonus: f.heal.bonus, type: "healing" }], {
              rng,
            }).total;
        applyTo(t, [{ type: "heal", amount }]);
        notes.push(message("feature.heals", { name: t.name, amount }));
      }
      for (const condition of f.removes) {
        applyTo(t, [{ type: "remove_condition", condition }]);
        const name = lookup(ctx.catalog.conditions, condition)?.name ?? condition;
        notes.push(message("feature.removes", { name: t.name, condition: name }));
      }
      if (f.extra_action) {
        c.used.action = false;
        c.attacks_left = 0;
        c.surged = true;
      }
      for (const also of f.also) {
        if (also === "dash") c.extra_movement += speedOf(ctx, c, e);
        if (also === "disengage") c.disengaged = true;
        if (also === "dodge") c.dodging = true;
      }
      if (f.attacks) c.granted_attacks = { ...f.attacks };
      if (f.save) {
        const fs = f.save;
        // Damage is rolled once for every creature (SRD "Damage against Multiple Targets").
        const rolled =
          fs.damage && damageType
            ? rollDamage([{ dice: fs.damage.dice, bonus: fs.damage.bonus, type: damageType }], {
                rng,
              }).total
            : null;
        const ends: EffectEnd = fs.rounds
          ? { at: "start", of: c.id, count: fs.rounds, skip_current: false }
          : { at: "start", of: c.id, count: 1, skip_current: false };
        for (const x of targets) {
          const save = rollSavingThrow(encounterCombatant(e, x.id, ctx), fs.ability, fs.dc, {
            rng,
            decide,
          });
          result = save;
          const amount =
            rolled === null
              ? 0
              : save.success
                ? fs.damage?.half
                  ? Math.floor(rolled / 2)
                  : 0
                : rolled;
          notes.push(
            message("feature.save", {
              name: x.name,
              success: save.success,
              save: saveText(save),
              damage: rolled !== null,
              amount,
              type: damageType ?? "",
            }),
          );
          spendLegendaryResistance(x, save);
          if (amount > 0)
            applyTo(x, [{ type: "damage", instances: [{ amount, type: damageType }] }]);
          if (!save.success && fs.conditions.length && !outOfFight(ctx, x)) {
            applyTo(
              x,
              fs.conditions.map((condition) => ({ type: "add_condition", condition }) as const),
            );
            addEffects(x, fs.conditions, {
              source: c.id,
              label: f.name,
              concentration: false,
              ends: { ...ends },
              ends_on: [...fs.ends_on],
            });
          }
          if (save.success) {
            const until = { at: "start" as const, of: c.id, count: 1, skip_current: false };
            if (fs.on_success.includes("speed_halved")) {
              e.marks.push({
                kind: "speed_halved",
                label: f.name,
                by: c.id,
                on: x.id,
                ends: { ...until },
                damage: null,
              });
              notes.push(
                message("feature.speed_halved", { feature: f.name, target: x.name, name: c.name }),
              );
            }
            if (fs.on_success.includes("advantage_against")) {
              e.marks.push({
                kind: "advantage_against",
                label: f.name,
                by: c.id,
                on: x.id,
                ends: { ...until },
                damage: null,
              });
              notes.push(message("mark.advantage_against", { label: f.name, target: x.name }));
            }
          }
        }
      }
      if (f.inspiration_die) {
        t.inspiration = { die: f.inspiration_die, by: c.id };
        notes.push(message("inspiration.given", { name: t.name, die: f.inspiration_die }));
      }
      break;
    }
    case "cast": {
      const c = find(action.id);
      canAct(c);
      const spell =
        lookup(ctx.catalog.spells, action.spell) ??
        fail(message("refusal.unknown_spell", { spell: action.spell }));
      let what: "action" | "bonus_action" | "reaction" = "action";
      let slot_level = action.slot_level;
      let spellcasting: string | undefined;
      let line: ReturnType<typeof monsterSpells>[number] | undefined;
      if (c.character !== null) {
        const ref = characterRef(ctx, c);
        const known = computePlaySheet(ref.build, ref.state, ctx.catalog).spells.find(
          (x) => x.id === spell.id,
        );
        if (!known) fail(message("refusal.cant_cast", { name: c.name, spell: spell.name }));
        spellcasting = action.spellcasting ?? spellcastingOf(known);
        what = castingEconomy(spell);
      } else {
        // A monster casts it through an action that lists it (legendary ones: `legendary`).
        try {
          line = monsterCastLine(monsterDef(ctx, c), c.name, spell, action.via);
        } catch (error) {
          if (error instanceof RangeError) fail(ruleReason(error));
          throw error;
        }
        what =
          line.section === "bonus_actions"
            ? "bonus_action"
            : line.section === "reactions"
              ? "reaction"
              : "action";
        // "always cast at its lowest possible level and can't be cast at a higher level"
        const fixed = spell.level === 0 ? undefined : (line.level ?? spell.level);
        if (action.slot_level !== undefined && action.slot_level !== fixed) {
          fail(
            message("refusal.fixed_level", { name: c.name, spell: spell.name, level: fixed ?? 0 }),
          );
        }
        slot_level = fixed;
        if (action.spellcasting !== undefined && action.spellcasting !== line.action) {
          fail(message("rule.no_spellcasting", { name: c.name, source: action.spellcasting }));
        }
        spellcasting = line.action;
        if (line.recharge && c.expended.includes(line.action)) {
          refuse(message("refusal.hasnt_recharged_2", { name: c.name, action: line.action }));
        }
      }
      const released = releasing?.id === c.id;
      if (what === "reaction") {
        if (e.round === 0) fail(message("refusal.fight_hasnt_started"));
      } else onTurn(c, "cast");
      if (!released && c.used[what]) {
        fail(message("refusal.economy_used", { name: c.name, what }));
      }
      if (what === "action" && c.surged) {
        fail(message("refusal.action_surge_additional_action"));
      }
      if (action.area && action.targets?.length) fail(message("refusal.give_targets_area_not"));
      // A wall: placed from point to point; the creatures in its squares are its targets.
      const wallSpec = spell.mechanics?.wall ?? null;
      if (wallSpec && !action.wall)
        fail(message("refusal.place_wall", { spell: spell.name, example: "`wall: {from, to}`" }));
      if (!wallSpec && action.wall) fail(message("refusal.isnt_wall", { spell: spell.name }));
      const wall = wallSpec && action.wall ? placeWall(c, spell, action.wall) : null;
      // A smite (Divine Smite): "immediately after hitting a target with a Melee weapon or an
      // Unarmed Strike"; the target is the one hit, and a Critical Hit doubles its dice.
      const smite = spell.mechanics?.after_hit
        ? (c.last_hit ??
          fail(message("refusal.cast_right_after_hits", { spell: spell.name, name: c.name })))
        : null;
      if (smite && !smite.melee)
        fail(message("refusal.follows_hit_melee_attack", { spell: spell.name }));
      if (smite && action.targets?.length && action.targets[0] !== smite.target) {
        fail(
          message("refusal.smite_target", {
            spell: spell.name,
            name: c.name,
            target: find(smite.target).name,
          }),
        );
      }
      // A zone that makes no save when it appears (Spirit Guardians, Web) only takes its place.
      const placeOnly = action.area && spell.mechanics?.zone && !spell.mechanics.zone.on_cast;
      if (placeOnly) checkZonePoint(c, spell, action.area?.point);
      const area = smite
        ? [smite.target]
        : wall
          ? wall.targets
          : placeOnly
            ? []
            : action.area
              ? spellArea(c, spell, action.area)
              : null;
      result = castBy(c, spell, area ?? action.targets ?? [], {
        wall: wall ?? undefined,
        critical: smite?.critical,
        slot_level,
        pact: action.pact,
        mode: action.mode,
        spellcasting,
        cover: action.cover,
        area: area !== null,
        nearby: action.nearby,
        damage_type: action.damage_type,
        point: action.area?.point,
        unaffected: action.unaffected,
        held: released && releasing?.held,
      });
      if (!released) c.used[what] = true;
      // A refused action throws, and the working copy of the encounter is dropped.
      if (line && !(released && releasing?.held)) {
        spendDaily(c, line.action, line.action_per_day, line.action);
        spendDaily(c, `${line.action}#${line.spell}`, line.per_day, spell.name);
        if (line.recharge) c.expended.push(line.action);
      }
      break;
    }
    default:
      fail(message("refusal.unknown_action", { type: (action as { type: string }).type }));
  }
  if (releasing) {
    const c = find(releasing.id);
    c.used.reaction = true;
    c.readied = null;
  }
  sweep();
  return {
    encounter: EncounterSchema.parse(e),
    states,
    notes: notes.map((m) => m.text),
    messages: notes,
    result,
  };
}

// --- helpers ------------------------------------------------------------------------------------

function fail(reason: Message): never {
  throw new EncounterError([reason]);
}

function combatant(fields: Partial<EncounterCombatant>): EncounterCombatant {
  return EncounterCombatantSchema.parse(fields);
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "character"
  );
}

/** `goblin-warrior`, then `goblin-warrior-2`, `-3`… */
function freeId(e: Encounter, base: string): string {
  const taken = new Set(e.combatants.map((c) => c.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function signedText(n: number): string {
  return n < 0 ? `- ${-n}` : `+ ${n}`;
}

export function monsterDef(ctx: EncounterContext, c: EncounterCombatant): MonsterDef {
  return (
    lookup(ctx.catalog.monsters, c.monster) ??
    fail(message("refusal.unknown_monster", { monster: c.monster ?? "" }))
  );
}

export function characterRef(ctx: EncounterContext, c: EncounterCombatant): CharacterRef {
  return (
    ctx.characters?.[c.character ?? ""] ??
    fail(message("refusal.character_wasnt_given", { name: c.name, character: c.character ?? "" }))
  );
}

function initiativeBonus(ctx: EncounterContext, c: EncounterCombatant): number {
  if (c.monster !== null) return monsterDef(ctx, c).initiative;
  const ref = characterRef(ctx, c);
  return computePlaySheet(ref.build, ref.state, ctx.catalog).initiative.total;
}

/** Active conditions, implied ones included. */
export function conditionsOf(ctx: EncounterContext, c: EncounterCombatant): Set<string> {
  if (c.monster === null) {
    const ref = characterRef(ctx, c);
    const sheet = computePlaySheet(ref.build, ref.state, ctx.catalog);
    return new Set(sheet.play.conditions.map((x) => x.id));
  }
  const out = new Set<string>();
  const add = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    for (const next of lookup(ctx.catalog.conditions, id)?.implies ?? []) add(next);
  };
  for (const id of c.conditions) add(id);
  return out;
}

/** Walking Speed now (0 while a condition sets it to 0: Grappled, Restrained…). */
export function speedOf(ctx: EncounterContext, c: EncounterCombatant, e: Encounter): number {
  let speed: number;
  if (c.monster === null) {
    const ref = characterRef(ctx, c);
    speed = computePlaySheet(ref.build, ref.state, ctx.catalog).speed.total;
  } else {
    const stopped = [...conditionsOf(ctx, c)].some(
      (id) => lookup(ctx.catalog.conditions, id)?.speed_zero,
    );
    speed = stopped ? 0 : (monsterDef(ctx, c).speed.walk ?? 0);
  }
  // Slow: −10 feet, however many times it was hit by Slow weapons.
  const slowed = e.masteries.some((m) => m.mastery === "slow" && m.on === c.id);
  const after = slowed ? Math.max(0, speed - 10) : speed;
  // Halved (Stunning Strike's successful save), however many times.
  // Hamstring Blow: −15 feet (only the most recent counts).
  const hamstrung = e.marks.some((m) => m.kind === "hamstrung" && m.on === c.id);
  const slower = hamstrung ? Math.max(0, after - 15) : after;
  const halved =
    e.marks.some((m) => m.kind === "speed_halved" && m.on === c.id) || inSlowingZone(e, ctx, c);
  return halved ? Math.floor(slower / 2) : slower;
}

/** In a zone that halves others' Speed (Spirit Guardians), not its caster or one it spares. */
function inSlowingZone(e: Encounter, ctx: EncounterContext, c: EncounterCombatant): boolean {
  if (!c.position) return false;
  return e.zones.some((z) => {
    if (!z.speed_halved || z.by === c.id || z.unaffected.includes(c.id)) return false;
    const squares = zoneArea(e, ctx, z);
    return (
      !!squares && inArea(squares, { position: c.position as GridPoint, size: spaceOf(ctx, c) })
    );
  });
}

/** Out of the fight: a defeated monster, or a dead character. */
export function outOfFight(ctx: EncounterContext, c: EncounterCombatant): boolean {
  if (c.monster !== null) return c.defeated;
  return characterRef(ctx, c).state.dead;
}

/** The start of a creature's turn: action, Bonus Action, reaction and movement come back. */
function resetTurn(c: EncounterCombatant): void {
  c.used = { action: false, bonus_action: false, reaction: false };
  c.moved = 0;
  c.extra_movement = 0;
}

/**
 * Sort by Initiative, highest first. Ties: the higher Initiative bonus, then the order in the
 * current turn order or, for newcomers, the order they joined (the GM can change ties with
 * `set_order`). Keeps whose turn it is.
 */
function reorder(e: Encounter, ctx: EncounterContext): void {
  const now = currentCombatant(e)?.id;
  const place = (id: string) => {
    const i = e.order.indexOf(id);
    return i >= 0 ? i : e.order.length + e.combatants.findIndex((c) => c.id === id);
  };
  const ready = e.combatants.filter((c) => c.initiative !== null);
  const bonus = new Map(ready.map((c) => [c.id, initiativeBonus(ctx, c)]));
  e.order = ready
    .map((c) => c.id)
    .sort((a, b) => {
      const [ca, cb] = [e.combatants.find((c) => c.id === a), e.combatants.find((c) => c.id === b)];
      return (
        (cb?.initiative ?? 0) - (ca?.initiative ?? 0) ||
        (bonus.get(b) ?? 0) - (bonus.get(a) ?? 0) ||
        place(a) - place(b)
      );
    });
  if (now) e.turn = Math.max(0, e.order.indexOf(now));
}

/**
 * Move to the next combatant who can take a turn (from the current one if `advance` is false),
 * starting a new round after the last, and reset what it spent. Notes a character at 0 HP.
 */
function skipToActive(
  e: Encounter,
  ctx: EncounterContext,
  notes: Message[],
  advance: boolean,
): EncounterCombatant {
  for (let step = advance ? 1 : 0; step <= e.order.length; step++) {
    const index = (e.turn + step) % e.order.length;
    if (advance && step > 0 && index === 0) e.round += 1;
    const c = e.combatants.find((x) => x.id === e.order[index]);
    if (!c || outOfFight(ctx, c)) {
      if (c) notes.push(message("turn.skipped", { name: c.name }));
      continue;
    }
    e.turn = index;
    resetTurn(c);
    return c;
  }
  return fail(message("refusal.no_one_left_take"));
}

/** A play action applied to a monster in the encounter. */
function monsterEffect(ctx: EncounterContext, c: EncounterCombatant, a: PlayAction): Message[] {
  const def = monsterDef(ctx, c);
  const hp = c.hp ?? def.hit_points;
  switch (a.type) {
    case "damage": {
      if (c.defeated) fail(message("refusal.already_defeated", { name: c.name }));
      const petrified = conditionsOf(ctx, c).has("petrified");
      const result = takeDamage(
        { hp, temp: c.temp_hp, max: def.hit_points },
        a.instances ?? [{ amount: a.amount ?? 0, type: a.damage_type ?? null }],
        {
          resistances: petrified ? [...def.resistances, "all"] : def.resistances,
          vulnerabilities: def.vulnerabilities,
          immunities: def.immunities,
        },
        { critical: a.critical },
      );
      c.hp = result.hp;
      c.temp_hp = result.temp;
      // Massive Damage and Death Saving Throws are for characters: a monster just dies at 0 HP.
      const notes = result.messages.filter(
        (m) => !["damage.massive", "damage.at_zero", "damage.at_zero_dies"].includes(m.code),
      );
      const regen = def.traits.find((t) => t.regeneration)?.regeneration;
      const instances = a.instances ?? [{ amount: a.amount ?? 0, type: a.damage_type ?? null }];
      if (
        regen &&
        result.dealt > 0 &&
        instances.some((d) => d.amount > 0 && regen.stopped_by.includes(d.type as never))
      ) {
        c.regeneration_blocked = true;
      }
      if (result.hp === 0 && regen) {
        // Regeneration: "dies only if it starts its turn with 0 Hit Points and doesn't regenerate".
        if (!c.conditions.includes("unconscious")) c.conditions.push("unconscious");
        notes.push(message("monster.down_regenerating", { name: c.name }));
      } else if (result.hp === 0) {
        // SRD "Monster Death": a monster dies the instant it drops to 0 Hit Points.
        c.defeated = true;
        notes.push(message("monster.dies", { name: c.name }));
      }
      return notes;
    }
    case "heal": {
      if (c.defeated) fail(message("refusal.dead_healing_cant_help", { name: c.name }));
      c.hp = Math.min(def.hit_points, hp + Math.max(0, a.amount));
      return [];
    }
    case "set_temp_hp": {
      c.temp_hp = a.replace === false ? Math.max(c.temp_hp, a.amount) : a.amount;
      return [];
    }
    case "add_condition": {
      const condition =
        lookup(ctx.catalog.conditions, a.condition) ??
        fail(message("refusal.unknown_condition", { condition: a.condition }));
      if (def.condition_immunities.includes(condition.id)) {
        return [message("monster.immune", { name: c.name, condition: condition.name })];
      }
      if (!c.conditions.includes(condition.id)) c.conditions.push(condition.id);
      return [];
    }
    case "remove_condition": {
      if (!c.conditions.includes(a.condition))
        fail(message("refusal.isnt_2", { name: c.name, condition: a.condition }));
      c.conditions = c.conditions.filter((x) => x !== a.condition);
      return [];
    }
    case "set_concentration": {
      const previous = c.concentration;
      c.concentration = a.spell;
      return previous && a.spell ? [message("concentration.ends", { spell: previous })] : [];
    }
    case "spend_slot":
    case "spend_pact_slot":
      return []; // a monster's spell slots aren't tracked
    default:
      return fail(message("refusal.monster_cant_take_play", { type: a.type }));
  }
}

/** "14 vs DC 13", or "fails automatically: Paralyzed". */
/** One target's share of a spell or saving throw effect: "Brakka: fails (12 vs DC 14): 28 fire." */
function targetNote(name: string, hit: SpellTargetResult, ac?: number): Message {
  const parts: Message[] = [];
  if (hit.save) {
    parts.push(message("target.save", { success: hit.save.success, save: saveText(hit.save) }));
  }
  if (hit.attack) {
    parts.push(
      message("target.attack", {
        hit: hit.attack.hit,
        critical: hit.critical,
        total: hit.attack.total,
        ac: ac ?? "unknown",
      }),
    );
  }
  const effects: Message[] = [];
  if (hit.instances.length) {
    effects.push(message("target.damage", { dealt: dealtMsg(hit.instances) }));
  }
  if (hit.healing) effects.push(message("target.healing", { amount: hit.healing }));
  if (hit.conditions.length) {
    effects.push(message("target.conditions", { conditions: [...hit.conditions] }));
  }
  return message("target.result", {
    name,
    count: parts.length,
    parts,
    effect_count: effects.length,
    effects,
  });
}

function saveText(save: SaveResult): Message {
  if (save.automatic_failure) {
    return message("save.automatic_failure", { condition: save.automatic_failure });
  }
  return message("save.total", { total: save.total, dc: save.dc, mode: save.roll.mode });
}

/** An ability's name, as a message (`ability.str`: Strength). */
function abilityMsg(ability: Ability): Message {
  return message(`ability.${ability}`);
}

/** Damage dealt, part by part (`8 fire + 3 piercing`): `{dealt, list, plus}`. */
/** A damage roll made for an action played by hand, part by part with its dice. */
function damageRolled(what: string, damage: RolledDamage): Message {
  const parts = damage.parts.map((p) =>
    message("manual.damage_part", { total: p.total, type: p.type, rolls: p.rolls.map(String) }),
  );
  return message("manual.damage", { what, parts, critical: damage.critical });
}

function dealtMsg(instances: readonly { amount: number; type?: string | null }[]): Message[] {
  return instances.map((d) =>
    d.type
      ? message("damage.amount", { amount: d.amount, type: d.type })
      : message("damage.untyped", { amount: d.amount }),
  );
}

/** A given path: each square next to the one before it (diagonals included). */
export function checkedPath(from: GridPoint, path: readonly GridPoint[]): GridPoint[] {
  let at = from;
  for (const square of path) {
    if (Math.max(Math.abs(square.x - at.x), Math.abs(square.y - at.y)) !== 1) {
      fail(
        message("refusal.path_jumps_give_every", { x: at.x, y: at.y, x2: square.x, y2: square.y }),
      );
    }
    at = square;
  }
  return path.map((p) => ({ ...p }));
}

/** The action economy a spell's casting time uses. */
export function castingEconomy(spell: SpellDef): "action" | "bonus_action" | "reaction" {
  if (/^Action/i.test(spell.casting_time)) return "action";
  if (/^Bonus Action/i.test(spell.casting_time)) return "bonus_action";
  if (/^Reaction/i.test(spell.casting_time)) return "reaction";
  return fail(
    message("refusal.takes_cast_not_combat", {
      spell: spell.name,
      casting_time: spell.casting_time,
    }),
  );
}

/** A spell's range in feet ("60 feet"), or `null` (Self, Touch, Sight, Unlimited…). */
export function spellRangeFeet(spell: SpellDef): number | null {
  const feet = /^(\d+) feet$/.exec(spell.range)?.[1];
  return feet ? Number(feet) : null;
}

/** How far a spell's target can be: its range in feet, 5 for Touch, else `null` (unchecked). */
export function spellTargetRange(spell: SpellDef): number | null {
  return spell.range === "Touch" ? 5 : spellRangeFeet(spell);
}

/** Feet between two positioned combatants (nearest squares of their spaces), else `null`. */
export function feetApart(
  ctx: EncounterContext,
  a: EncounterCombatant,
  b: EncounterCombatant,
): number | null {
  if (!a.position || !b.position) return null;
  return gridDistance(a.position, spaceOf(ctx, a), b.position, spaceOf(ctx, b));
}

/** Positioned enemies of `c` within 5 feet that aren't Incapacitated (close combat). */
export function enemiesWithin5(
  e: Encounter,
  ctx: EncounterContext,
  c: EncounterCombatant,
): EncounterCombatant[] {
  return e.combatants.filter((x) => {
    if (x.id === c.id || x.defeated || alliesOf(e, x.id, c)) return false;
    const d = feetApart(ctx, c, x);
    return d !== null && d <= 5 && !conditionsOf(ctx, x).has("incapacitated");
  });
}

/** "Concentration, up to 1 minute" → 10 rounds; `null` when it isn't counted in rounds. */
function durationRounds(spell: SpellDef): number | null {
  const m = /(?:up to )?(\d+) (round|minute|hour)s?/i.exec(spell.duration);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "round" ? n : m[2] === "minute" ? n * 10 : n * 600;
}

/** Whether `c` is an ally of combatant `id`: on its side (combatants without a side are all allies). */
export function alliesOf(e: Encounter, id: string, c: EncounterCombatant): boolean {
  const other = e.combatants.find((x) => x.id === id);
  return !!other && other.side === c.side;
}

/** Proficient in a skill: a character's sheet, or a skill a monster's stat block lists. */
export function proficientIn(ctx: EncounterContext, c: EncounterCombatant, skill: string): boolean {
  if (c.monster !== null) return Object.hasOwn(monsterDef(ctx, c).skills, skill);
  const ref = characterRef(ctx, c);
  const sheet = computePlaySheet(ref.build, ref.state, ctx.catalog);
  return sheet.skills.some((line) => line.skill === skill && line.proficient_from !== null);
}

/** A monster action's uses per day ("(1/Day)" in its name), or `null`. */
export function dailyUses(
  ctx: EncounterContext,
  c: EncounterCombatant,
  name: string,
): number | null {
  const def = monsterDef(ctx, c);
  const all = [...def.actions, ...def.bonus_actions, ...def.reactions];
  return all.find((a) => a.name === name)?.per_day ?? null;
}

export type Cover = "half" | "three_quarters" | "total";

/** A wall spell's placement (`placeWall`). */
interface PlacedWall {
  /** The wall's squares; the zone's (with Wall of Fire's side); segments between squares. */
  squares: GridPoint[];
  zone: GridPoint[];
  segments: { from: GridPoint; to: GridPoint }[];
  /** Creatures in its squares when it appears. */
  targets: string[];
}

/** A target behind cover: +2 or +5 to AC and Dexterity saves; Total Cover can't be targeted. */
function withCover(view: Combatant, cover: Cover | undefined): Combatant {
  if (!cover) return view;
  if (cover === "total") fail(message("refusal.total_cover_cant_targeted", { view: view.name }));
  const bonus = cover === "half" ? 2 : 5;
  return {
    ...view,
    armor_class: view.armor_class + bonus,
    saving_throws: { ...view.saving_throws, dex: view.saving_throws.dex + bonus },
  };
}

/** Squares on a side of a creature's space (`spaceForSize`). */
export function spaceOf(ctx: EncounterContext, c: EncounterCombatant): number {
  return spaceForSize(sizeOf(ctx, c));
}

/** Its size, lowercase (`medium`; a monster's first size when it lists two). */
function sizeOf(ctx: EncounterContext, c: EncounterCombatant): string | null | undefined {
  return c.monster !== null
    ? monsterDef(ctx, c).size.split(" ")[0]?.toLowerCase()
    : computePlaySheet(characterRef(ctx, c).build, characterRef(ctx, c).state, ctx.catalog).size;
}

const SIZES = ["tiny", "small", "medium", "large", "huge", "gargantuan"];

/** Its creature type (`Undead`): a monster's stat block, a character's species. */
function creatureTypeOf(ctx: EncounterContext, c: EncounterCombatant): string {
  if (c.monster !== null) return monsterDef(ctx, c).creature_type;
  const species = characterRef(ctx, c).build.species_id;
  return lookup(ctx.catalog.species, species)?.creature_type ?? "Humanoid";
}

/**
 * What `x`'s space is to `mover` (SRD "Moving around Other Creatures"): it can pass through an
 * ally, an Incapacitated creature, a Tiny one or one two sizes larger or smaller; another
 * creature's space is Difficult Terrain unless that creature is Tiny or an ally.
 */
function occupantFor(
  ctx: EncounterContext,
  e: Encounter,
  mover: EncounterCombatant,
  x: EncounterCombatant,
): Occupant {
  const size = sizeOf(ctx, x);
  if (size === "tiny" || alliesOf(e, x.id, mover)) return "pass";
  const gap = Math.abs(
    SIZES.indexOf(size ?? "medium") - SIZES.indexOf(sizeOf(ctx, mover) ?? "medium"),
  );
  if (gap >= 2 || conditionsOf(ctx, x).has("incapacitated")) return "difficult";
  return "block";
}

export { gridDistance };

/** Another creature whose space overlaps `c`'s if it stood at `to`. */
export function spaceTakenBy(
  e: Encounter,
  ctx: EncounterContext,
  c: EncounterCombatant,
  to: GridPoint,
): EncounterCombatant | undefined {
  const size = spaceOf(ctx, c);
  return e.combatants.find(
    (x) =>
      x.id !== c.id &&
      !x.defeated &&
      x.position &&
      gridDistance(to, size, x.position, spaceOf(ctx, x)) === 0,
  );
}

/** The grid as `c` moves on it: walls, blocked and difficult squares, other creatures. */
export function terrainOf(e: Encounter, ctx: EncounterContext, c: EncounterCombatant): Terrain {
  const difficult = new Set(e.map.difficult.map(squareKey));
  const costs = new Map<string, number>();
  for (const z of e.zones) {
    // A wall's own squares, not the side its zone reaches (Wall of Fire).
    const own = z.wall_squares.length
      ? new Set(z.wall_squares.map(squareKey))
      : zoneArea(e, ctx, z);
    if (z.difficult) for (const sq of own ?? []) difficult.add(sq);
    if (z.cost > 1) for (const sq of own ?? []) costs.set(sq, Math.max(z.cost, costs.get(sq) ?? 1));
  }
  const creatures = new Map<string, Occupant>();
  for (const x of e.combatants) {
    if (x.id === c.id || !x.position || x.defeated || outOfFight(ctx, x)) continue;
    const what = occupantFor(ctx, e, c, x);
    const size = spaceOf(ctx, x);
    for (let dx = 0; dx < size; dx++) {
      for (let dy = 0; dy < size; dy++) {
        const k = `${x.position.x + dx},${x.position.y + dy}`;
        // Overlapping creatures: the strictest says.
        if (creatures.get(k) !== "block")
          creatures.set(k, what === "pass" ? (creatures.get(k) ?? what) : what);
      }
    }
  }
  return {
    walls: mapWalls(e),
    blocked: new Set(e.map.blocked.map(squareKey)),
    difficult,
    creatures,
    costs,
  };
}

/** The map's walls and the walls spells put up between squares (Wall of Force, Stone, Ice). */
export function mapWalls(e: Encounter): GridWall[] {
  return [...e.map.walls, ...e.zones.flatMap((z) => z.segments)];
}

/**
 * Outside a fight, the travel pace's effect on Wisdom (Perception) checks (SRD "Travel Pace"):
 * Fast gives Disadvantage, Slow Advantage; in a fight, none.
 */
function paceModes(e: Encounter): ModeReason[] {
  if (e.round > 0) return [];
  if (e.pace === "fast") return [modeReason("disadvantage", message("reason.pace_fast"))];
  if (e.pace === "slow") return [modeReason("advantage", message("reason.pace_slow"))];
  return [];
}

/**
 * Passive Perception (SRD Rules Glossary): 10 + the Wisdom (Perception) check bonus, +5 with
 * Advantage on such checks, −5 with Disadvantage (features, conditions, the travel pace).
 */
export function combatantPassivePerception(
  e: Encounter,
  ctx: EncounterContext,
  id: string,
): number {
  const c = encounterCombatant(e, id, ctx);
  const bonus = c.skills.perception ?? c.ability_checks.wis;
  const reasons: ModeReason[] = [...paceModes(e)];
  if (c.advantages.includes("check.wis")) reasons.push({ mode: "advantage", reason: "features" });
  for (const r of c.condition_rolls.ability_checks) {
    reasons.push({ mode: r.mode, reason: r.condition });
  }
  const { mode } = resolveMode("normal", reasons);
  return 10 + bonus + (mode === "advantage" ? 5 : mode === "disadvantage" ? -5 : 0);
}

/**
 * The hidden points `c` could notice from where it is: a DC set, within the point's range, and a
 * clear line from a corner of its space to the point's square (walls and blocked squares stop
 * it, as for Total Cover).
 */
export function pointsInSight(
  e: Encounter,
  ctx: EncounterContext,
  c: EncounterCombatant,
): PointOfInterest[] {
  if (!c.position || c.defeated) return [];
  const size = spaceOf(ctx, c);
  const corners = spaceCorners({ position: c.position, size });
  const lines = obstacles(mapWalls(e), e.map.blocked.map(squareKey));
  return e.points.filter(
    (p) =>
      !p.revealed &&
      p.dc !== null &&
      gridDistance(c.position as GridPoint, size, p.at, 1) <= p.within &&
      coverDegree(corners, { position: p.at, size: 1 }, lines).degree !== "total",
  );
}

/** `feet` moved at `speed`: the turns of Speed it takes (SRD: a turn is about 6 seconds). */
export function turnsFor(feet: number, speed: number): number {
  return speed > 0 ? Math.ceil(feet / speed) : 0;
}

/** How far `planMove` may look for a path outside a fight, where movement has no limit. */
export function explorationBudget(from: GridPoint, move: { to?: GridPoint }): number {
  return move.to ? gridDistance(from, 1, move.to, 1) * 3 + 300 : Number.MAX_SAFE_INTEGER;
}

/**
 * The squares a positioned `c` moves through for a `move` with `to` or `path`, and each step's
 * cost; `EncounterError` when a step can't be taken or `to` can't be reached with the movement
 * left. `to` goes straight when nothing blocks it, else along the cheapest path.
 */
export function planMove(
  e: Encounter,
  ctx: EncounterContext,
  c: EncounterCombatant,
  move: { to?: GridPoint; path?: readonly GridPoint[] },
  /** The movement it has (default: what's left this turn). */
  { left = Math.max(0, speedOf(ctx, c, e) + c.extra_movement - c.moved) }: { left?: number } = {},
): { path: GridPoint[]; steps: number[] } {
  const from = c.position ?? fail(message("refusal.no_position_place", { name: c.name }));
  if (move.to && move.path) fail(message("refusal.give_square_move_path"));
  const size = spaceOf(ctx, c);
  const terrain = terrainOf(e, ctx, c);
  const costs = (squares: readonly GridPoint[]): number[] => {
    let at = from;
    return squares.map((square) => {
      const why = stepBlocked(terrain, at, square, size);
      if (why) fail(message("refusal.cant_move", { name: c.name, x: square.x, y: square.y, why }));
      const cost = stepCost(terrain, at, square, size);
      at = square;
      return cost;
    });
  };
  if (move.path) {
    const path = checkedPath(from, move.path);
    return { path, steps: costs(path) };
  }
  const to = move.to ?? fail(message("refusal.give_square_move_path_2"));
  const taken = spaceTakenBy(e, ctx, c, to);
  if (taken) fail(message("refusal.space", { taken: taken.name }));
  const straight = straightPath(from, to);
  let at = from;
  const clear = straight.every((square) => {
    const ok = !stepBlocked(terrain, at, square, size);
    at = square;
    return ok;
  });
  if (clear) return { path: straight, steps: costs(straight) };
  // Around the obstacle: the cheapest path (looking a little past the movement left, to say how
  // far it is).
  const found = findPath(terrain, from, to, { size, maxCost: left + 300 });
  if (!found)
    fail(message("refusal.cant_reach_something_blocks", { name: c.name, x: to.x, y: to.y }));
  if (found.cost > left) {
    fail(
      message("refusal.cant_reach_needs_ft", {
        name: c.name,
        x: to.x,
        y: to.y,
        cost: found.cost,
        left,
      }),
    );
  }
  return { path: found.path, steps: costs(found.path) };
}

/**
 * An area placed by `c` (rules/areas.ts), after checking that its point is within `range` feet
 * (a Cube "originating from" `c`, with no range, must touch its space): its squares (with a clear
 * line from its point of origin), the positioned creatures in it with their cover from that
 * point, and those it misses for Total Cover.
 */
export function placeArea(
  e: Encounter,
  ctx: EncounterContext,
  c: EncounterCombatant,
  area: SpellArea,
  placement: AreaPlacement,
  range: number | null,
  label: string,
): {
  squares: Set<string>;
  ids: string[];
  cover: Map<string, MapCover>;
  total: string[];
} {
  if (!c.position) fail(message("refusal.no_position_area_needs", { name: c.name }));
  const origin = { position: c.position, size: spaceOf(ctx, c) };
  const point = placement.point;
  if ((area.shape === "sphere" || area.shape === "cylinder") && point && range !== null) {
    const d = distanceToPoint(origin, point);
    if (d > range) fail(message("refusal.point_feet_away_out_3", { d, label, range }));
  }
  if (area.shape === "cube" && point) {
    const d = gridDistance(point, area.size / 5, origin.position, origin.size);
    if (range === null && d !== 5)
      fail(message("refusal.cube_must_start_next", { label, name: c.name }));
    if (range !== null && d > range) fail(message("refusal.cube_feet_away_out", { d, label }));
  }
  let squares: Set<string>;
  try {
    squares = areaSquares(area, origin, placement);
  } catch (error) {
    if (error instanceof RangeError)
      fail(message("refusal.message", { label, message: error.message }));
    throw error;
  }
  // Squares with no clear line from the point of origin aren't in it (SRD "Area of Effect").
  const from = areaOriginPoint(area, origin, placement);
  squares = inLineOfEffect(e, squares, from);
  // A Sphere or Cylinder can include its creator; the other shapes start outside it.
  const includesOrigin = area.shape === "sphere" || area.shape === "cylinder";
  const inside = e.combatants
    .filter((x) => !outOfFight(ctx, x) && x.position && (includesOrigin || x.id !== c.id))
    .filter((x) => inArea(squares, { position: x.position as GridPoint, size: spaceOf(ctx, x) }));
  // Cover from the point of origin: Dexterity saves; Total Cover keeps a creature out.
  const cover = new Map<string, MapCover>();
  const ids: string[] = [];
  const total: string[] = [];
  for (const x of inside) {
    const found = mapCover(e, ctx, [from], x, [c.id]);
    if (found.degree === "total") total.push(x.id);
    else {
      ids.push(x.id);
      cover.set(x.id, found);
    }
  }
  return { squares, ids, cover, total };
}

/**
 * A zone's squares (`"x,y"`), or `null` when positions don't place it. Its origin is its point,
 * or for an Emanation its caster's space, or the space at its point (`space` squares wide).
 * Squares the point of origin has no clear line to aren't in it.
 */
/**
 * The squares zone `zoneId` covers now (`null` when it has none on the grid: no point, or its
 * caster isn't placed): an Emanation follows its creature and that creature's space (its own
 * space isn't part of it, as for targeting: flagged); squares a
 * wall or blocked square keeps out of the area's line of effect are left out. Sorted by row,
 * then column.
 */
export function zoneSquares(
  encounter: Encounter,
  zoneId: string,
  ctx: EncounterContext,
): GridPoint[] | null {
  const z =
    encounter.zones.find((x) => x.id === zoneId) ??
    fail(message("refusal.no_zone_2", { zone_id: zoneId }));
  const area = zoneArea(encounter, ctx, z);
  if (!area) return null;
  return [...area]
    .map((k) => {
      const [x, y] = k.split(",").map(Number);
      return { x: x as number, y: y as number };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

export function zoneArea(e: Encounter, ctx: EncounterContext, z: Zone): Set<string> | null {
  // A wall spell's zone: its squares, given when it was placed.
  if (z.squares) return new Set(z.squares.map(squareKey));
  let origin: GridSpace | null;
  if (z.area.shape === "emanation" && !z.point) {
    const by = e.combatants.find((x) => x.id === z.by);
    origin = by?.position ? { position: by.position, size: spaceOf(ctx, by) } : null;
  } else origin = z.point ? { position: z.point, size: z.space } : null;
  if (!origin) return null;
  const placement = { point: z.point ?? undefined };
  const squares = areaSquares(z.area, origin, placement);
  return inLineOfEffect(e, squares, areaOriginPoint(z.area, origin, placement));
}

/**
 * An area's point of origin, for lines of effect and cover (flagged): a Sphere's or Cylinder's
 * grid intersection, the center of a Cube, or the center of the space an Emanation, Cone or Line
 * comes from.
 */
export function areaOriginPoint(
  area: SpellArea,
  origin: GridSpace,
  placement: AreaPlacement,
): GridPoint {
  const center = (p: GridPoint, size: number) => ({ x: p.x + size / 2, y: p.y + size / 2 });
  if ((area.shape === "sphere" || area.shape === "cylinder") && placement.point) {
    return placement.point;
  }
  if (area.shape === "cube" && placement.point) return center(placement.point, area.size / 5);
  return center(origin.position, origin.size);
}

/** The squares of an area the point `from` has a clear line to (blocked squares left out). */
export function inLineOfEffect(
  e: Encounter,
  squares: ReadonlySet<string>,
  from: GridPoint,
): Set<string> {
  const { walls, blocked } = e.map;
  if (!walls.length && !blocked.length) return new Set(squares);
  const solid = new Set(blocked.map(squareKey));
  const lines = obstacles(walls, solid);
  return new Set(
    [...squares].filter((k) => {
      if (solid.has(k)) return false;
      const [x, y] = k.split(",").map(Number) as [number, number];
      return lineClear(from, { x: x + 0.5, y: y + 0.5 }, lines);
    }),
  );
}

export interface MapCover {
  readonly degree: CoverDegree;
  /** The creature giving Half Cover, when that's what decided it. */
  readonly by: string | null;
}

/**
 * `t`'s cover from `origins` (an attacker's corners, an area's point of origin), worked out
 * from the map's walls and blocked squares and the creatures in between (not `t`, nor those in
 * `exclude`).
 */
export function mapCover(
  e: Encounter,
  ctx: EncounterContext,
  origins: readonly GridPoint[],
  t: EncounterCombatant,
  exclude: readonly string[] = [],
): MapCover {
  if (!t.position) return { degree: "none", by: null };
  const others = e.combatants.filter(
    (x) =>
      x.id !== t.id && !exclude.includes(x.id) && x.position && !x.defeated && !outOfFight(ctx, x),
  );
  const lines = obstacles(mapWalls(e), e.map.blocked.map(squareKey));
  // Spell walls that give cover to lines through their squares (Blade Barrier).
  const screens = e.zones.flatMap((z) =>
    z.cover
      ? z.wall_squares.map((p) => ({ position: p, size: 1, degree: z.cover as CoverDegree }))
      : [],
  );
  const r = coverDegree(
    origins,
    { position: t.position, size: spaceOf(ctx, t) },
    lines,
    others.map((x) => ({ position: x.position as GridPoint, size: spaceOf(ctx, x) })),
    screens,
  );
  return { degree: r.degree, by: r.by === null ? null : (others[r.by]?.name ?? null) };
}

/** The longest reach of a combatant's melee attacks, or `null` without one. */
export function meleeReach(
  ctx: EncounterContext,
  e: Encounter,
  c: EncounterCombatant,
): number | null {
  const reaches = encounterCombatant(e, c.id, ctx)
    .attacks.filter((a) => a.kind === "melee")
    .map((a) => a.reach ?? 5);
  return reaches.length ? Math.max(...reaches) : null;
}
