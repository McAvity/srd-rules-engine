/**
 * Combatants: what combat needs to know about a creature, whatever it comes from (a character's
 * build and play state, a monster stat block, the old `Character` snapshot).
 *
 * A combatant is a read-only view. Resolving an attack doesn't change anything: it returns the
 * rolls and the damage instances, and the caller applies them to the target's own state (for a
 * character, the play action `{ type: "damage", instances, critical }`).
 */

import type { Table } from "../content/catalog";
import type { Character } from "../models/character";
import {
  ABILITIES,
  ABILITY_NAMES,
  type Ability,
  type AdvantageTarget,
  type ConditionDef,
  DAMAGE_TYPES,
  type FeatureRule,
  type MonsterDamage,
  type MonsterDef,
  SKILL_ABILITY,
  type Skill,
  type SpellArea,
  skillName,
} from "../models/content";
import type { Message } from "../models/messages";
import {
  type DamageInstance,
  type DamagePart,
  type DamageResult,
  type Defenses,
  formatDamage,
  isBloodied,
  type RolledDamage,
  rollDamage,
  takeDamage,
} from "./damage";
import { abilityModifier } from "./dice";
import { spaceForSize } from "./grid";
import { message, plainMessage, RuleError, texts } from "./messages";
import { announce, mathRng, type Rng, rollingFor } from "./rng";
import type { AttackLine } from "./sheet";
import { parseRange } from "./weapons";

export const ROLL_MODES = ["normal", "advantage", "disadvantage"] as const;
export type RollMode = (typeof ROLL_MODES)[number];

/** A way the combatant casts spells: the list it covers, its save DC and attack bonus. */
export interface CombatantSpellcasting {
  /** `Wizard`, `Magic Initiate`… */
  readonly source: string;
  /** Spell list id, or `null` for a fixed set of spells. */
  readonly list: string | null;
  readonly ability: Ability;
  readonly save_dc: number;
  readonly attack_bonus: number;
  /** The spellcasting ability modifier (added by Cure Wounds and similar). */
  readonly modifier: number;
}

export interface Combatant {
  /** Its id in an encounter, when it comes from one (who answers its decisions). */
  readonly id?: string;
  readonly name: string;
  /** Character level (cantrip damage grows at 5, 11 and 17). */
  readonly level: number;
  readonly armor_class: number;
  readonly hp: number;
  readonly temp_hp: number;
  readonly max_hp: number;
  /** At half its Hit Point maximum or fewer (`isBloodied`). */
  readonly bloodied: boolean;
  readonly proficiency_bonus: number;
  readonly modifiers: Readonly<Record<Ability, number>>;
  /** Saving throw bonuses (proficiency and penalties such as Exhaustion included). */
  readonly saving_throws: Readonly<Record<Ability, number>>;
  /** Ability check bonuses without a skill. */
  readonly ability_checks: Readonly<Record<Ability, number>>;
  /** Skill check bonuses by skill id (a monster lists only its proficient skills). */
  readonly skills: Readonly<Record<string, number>>;
  readonly defenses: Readonly<Required<Defenses>>;
  /** Active condition ids, implied ones included. */
  readonly conditions: readonly string[];
  readonly attacks: readonly AttackLine[];
  /** The lowest d20 roll that's a Critical Hit with these attacks (20; 19 for a Champion). */
  readonly critical_hit_on: number;
  readonly attacks_per_action: number;
  readonly spellcasting: readonly CombatantSpellcasting[];
  /** Advantage on saving throws or checks (`save.str` while raging). */
  readonly advantages: readonly AdvantageTarget[];
  /** Can't cast spells or concentrate (Rage). */
  readonly no_spells: boolean;
  /** Conditions it can't have (a monster's Immunities). */
  readonly condition_immunities: readonly string[];
  /** Saving throw effects it can use (a breath weapon), resolved by `useSaveAction`. */
  readonly save_actions: readonly SaveActionLine[];
  /** How its conditions change rolls (`conditionRolls`). */
  readonly condition_rolls: ConditionRolls;
  /** Legendary actions it can take after another creature's turn (a monster's). */
  readonly legendary_actions: readonly LegendaryActionLine[];
  /**
   * Legendary Resistance uses left: while above 0, a failed saving throw succeeds instead (SRD
   * "Legendary Resistance"), and the result says so.
   */
  readonly legendary_resistance: number;
  /** Its size, lowercase (`medium`; the first of a stat block's "Medium or Small"), if known. */
  readonly size: string | null;
  /** Squares on a side of its space on the grid (`spaceForSize`: Large 2, Huge 3…). */
  readonly space: number;
  /** Rules in code its features switch on (`evasion`, `reliable_talent`, `potent_cantrip`). */
  readonly rules: readonly FeatureRule[];
  /** Skills it's proficient in (Reliable Talent). */
  readonly proficient_skills: readonly string[];
  /** Ability modifiers its features add to some spells' damage (Potent Spellcasting). */
  readonly spell_damage: readonly SpellDamageBonus[];
  /**
   * A Bardic Inspiration die it holds (8 for a d8): rolled and added to its next failed D20 Test
   * that a die can change (not a natural 1 attack roll, not an automatic failure).
   */
  readonly inspiration_die: number | null;
  /**
   * Indomitable: the bonus a reroll of a failed save gets (the Fighter level), while a use is
   * left; `null` without it.
   */
  readonly indomitable?: number | null;
}

/** An ability modifier added to the damage of matching spells, worked out (`bonus`). */
export interface SpellDamageBonus {
  readonly name: string;
  readonly bonus: number;
  readonly cantrip: boolean;
  readonly list: string | null;
  readonly school: string | null;
  readonly damage_type: string | null;
  readonly one_roll: boolean;
  /** Only this spell's damage (Agonizing Blast's cantrip), or any matching one. */
  readonly spell?: string | null;
}

/**
 * A choice made after seeing a roll and before its consequences: add a Bardic Inspiration die
 * to a failed D20 Test, spend Legendary Resistance on a failed save, halve a hit with Uncanny
 * Dodge. `recommended` is the automatic answer: only when it can turn the failure into a success
 * (always, for the last two).
 */
export interface Decision {
  readonly kind:
    | "inspiration"
    | "legendary_resistance"
    | "uncanny_dodge"
    | "zone_force"
    | "indomitable"
    | "deflect_attacks"
    | "relentless_rage";
  /** Who decides. */
  readonly combatant: Combatant;
  /** The question for the table, with the roll: "Brakka: Dexterity saving throw 7 vs 15…". */
  readonly question: string;
  /** `question` as a message (for translation). */
  readonly message: Message;
  readonly recommended: boolean;
}

/** A decision asking `message` (its text is the `question`). */
export function decision(
  kind: Decision["kind"],
  combatant: Combatant,
  message: Message,
  recommended: boolean,
): Decision {
  return { kind, combatant, question: message.text, message, recommended };
}
/** Answers decisions; without one, the rolls follow each decision's `recommended`. */
export type Decide = (decision: Decision) => boolean;
const recommend: Decide = (d) => d.recommended;

/** The Bardic Inspiration die added to a failed roll (`total` short of `target`), if chosen. */
export function inspire(
  c: Combatant,
  total: number,
  target: number,
  what: Message,
  decide: Decide,
  rng: Rng,
): number | null {
  const die = c.inspiration_die;
  if (!die || total >= target) return null;
  const question = message("decision.inspiration", { name: c.name, what, total, target, die });
  const use = decide(decision("inspiration", c, question, target - total <= die));
  if (!use) return null;
  const roller = rollingFor(rng, c.id);
  announce(roller, 1, die, message("roll.inspiration"));
  return roller.int(1, die);
}

/** A legendary action: an attack it makes, an action it uses, a saving throw effect, or text. */
export interface LegendaryActionLine {
  readonly name: string;
  /** Can't be taken again until the start of the monster's next turn. */
  readonly once_per_round: boolean;
  /** Attack lines it can make (one of them). */
  readonly attacks: readonly string[];
  /** Another action it uses (an attack line or a saving throw effect). */
  readonly uses: string | null;
  readonly save: SaveActionLine | null;
  readonly text: string;
}

/** Advantage or Disadvantage from a condition, with the condition's name for notes. */
export interface ConditionMode {
  readonly mode: "advantage" | "disadvantage";
  readonly condition: string;
  /** The condition's id (Grappled's exception: `except_against_source`). */
  readonly id: string;
  readonly except_against_source: boolean;
}

/** How a creature's conditions change rolls (SRD Rules Glossary, conditions). */
export interface ConditionRolls {
  /** On its own attack rolls. */
  readonly attack_rolls: readonly ConditionMode[];
  /** On attack rolls against it, from within 5 feet and from farther. */
  readonly attacked: readonly ConditionMode[];
  readonly attacked_beyond_5ft: readonly ConditionMode[];
  /** Conditions that make a hit from within 5 feet a Critical Hit. */
  readonly critical_within_5ft: readonly string[];
  /** Ability → the condition that makes it fail that saving throw. */
  readonly fail_saves: Readonly<Partial<Record<Ability, string>>>;
  /** Ability → the condition that gives Disadvantage on that saving throw. */
  readonly save_disadvantage: Readonly<Partial<Record<Ability, string>>>;
  readonly initiative: readonly ConditionMode[];
  readonly ability_checks: readonly ConditionMode[];
}

export const NO_CONDITION_ROLLS: ConditionRolls = {
  attack_rolls: [],
  attacked: [],
  attacked_beyond_5ft: [],
  critical_within_5ft: [],
  fail_saves: {},
  save_disadvantage: {},
  initiative: [],
  ability_checks: [],
};

/** Condition ids with the ones they imply (Unconscious → Incapacitated, Prone). */
export function expandConditions(ids: readonly string[], table: Table<ConditionDef>): string[] {
  const out: string[] = [];
  const add = (id: string) => {
    if (out.includes(id)) return;
    out.push(id);
    for (const next of (Object.hasOwn(table, id) ? table[id] : undefined)?.implies ?? []) add(next);
  };
  for (const id of ids) add(id);
  return out;
}

/** What a creature's conditions (implied ones included) do to its rolls and to rolls against it. */
export function conditionRolls(ids: readonly string[], table: Table<ConditionDef>): ConditionRolls {
  const rolls = {
    attack_rolls: [] as ConditionMode[],
    attacked: [] as ConditionMode[],
    attacked_beyond_5ft: [] as ConditionMode[],
    critical_within_5ft: [] as string[],
    fail_saves: {} as Partial<Record<Ability, string>>,
    save_disadvantage: {} as Partial<Record<Ability, string>>,
    initiative: [] as ConditionMode[],
    ability_checks: [] as ConditionMode[],
  };
  for (const id of expandConditions(ids, table)) {
    const def = Object.hasOwn(table, id) ? table[id] : undefined;
    if (!def) continue;
    const entry = (mode: "advantage" | "disadvantage") => ({
      mode,
      condition: def.name,
      id: def.id,
      except_against_source: def.except_against_source,
    });
    if (def.attack_rolls) rolls.attack_rolls.push(entry(def.attack_rolls));
    if (def.attacked) rolls.attacked.push(entry(def.attacked));
    if (def.attacked_beyond_5ft) rolls.attacked_beyond_5ft.push(entry(def.attacked_beyond_5ft));
    if (def.critical_within_5ft) rolls.critical_within_5ft.push(def.name);
    if (def.initiative) rolls.initiative.push(entry(def.initiative));
    if (def.ability_checks) rolls.ability_checks.push(entry(def.ability_checks));
    for (const a of def.fail_saves) rolls.fail_saves[a] ??= def.name;
    for (const a of def.save_disadvantage) rolls.save_disadvantage[a] ??= def.name;
  }
  return rolls;
}

/** One reason for Advantage or Disadvantage on a roll. */
export interface ModeReason {
  readonly mode: "advantage" | "disadvantage";
  readonly reason: string;
  /** The reason as a message (for translation); `reason` is its text. */
  readonly message?: Message;
}

/** A reason for Advantage or Disadvantage, from its message. */
export function modeReason(mode: "advantage" | "disadvantage", why: Message): ModeReason {
  return { mode, reason: why.text, message: why };
}

/**
 * The mode of a D20 Test: Advantage if anything gives it, Disadvantage likewise, and a normal
 * roll when both apply, however many of each (SRD "Advantage", "Disadvantage").
 */
export function resolveMode(
  asked: RollMode,
  reasons: readonly ModeReason[],
): { mode: RollMode; reasons: string[]; reason_messages: Message[] } {
  const all: ModeReason[] = [...reasons];
  if (asked !== "normal") all.unshift({ mode: asked, reason: "asked" });
  const advantage = all.some((r) => r.mode === "advantage");
  const disadvantage = all.some((r) => r.mode === "disadvantage");
  const mode =
    advantage && disadvantage
      ? "normal"
      : advantage
        ? "advantage"
        : disadvantage
          ? "disadvantage"
          : "normal";
  const reason_messages = all
    .filter((r) => r.reason !== "asked")
    .map((r) => message("roll.reason", { mode: r.mode, why: r.message ?? plainMessage(r.reason) }));
  return { mode, reasons: texts(reason_messages), reason_messages };
}

export interface AttackModeOptions {
  /** Advantage or Disadvantage from elsewhere (the caller, a feature). */
  mode?: RollMode;
  /** The attacker is within 5 feet of the target (Prone, Paralyzed, Unconscious). */
  within_5ft: boolean;
  /** The attacker's condition ids whose source is this target (Grappled by it). */
  against_source_of?: readonly string[];
  /** More reasons for Advantage or Disadvantage (Help, Dodge…). */
  modes?: readonly ModeReason[];
  /** The attack's ability (`attack.str` Advantage: Reckless Attack); `null` for a spell. */
  ability?: Ability | null;
  /** A spell attack (`attack.spell` Advantage: Innate Sorcery). */
  spell?: boolean;
}

/**
 * An attack roll's mode from the attacker's and the target's conditions, and whether a hit is a
 * Critical Hit (a Paralyzed or Unconscious target within 5 feet). Without a target (`null`), the
 * attacker's side only.
 */
export function attackMode(
  attacker: Combatant,
  target: Combatant | null,
  {
    mode = "normal",
    within_5ft,
    against_source_of = [],
    modes = [],
    ability = null,
    spell = false,
  }: AttackModeOptions,
): { mode: RollMode; reasons: string[]; reason_messages: Message[]; critical_on_hit: boolean } {
  const reasons: ModeReason[] = [...modes];
  // Innate Sorcery: Advantage on the attack rolls of spells.
  if (spell && attacker.advantages.includes("attack.spell")) {
    reasons.push(modeReason("advantage", message("reason.features", { name: attacker.name })));
  }
  // Reckless Attack: Advantage on attack rolls using Strength, and on attack rolls against you.
  if (ability === "str" && attacker.advantages.includes("attack.str")) {
    reasons.push(modeReason("advantage", message("reason.features", { name: attacker.name })));
  }
  if (target?.advantages.includes("attacked")) {
    reasons.push(modeReason("advantage", message("reason.reckless", { name: target.name })));
  }
  for (const c of attacker.condition_rolls.attack_rolls) {
    if (c.except_against_source && against_source_of.includes(c.id)) continue;
    reasons.push(
      modeReason(c.mode, message("reason.is", { name: attacker.name, condition: c.condition })),
    );
  }
  if (target) {
    const against = within_5ft
      ? target.condition_rolls.attacked
      : target.condition_rolls.attacked_beyond_5ft;
    for (const c of against) {
      const why = message("reason.is_at", {
        name: target.name,
        condition: c.condition,
        within_5ft,
      });
      reasons.push(modeReason(c.mode, why));
    }
  }
  const resolved = resolveMode(mode, reasons);
  const critical_on_hit =
    target !== null && within_5ft && target.condition_rolls.critical_within_5ft.length > 0;
  return { ...resolved, critical_on_hit };
}

/** A saving throw effect with a fixed DC (a monster's breath weapon or gaze). */
export interface SaveActionLine {
  readonly name: string;
  readonly ability: Ability;
  readonly dc: number;
  /** Damage on a failed save. */
  readonly damage_parts: readonly DamagePart[];
  readonly on_success: "half" | "none";
  /** Conditions on a failed save. */
  readonly conditions: readonly string[];
  /** `5–6`: recharges on those d6 rolls (tracked by the caller). */
  readonly recharge: string | null;
  /** The area it fills (a breath weapon's Cone), or `null` for the creatures it names. */
  readonly area?: SpellArea | null;
  /** How far its target or its area's point can be, in feet. */
  readonly range?: number | null;
}

export interface D20Roll {
  /** One die, or two with Advantage or Disadvantage. */
  readonly rolls: readonly number[];
  /** The die that counts. */
  readonly d20: number;
  readonly mode: RollMode;
}

/** Roll a d20 for a D20 Test: two dice and the higher (Advantage) or lower (Disadvantage). */
export function rollD20({
  mode = "normal",
  rng = mathRng,
  purpose,
}: {
  mode?: RollMode;
  rng?: Rng;
  /** What it's for, for a table rolling it (`Rng.dice`). */
  purpose?: Message;
} = {}): D20Roll {
  const keep = mode === "advantage" ? "higher" : mode === "disadvantage" ? "lower" : null;
  announce(rng, keep ? 2 : 1, 20, purpose ?? message("roll.d20"), keep);
  if (mode === "normal") {
    const d20 = rng.int(1, 20);
    return { rolls: [d20], d20, mode };
  }
  const rolls = [rng.int(1, 20), rng.int(1, 20)];
  const d20 = mode === "advantage" ? Math.max(...rolls) : Math.min(...rolls);
  return { rolls, d20, mode };
}

export interface AttackResult {
  readonly attacker: string;
  readonly target: string;
  /** The attack line used. */
  readonly attack: string;
  readonly attack_bonus: number;
  readonly target_ac: number;
  readonly roll: D20Roll;
  readonly total: number;
  readonly hit: boolean;
  readonly critical_hit: boolean;
  /** A natural 1: the attack misses whatever the total. */
  readonly critical_miss: boolean;
  /** Why the roll had Advantage or Disadvantage (conditions), if it did. */
  readonly reasons: readonly string[];
  /** `reasons` as messages (for translation). */
  readonly reason_messages: readonly Message[];
  /** The Bardic Inspiration die rolled and added to a miss, if any. */
  readonly inspiration: number | null;
  /** The damage rolled on a hit. */
  readonly damage: RolledDamage | null;
  /** Names of the riders added to the damage. */
  readonly riders: readonly string[];
  /** What the target takes, before its own defenses (the play action's `instances`). */
  readonly instances: readonly DamageInstance[];
  /** The damage applied to the target as it is now (a preview; nothing is changed). */
  readonly outcome: DamageResult | null;
}

export interface AttackOptions {
  rng?: Rng;
  mode?: RollMode;
  /** Wield a Versatile weapon with two hands. */
  two_handed?: boolean;
  /**
   * Riders of the attack line to add on a hit (by id or name), with the damage type when there's
   * a choice: `[{ rider: "sneak-attack" }, { rider: "divine-strike", type: "radiant" }]`.
   * Once-per-turn limits are the caller's to track (turns come with encounters).
   */
  riders?: readonly { rider: string; type?: string }[];
  /** An ally is within 5 feet of the target and not Incapacitated (Sneak Attack without Advantage). */
  ally_adjacent?: boolean;
  /** The attacker is within 5 feet of the target (default: a melee attack is, a ranged one isn't). */
  within_5ft?: boolean;
  /** The attacker's condition ids whose source is the target (Grappled by it). */
  against_source_of?: readonly string[];
  /** More reasons for Advantage or Disadvantage (Help: `{ mode: "advantage", reason: "…" }`). */
  modes?: readonly ModeReason[];
  /**
   * The Light property's extra attack: the line's `light_extra_damage_parts` (no positive ability
   * modifier). Throws for an attack that isn't with a Light weapon.
   */
  light_extra?: boolean;
  /** The Cleave mastery's attack: the line's `cleave_damage_parts`. */
  cleave?: boolean;
  /** Answers the attacker's decisions (Bardic Inspiration on a miss). */
  decide?: Decide;
  /** Dice taken off a requested rider before rolling (Cunning Strike: Sneak Attack dice). */
  forgo?: readonly { rider: string; dice: number }[];
  /** Extra damage on a hit, of the weapon's type when `type` is `weapon` (Brutal Strike). */
  extra_damage?: readonly { dice: string; type: "weapon" | string }[];
  /** No Advantage on this roll (Brutal Strike); refused if it has Disadvantage. */
  forgo_advantage?: boolean;
  /** A flat bonus to the attack roll (Sundering Blow: +5). */
  bonus?: number;
  /**
   * Roll the damage on a miss too (an attack played by hand: the table decides whether it hits);
   * `instances` and `outcome` stay empty on a miss.
   */
  damage_on_miss?: boolean;
}

/**
 * Make one attack with one of the attacker's attack lines (by name, or the line itself).
 *
 * A natural 1 always misses. A roll of `critical_hit_on` or more (a natural 20, or 19 with
 * Improved Critical) is a Critical Hit, which hits regardless of the target's AC (SRD "Critical
 * Hit") and rolls the damage dice twice. Conditions add Advantage or Disadvantage (`attackMode`),
 * and a hit on a Paralyzed or Unconscious target within 5 feet is a Critical Hit.
 */
export function makeAttack(
  attacker: Combatant,
  attack: string | AttackLine,
  target: Combatant,
  {
    rng = mathRng,
    mode = "normal",
    two_handed = false,
    riders = [],
    ally_adjacent = false,
    within_5ft,
    against_source_of = [],
    modes = [],
    light_extra = false,
    cleave = false,
    decide = recommend,
    damage_on_miss = false,
    forgo = [],
    extra_damage = [],
    forgo_advantage = false,
    bonus = 0,
  }: AttackOptions = {},
): AttackResult {
  const line =
    typeof attack === "string" ? attacker.attacks.find((a) => a.name === attack) : attack;
  if (!line) {
    const known = attacker.attacks.map((a) => a.name).join(", ");
    throw new RuleError(
      message("rule.no_attack_named", { name: attacker.name, attack: String(attack), known }),
    );
  }
  const moded = attackMode(attacker, target, {
    mode,
    within_5ft: within_5ft ?? line.kind === "melee",
    against_source_of,
    modes,
    ability: line.ability,
  });
  if (forgo_advantage && moded.mode === "disadvantage") {
    throw new RuleError(message("rule.attack_roll_disadvantage_advantage"));
  }
  const forgone = message("reason.advantage_forgone");
  const effective =
    forgo_advantage && moded.mode === "advantage"
      ? {
          ...moded,
          mode: "normal" as const,
          reasons: [...moded.reasons, forgone.text],
          reason_messages: [...moded.reason_messages, forgone],
        }
      : moded;
  if (light_extra && !line.light_extra_damage_parts) {
    throw new RuleError(message("rule.isnt_light_weapon", { attack: line.name }));
  }
  if (cleave && !line.cleave_damage_parts) {
    throw new RuleError(message("rule.doesnt_cleave_mastery_property", { attack: line.name }));
  }
  // Check the riders before rolling, so a refused request rolls nothing.
  const extra: DamagePart[] = [];
  const riderNames: string[] = [];
  for (const request of riders) {
    const rider = line.riders.find((r) => r.id === request.rider || r.name === request.rider);
    if (!rider)
      throw new RuleError(message("rule.no_rider", { attack: line.name, rider: request.rider }));
    if (rider.requires === "target_damaged" && target.hp >= target.max_hp) {
      throw new RuleError(message("rule.needs_target_missing_some", { rider: rider.name }));
    }
    if (rider.requires === "advantage_or_ally") {
      const ok =
        effective.mode === "advantage" || (ally_adjacent && effective.mode !== "disadvantage");
      if (!ok) {
        throw new RuleError(message("rule.needs_advantage_ally_next", { rider: rider.name }));
      }
    }
    let type: string;
    if (typeof rider.type === "string") type = rider.type;
    else {
      const choice = request.type?.toLowerCase();
      if (!choice || !rider.type.includes(choice)) {
        throw new RuleError(
          message("rule.choose_rider_damage_type", { rider: rider.name, types: rider.type }),
        );
      }
      type = choice;
    }
    if (!(DAMAGE_TYPES as readonly string[]).includes(type)) {
      throw new RuleError(message("rule.unknown_damage_type", { rider: rider.name, type }));
    }
    let dice = rider.dice;
    const taken = forgo.filter((f) => f.rider === rider.id).reduce((n, f) => n + f.dice, 0);
    if (taken && dice) {
      const m = /^(\d+)d(\d+)$/.exec(dice);
      const count = Number(m?.[1] ?? 0);
      if (taken > count)
        throw new RuleError(message("rule.dice_forgo", { rider: rider.name, count }));
      dice = count - taken > 0 ? `${count - taken}d${m?.[2]}` : null;
    }
    if (dice !== null || rider.bonus) extra.push({ dice, bonus: rider.bonus, type });
    riderNames.push(rider.name);
  }
  for (const x of extra_damage) {
    extra.push({ dice: x.dice, bonus: 0, type: x.type === "weapon" ? line.damage_type : x.type });
  }
  const roller = rollingFor(rng, attacker.id);
  const roll = rollD20({
    mode: effective.mode,
    rng: roller,
    purpose: message("roll.attack_with", { attack: line.name }),
  });
  let total = roll.d20 + line.attack_bonus + bonus;
  const critical_miss = roll.d20 === 1;
  const criticalRoll = !critical_miss && roll.d20 >= Math.min(20, attacker.critical_hit_on);
  // Bardic Inspiration on a miss (not a natural 1, which misses whatever the total).
  const inspiration =
    criticalRoll || critical_miss
      ? null
      : inspire(
          attacker,
          total,
          target.armor_class,
          message("roll.attack_with", { attack: line.name }),
          decide,
          rng,
        );
  total += inspiration ?? 0;
  const hit = criticalRoll || (!critical_miss && total >= target.armor_class);
  const critical_hit = criticalRoll || (hit && effective.critical_on_hit);
  const base = {
    attacker: attacker.name,
    target: target.name,
    attack: line.name,
    attack_bonus: line.attack_bonus,
    target_ac: target.armor_class,
    roll,
    total,
    hit,
    critical_hit,
    critical_miss,
    reasons: effective.reasons,
    reason_messages: effective.reason_messages,
    inspiration,
  };
  if (!hit && !damage_on_miss) {
    return { ...base, damage: null, riders: [], instances: [], outcome: null };
  }
  let base_parts = line.damage_parts;
  if (light_extra && line.light_extra_damage_parts) base_parts = line.light_extra_damage_parts;
  else if (cleave && line.cleave_damage_parts) base_parts = line.cleave_damage_parts;
  else if (two_handed && line.two_handed_damage_parts) base_parts = line.two_handed_damage_parts;
  const parts = [...base_parts, ...extra];
  const damage = rollDamage(parts, { critical: critical_hit, rng: roller, what: line.name });
  if (!hit) return { ...base, damage, riders: riderNames, instances: [], outcome: null };
  const instances = damage.parts.map((p) => ({ amount: p.total, type: p.type }));
  const outcome = takeDamage(
    { hp: target.hp, temp: target.temp_hp, max: target.max_hp },
    instances,
    target.defenses,
    { critical: critical_hit },
  );
  return { ...base, damage, riders: riderNames, instances, outcome };
}

export interface SaveResult {
  readonly name: string;
  readonly ability: Ability;
  readonly dc: number;
  readonly bonus: number;
  readonly roll: D20Roll;
  readonly total: number;
  readonly success: boolean;
  /** The condition that made it fail without a roll (Paralyzed: Strength and Dexterity). */
  readonly automatic_failure: string | null;
  /** It failed, and Legendary Resistance made it a success (one use spent). */
  readonly legendary_resistance: boolean;
  /** Why the roll had Advantage or Disadvantage, if it did. */
  readonly reasons: readonly string[];
  /** `reasons` as messages (for translation). */
  readonly reason_messages: readonly Message[];
  /** The Bardic Inspiration die rolled and added (it failed without it), if any. */
  readonly inspiration: number | null;
  /** It failed and was rerolled with Indomitable (one use spent): `roll` is the new roll. */
  readonly indomitable?: boolean;
}

/**
 * A saving throw against a DC. Unlike attacks, a natural 20 or 1 has no special effect. A
 * condition can make it fail without a roll (Paralyzed, Stunned…: Strength and Dexterity) or give
 * Disadvantage (Restrained: Dexterity); a feature can give Advantage (Rage: Strength).
 */
export function rollSavingThrow(
  combatant: Combatant,
  ability: Ability,
  dc: number,
  {
    rng = mathRng,
    mode = "normal",
    decide = recommend,
  }: { rng?: Rng; mode?: RollMode; decide?: Decide } = {},
): SaveResult {
  const bonus = combatant.saving_throws[ability];
  const base = { name: combatant.name, ability, dc, bonus };
  // Legendary Resistance: "If the monster fails a saving throw, it can choose to succeed instead."
  const resist = (total: number | null) => {
    const left = combatant.legendary_resistance;
    if (left <= 0) return false;
    const question = message("decision.legendary_resistance", {
      name: combatant.name,
      ability: message(`ability.${ability}`),
      rolled: total !== null,
      total: total ?? 0,
      dc,
      left,
    });
    return decide(decision("legendary_resistance", combatant, question, true));
  };
  const failing = combatant.condition_rolls.fail_saves[ability];
  if (failing) {
    const resisted = resist(null);
    const roll = { rolls: [], d20: 0, mode: "normal" as const };
    return {
      ...base,
      roll,
      total: 0,
      success: resisted,
      automatic_failure: failing,
      legendary_resistance: resisted,
      reasons: [],
      reason_messages: [],
      inspiration: null,
    };
  }
  const resolved = resolveMode(mode, saveModes(combatant, ability));
  const what = message("roll.save", { ability: message(`ability.${ability}`) });
  const roller = rollingFor(rng, combatant.id);
  let roll = rollD20({ mode: resolved.mode, rng: roller, purpose: what });
  let total = roll.d20 + bonus;
  // Indomitable: "If you fail a saving throw, you can reroll it with a bonus equal to your
  // Fighter level. You must use the new roll."
  let indomitable = false;
  const reroll = combatant.indomitable ?? null;
  if (total < dc && reroll !== null) {
    const question = message("decision.indomitable", {
      name: combatant.name,
      what,
      total,
      dc,
      bonus: reroll,
    });
    if (decide(decision("indomitable", combatant, question, dc - bonus - reroll <= 20))) {
      indomitable = true;
      roll = rollD20({ mode: resolved.mode, rng: roller, purpose: what });
      total = roll.d20 + bonus + reroll;
    }
  }
  const inspiration = inspire(combatant, total, dc, what, decide, rng);
  total += inspiration ?? 0;
  const legendary = total < dc && resist(total);
  return {
    ...base,
    roll,
    total,
    indomitable,
    success: total >= dc || legendary,
    automatic_failure: null,
    legendary_resistance: legendary,
    reasons: resolved.reasons,
    reason_messages: resolved.reason_messages,
    inspiration,
  };
}

/** Advantage or Disadvantage on `combatant`'s saving throws with `ability` (features, conditions). */
function saveModes(combatant: Combatant, ability: Ability): ModeReason[] {
  const reasons: ModeReason[] = [];
  if (combatant.advantages.includes(`save.${ability}`)) {
    reasons.push(modeReason("advantage", message("reason.features", { name: combatant.name })));
  }
  const hindered = combatant.condition_rolls.save_disadvantage[ability];
  if (hindered) {
    reasons.push(
      modeReason(
        "disadvantage",
        message("reason.is", { name: combatant.name, condition: hindered }),
      ),
    );
  }
  return reasons;
}

/** A D20 Test to roll on its own: a check (skill or ability), a saving throw, an attack roll. */
export type D20TestRequest =
  | { skill: Skill }
  | { ability: Ability }
  | { save: Ability }
  | { attack: string };

/** A D20 Test rolled on its own (`rollD20Test`). */
export interface D20TestResult {
  readonly kind: "check" | "save" | "attack";
  readonly name: string;
  /** `Stealth check`, `Dexterity saving throw`, `Longsword attack roll`. */
  readonly label: string;
  /** `label` as a message (`roll.check`, `roll.save`, `roll.attack_label`), for translation. */
  readonly label_message: Message;
  /** The ability rolled with (`null`: an attack line with none). */
  readonly ability: Ability | null;
  readonly skill: string | null;
  readonly attack: string | null;
  /** The DC, or the AC for an attack; `null`: none given. */
  readonly dc: number | null;
  readonly bonus: number;
  readonly roll: D20Roll;
  readonly total: number;
  /** Against `dc`; `null` without one. */
  readonly success: boolean | null;
  /** A save failed outright by a condition (Paralyzed: Strength and Dexterity). */
  readonly automatic_failure: string | null;
  /** An attack's natural roll in its Critical Hit range (or a natural 1: `critical_miss`). */
  readonly critical: boolean;
  readonly critical_miss: boolean;
  /** Why it has Advantage or Disadvantage, Reliable Talent… */
  readonly reasons: readonly string[];
  /** `reasons` as messages (for translation). */
  readonly reason_messages: readonly Message[];
}

/**
 * A D20 Test for a sheet's roll button (SRD "D20 Tests"): an ability check, a saving throw or an
 * attack roll with no target, with the Advantage and Disadvantage the combatant's features and
 * conditions give, combined with `mode`. Nothing is spent: no Indomitable, Legendary Resistance
 * or Bardic Inspiration is offered. An attack against `dc` (the target's AC) hits on a natural 20
 * or its Critical Hit range and misses on a natural 1.
 */
export function rollD20Test(
  combatant: Combatant,
  request: D20TestRequest,
  {
    rng = mathRng,
    mode = "normal",
    dc = null,
  }: { rng?: Rng; mode?: RollMode; dc?: number | null } = {},
): D20TestResult {
  const never: Decide = () => false;
  const none = { attack: null, automatic_failure: null, critical: false, critical_miss: false };
  if ("skill" in request || "ability" in request) {
    const check = rollAbilityCheck(combatant, request, dc, { rng, mode, decide: never });
    const label = check.skill ? skillName(check.skill as Skill) : ABILITY_NAMES[check.ability];
    return {
      ...none,
      kind: "check",
      name: combatant.name,
      label: `${label} check`,
      label_message: message("roll.check", {
        label: message(check.skill ? `skill.${check.skill as Skill}` : `ability.${check.ability}`),
      }),
      ability: check.ability,
      skill: check.skill,
      dc,
      bonus: check.bonus,
      roll: check.roll,
      total: check.total,
      success: check.success,
      reasons: check.reasons,
      reason_messages: check.reason_messages,
    };
  }
  if ("save" in request) {
    const ability = request.save;
    const label = `${ABILITY_NAMES[ability]} saving throw`;
    const label_message = message("roll.save", { ability: message(`ability.${ability}`) });
    const base = {
      ...none,
      kind: "save",
      name: combatant.name,
      label,
      label_message,
      ability,
      skill: null,
      dc,
    };
    if (dc !== null) {
      const save = rollSavingThrow(combatant, ability, dc, { rng, mode, decide: never });
      return {
        ...base,
        kind: "save",
        bonus: save.bonus,
        roll: save.roll,
        total: save.total,
        success: save.success,
        automatic_failure: save.automatic_failure,
        reasons: save.reasons,
        reason_messages: save.reason_messages,
      };
    }
    const bonus = combatant.saving_throws[ability];
    const failing = combatant.condition_rolls.fail_saves[ability];
    if (failing) {
      const roll = { rolls: [], d20: 0, mode: "normal" as const };
      return {
        ...base,
        kind: "save",
        bonus,
        roll,
        total: 0,
        success: false,
        automatic_failure: failing,
        reasons: [],
        reason_messages: [],
      };
    }
    const resolved = resolveMode(mode, saveModes(combatant, ability));
    const roll = rollD20({
      mode: resolved.mode,
      rng: rollingFor(rng, combatant.id),
      purpose: message("roll.save", { ability: message(`ability.${ability}`) }),
    });
    return {
      ...base,
      kind: "save",
      bonus,
      roll,
      total: roll.d20 + bonus,
      success: null,
      reasons: resolved.reasons,
      reason_messages: resolved.reason_messages,
    };
  }
  const line = combatant.attacks.find((a) => a.name === request.attack);
  if (!line) {
    const known = combatant.attacks.map((a) => a.name).join(", ");
    throw new RuleError(
      message("rule.no_attack", { combatant: combatant.name, attack: request.attack, known }),
    );
  }
  const moded = attackMode(combatant, null, {
    mode,
    within_5ft: line.kind === "melee",
    ability: line.ability,
  });
  const roll = rollD20({
    mode: moded.mode,
    rng: rollingFor(rng, combatant.id),
    purpose: message("roll.attack_with", { attack: line.name }),
  });
  const total = roll.d20 + line.attack_bonus;
  const critical_miss = roll.d20 === 1;
  const critical = !critical_miss && roll.d20 >= Math.min(20, combatant.critical_hit_on);
  return {
    kind: "attack",
    name: combatant.name,
    label: `${line.name} attack roll`,
    label_message: message("roll.attack_label", { attack: line.name }),
    ability: line.ability,
    skill: null,
    attack: line.name,
    dc,
    bonus: line.attack_bonus,
    roll,
    total,
    success: dc === null ? null : critical || (!critical_miss && total >= dc),
    automatic_failure: null,
    critical,
    critical_miss,
    reasons: moded.reasons,
    reason_messages: moded.reason_messages,
  };
}

export interface CheckResult {
  readonly name: string;
  readonly ability: Ability;
  /** The skill, when it's a skill check. */
  readonly skill: string | null;
  readonly dc: number | null;
  readonly bonus: number;
  readonly roll: D20Roll;
  readonly total: number;
  /** Against a DC; `null` when none was given (a contest, or the GM decides). */
  readonly success: boolean | null;
  readonly reasons: readonly string[];
  /** `reasons` as messages (for translation). */
  readonly reason_messages: readonly Message[];
  /** The Bardic Inspiration die rolled and added, if any. */
  readonly inspiration: number | null;
}

/**
 * An ability check (SRD "Ability Check"): with a skill, the skill's bonus (proficiency,
 * Expertise, Jack of All Trades on the sheet; a monster's listed skills), else the ability's.
 * Advantage from features (`check.str` while raging) and conditions (Poisoned, Frightened:
 * Disadvantage) combine with `mode`.
 */
export function rollAbilityCheck(
  combatant: Combatant,
  what: { skill: Skill } | { ability: Ability },
  dc: number | null = null,
  {
    rng = mathRng,
    mode = "normal",
    modes = [],
    decide = recommend,
  }: { rng?: Rng; mode?: RollMode; modes?: readonly ModeReason[]; decide?: Decide } = {},
): CheckResult {
  const skill = "skill" in what ? what.skill : null;
  const ability = skill ? SKILL_ABILITY[skill] : (what as { ability: Ability }).ability;
  const bonus = (skill ? combatant.skills[skill] : undefined) ?? combatant.ability_checks[ability];
  const reasons: ModeReason[] = [...modes];
  if (combatant.advantages.includes(`check.${ability}`)) {
    reasons.push(modeReason("advantage", message("reason.features", { name: combatant.name })));
  }
  for (const c of combatant.condition_rolls.ability_checks) {
    reasons.push(
      modeReason(c.mode, message("reason.is", { name: combatant.name, condition: c.condition })),
    );
  }
  const resolved = resolveMode(mode, reasons);
  const label = message(skill ? `skill.${skill}` : `ability.${ability}`);
  const rolled = message("roll.check", { label });
  let roll = rollD20({ mode: resolved.mode, rng: rollingFor(rng, combatant.id), purpose: rolled });
  // Reliable Talent: "treat a d20 roll of 9 or lower as a 10" with a proficient skill.
  const reliable =
    skill !== null &&
    combatant.rules.includes("reliable_talent") &&
    combatant.proficient_skills.includes(skill);
  if (reliable && roll.d20 < 10) {
    roll = { ...roll, d20: 10 };
    const why = message("reason.reliable_talent");
    resolved.reasons.push(why.text);
    resolved.reason_messages.push(why);
  }
  let total = roll.d20 + bonus;
  const inspiration = dc === null ? null : inspire(combatant, total, dc, rolled, decide, rng);
  total += inspiration ?? 0;
  return {
    name: combatant.name,
    ability,
    skill,
    dc,
    bonus,
    roll,
    total,
    success: dc === null ? null : total >= dc,
    reasons: resolved.reasons,
    reason_messages: resolved.reason_messages,
    inspiration,
  };
}

const FULL_NAMES = {
  str: "strength",
  dex: "dexterity",
  con: "constitution",
  int: "intelligence",
  wis: "wisdom",
  cha: "charisma",
} as const satisfies Record<Ability, keyof Character["ability_scores"]>;

/**
 * A combatant from the old hand-filled `Character` snapshot: no attacks (pass an `AttackLine`
 * to `makeAttack`), no spellcasting, no saving throw proficiencies, no Temporary Hit Points or
 * defenses.
 */
export function combatantFromSnapshot(character: Character): Combatant {
  const modifiers = Object.fromEntries(
    ABILITIES.map((a) => [a, abilityModifier(character.ability_scores[FULL_NAMES[a]])]),
  ) as Record<Ability, number>;
  return {
    name: character.name,
    level: character.level,
    armor_class: character.armor_class,
    hp: character.current_hit_points,
    temp_hp: 0,
    max_hp: character.max_hit_points,
    bloodied: isBloodied(character.current_hit_points, character.max_hit_points),
    proficiency_bonus: character.proficiency_bonus,
    modifiers,
    saving_throws: modifiers,
    ability_checks: modifiers,
    skills: {},
    defenses: { resistances: [], vulnerabilities: [], immunities: [] },
    conditions: [],
    attacks: [],
    critical_hit_on: 20,
    attacks_per_action: 1,
    spellcasting: [],
    advantages: [],
    no_spells: false,
    condition_immunities: [],
    save_actions: [],
    condition_rolls: NO_CONDITION_ROLLS,
    legendary_actions: [],
    legendary_resistance: 0,
    size: null,
    space: 1,
    rules: [],
    proficient_skills: [],
    spell_damage: [],
    inspiration_die: null,
  };
}

/** Where a monster's spell is cast from, with its limits (see `monsterSpells`). */
export interface MonsterSpellLine {
  /** The catalog spell id. */
  readonly spell: string;
  /** The action that casts it (`Spellcasting`, `Divine Aid (2/Day)`): the spellcasting source. */
  readonly action: string;
  readonly section: "traits" | "actions" | "bonus_actions" | "reactions" | "legendary_actions";
  /** The level it's always cast at (`null`: the spell's level). */
  readonly level: number | null;
  /** Uses per day of this spell ("1/Day Each"); `null`: at will. */
  readonly per_day: number | null;
  /** Uses per day of the action, shared by its spells ("Divine Aid (2/Day)"). */
  readonly action_per_day: number | null;
  /** The action's Recharge (`5–6`), if any. */
  readonly recharge: string | null;
  /** A restriction from the stat block ("self only"), not enforced. */
  readonly note: string;
}

const MONSTER_SECTIONS = [
  "traits",
  "actions",
  "bonus_actions",
  "reactions",
  "legendary_actions",
] as const;

/** Every spell a monster can cast, by the action that casts it (SRD "Spellcasting"). */
export function monsterSpells(monster: MonsterDef): MonsterSpellLine[] {
  return MONSTER_SECTIONS.flatMap((section) =>
    monster[section].flatMap((action) =>
      (action.casts?.spells ?? []).map((s) => ({
        spell: s.spell,
        action: action.name,
        section,
        level: s.level,
        per_day: s.per_day,
        action_per_day: action.per_day,
        recharge: action.recharge,
        note: s.note,
      })),
    ),
  );
}

/**
 * One spellcasting line per action that casts spells, named after it. A stat block that gives no
 * save DC or attack bonus gets 8 + modifier + Proficiency Bonus and the DC − 8 (the bonus a DC
 * implies), so an attack spell listed without one can still be cast.
 */
function monsterSpellcasting(
  monster: MonsterDef,
  modifiers: Readonly<Record<Ability, number>>,
): CombatantSpellcasting[] {
  return MONSTER_SECTIONS.flatMap((section) =>
    monster[section].flatMap((action) => {
      const casts = action.casts;
      if (!casts) return [];
      const modifier = modifiers[casts.ability];
      const save_dc = casts.save_dc ?? 8 + modifier + monster.proficiency_bonus;
      return [
        {
          source: action.name,
          list: null,
          ability: casts.ability,
          save_dc,
          attack_bonus: casts.attack_bonus ?? save_dc - 8,
          modifier,
        },
      ];
    }),
  );
}

/** A monster's current state in play (the stat block holds the maxima). */
export interface MonsterState {
  readonly hp?: number;
  readonly temp_hp?: number;
  readonly conditions?: readonly string[];
  /** In its lair: more legendary action and Legendary Resistance uses, when it has lair values. */
  readonly in_lair?: boolean;
  /** Legendary Resistance uses already spent today. */
  readonly legendary_resistance_used?: number;
  /** `false`: never spend Legendary Resistance automatically (the GM decides). Default true. */
  readonly auto_legendary_resistance?: boolean;
}

/**
 * A combatant from a monster stat block: its attacks become attack lines (for `makeAttack`), its
 * saving throw effects become `save_actions` (for `useSaveAction`); spellcasting and legendary
 * actions stay in the stat block's text. With the catalog's `conditions`, its conditions change
 * rolls (`condition_rolls`).
 */
export function combatantFromMonster(
  monster: MonsterDef,
  state: MonsterState = {},
  { conditions: table }: { conditions?: Table<ConditionDef> } = {},
): Combatant {
  const modifiers = Object.fromEntries(
    ABILITIES.map((a) => [a, abilityModifier(monster.abilities[a])]),
  ) as Record<Ability, number>;
  const parts = (damage: readonly MonsterDamage[]): DamagePart[] =>
    damage.map((d) =>
      d.dice === null
        ? { dice: null, bonus: d.average, type: d.type }
        : { dice: d.dice, bonus: d.bonus, type: d.type },
    );
  const all = [...monster.actions, ...monster.bonus_actions, ...monster.reactions];
  const attacks: AttackLine[] = all.flatMap((action) => {
    const a = action.attack;
    if (!a?.damage.length) return [];
    const damage = parts(a.damage);
    const notes = [
      ...(a.reach !== null ? [`reach ${a.reach} ft.`] : []),
      ...(a.range !== null ? [`range ${a.range} ft.`] : []),
      ...(action.recharge ? [`Recharge ${action.recharge}`] : []),
    ];
    return [
      {
        name: action.name,
        kind: a.kind === "ranged" ? "ranged" : "melee",
        ability: null,
        weapon: false,
        properties: [],
        riders: [],
        attack_bonus: a.bonus,
        damage: formatDamage(damage),
        damage_type: damage[0]?.type ?? "",
        damage_parts: damage,
        two_handed_damage_parts: null,
        light_extra_damage_parts: null,
        cleave_damage_parts: null,
        mastery: null,
        notes,
        reach: a.kind === "ranged" ? null : (a.reach ?? 5),
        range: parseRange(a.range),
      },
    ];
  });
  const saveLine = (action: MonsterDef["actions"][number]): SaveActionLine | null =>
    action.save
      ? {
          name: action.name,
          ability: action.save.ability,
          dc: action.save.dc,
          damage_parts: parts(action.save.damage),
          on_success: action.save.on_success,
          conditions: action.save.conditions,
          recharge: action.recharge,
          area: action.save.area,
          range: action.save.range,
        }
      : null;
  // Legendary actions' own saving throw effects are only usable as legendary actions.
  const saveActions = all.flatMap((action) => saveLine(action) ?? []);
  const legendaryActions: LegendaryActionLine[] = monster.legendary_actions.map((action) => ({
    name: action.name,
    once_per_round: action.once_per_round,
    attacks: action.attacks,
    uses: action.uses,
    save: saveLine(action),
    text: action.text,
  }));
  const resistance = monster.legendary_resistance;
  const resistanceUses = resistance
    ? state.in_lair && resistance.in_lair !== null
      ? resistance.in_lair
      : resistance.uses
    : 0;
  const resistanceLeft =
    state.auto_legendary_resistance === false
      ? 0
      : Math.max(0, resistanceUses - (state.legendary_resistance_used ?? 0));
  const hp = Math.min(state.hp ?? monster.hit_points, monster.hit_points);
  return {
    name: monster.name,
    // Cantrip Upgrade doesn't apply to monsters (their spells are text).
    level: 1,
    armor_class: monster.armor_class,
    hp,
    temp_hp: state.temp_hp ?? 0,
    max_hp: monster.hit_points,
    bloodied: isBloodied(hp, monster.hit_points),
    proficiency_bonus: monster.proficiency_bonus,
    modifiers,
    saving_throws: monster.saving_throws,
    ability_checks: modifiers,
    skills: monster.skills,
    defenses: {
      resistances: monster.resistances,
      vulnerabilities: monster.vulnerabilities,
      immunities: monster.immunities,
    },
    conditions: table ? expandConditions(state.conditions ?? [], table) : (state.conditions ?? []),
    attacks,
    critical_hit_on: 20,
    // Multiattack: that many attacks for one action.
    attacks_per_action: monster.multiattack ?? 1,
    spellcasting: monsterSpellcasting(monster, modifiers),
    advantages: [],
    no_spells: false,
    condition_immunities: monster.condition_immunities,
    save_actions: saveActions,
    condition_rolls: table ? conditionRolls(state.conditions ?? [], table) : NO_CONDITION_ROLLS,
    legendary_actions: legendaryActions,
    legendary_resistance: resistanceLeft,
    size: monster.size.split(" ")[0]?.toLowerCase() || null,
    space: spaceForSize(monster.size.split(" ")[0]),
    // The Assassin's Evasion trait works like the Rogue's feature.
    rules: monster.traits.some((t) => t.name === "Evasion") ? ["evasion"] : [],
    proficient_skills: Object.keys(monster.skills),
    spell_damage: [],
    inspiration_die: null,
  };
}
