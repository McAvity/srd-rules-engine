/**
 * Casting a spell from the catalog: its `mechanics` against one or more combatants.
 *
 * Like `makeAttack`, casting changes nothing. The result lists what happens to each target
 * (attack or save, damage instances, healing, conditions) and the play actions that apply it:
 * `caster_actions` (spend the slot, start Concentration) and each target's `actions`.
 */

import type { Ability, DamageType, SpellDef } from "../models/content";
import type { Message } from "../models/messages";
import type { PlayAction } from "../models/state";
import {
  attackMode,
  type Combatant,
  type CombatantSpellcasting,
  type D20Roll,
  type Decide,
  inspire,
  type ModeReason,
  type RollMode,
  rollD20,
  rollSavingThrow,
  type SaveResult,
} from "./combatant";
import {
  type DamageInstance,
  type DamagePart,
  type DamageResult,
  type RolledDamage,
  rollDamage,
  takeDamage,
} from "./damage";
import { parseDiceExpression } from "./dice";
import { message, RuleError } from "./messages";
import { mathRng, type Rng, rollingFor } from "./rng";

export interface CastOptions {
  /** Damage that rides an attack's Critical Hit: its dice are doubled (Divine Smite). */
  critical?: boolean;
  /** The spell slot's level (default: the spell's level). Cantrips take none. */
  slot_level?: number;
  /** Spend a Pact Magic slot instead of a spell slot. */
  pact?: boolean;
  /** Which spellcasting feature to use, by source (default: the best one whose list has it). */
  spellcasting?: string;
  /** Advantage or Disadvantage on spell attack rolls. */
  mode?: RollMode;
  rng?: Rng;
  /** Answers decisions (Bardic Inspiration, Legendary Resistance); default: `recommended`. */
  decide?: Decide;
  /** More reasons for Advantage or Disadvantage on ranged spell attacks (an enemy within 5 ft). */
  modes?: readonly ModeReason[];
  /**
   * Reasons for Advantage or Disadvantage on one spell attack roll, melee or ranged: the
   * `shot`-th roll (0, 1…) against `targets[target]`. Called once per roll, in order.
   */
  modesFor?: (target: number, shot: number) => readonly ModeReason[];
  /** Creatures within the follow-up's radius of the target, besides it (Ice Knife). */
  nearby?: readonly Combatant[];
  /** The damage type picked for a spell that offers several (`mechanics.damage_types`). */
  damage_type?: DamageType;
  /** Whether the caster is within 5 feet of each target (default: a melee spell attack is). */
  within_5ft?: readonly (boolean | undefined)[];
}

export interface SpellAttackRoll {
  readonly roll: D20Roll;
  readonly total: number;
  readonly hit: boolean;
  readonly critical_hit: boolean;
  readonly critical_miss: boolean;
  /** Why the roll had Advantage or Disadvantage (conditions), if it did. */
  readonly reasons: readonly string[];
  /** `reasons` as messages (for translation). */
  readonly reason_messages: readonly Message[];
  /** The Bardic Inspiration die rolled and added to a miss, if any. */
  readonly inspiration: number | null;
}

export interface SpellTargetResult {
  /** Index into the `targets` given to `castSpell` (several beams can hit the same one). */
  readonly target: number;
  /** The target's combatant id (in an encounter); `null` for a combatant without one. */
  readonly id: string | null;
  readonly name: string;
  readonly attack: SpellAttackRoll | null;
  readonly save: SaveResult | null;
  /** Damage the target takes, before its own defenses. */
  readonly instances: readonly DamageInstance[];
  readonly critical: boolean;
  /** A preview of the damage on the target as it is now. */
  readonly outcome: DamageResult | null;
  readonly healing: number;
  readonly conditions: readonly string[];
  /** What the hit does besides damage and conditions (`advantage_against`: Guiding Bolt). */
  readonly on_hit: readonly "advantage_against"[];
  /** Play actions that apply all this to a character target's state. */
  readonly actions: readonly PlayAction[];
}

export interface SpellCastResult {
  readonly spell: string;
  readonly slot_level: number | null;
  /** The spellcasting feature used. */
  readonly spellcasting: string | null;
  readonly save_dc: number | null;
  readonly attack_bonus: number | null;
  /** Damage rolled once for every target (a save or an automatic hit). */
  readonly damage: RolledDamage | null;
  /**
   * The spell's damage at this level (upcasting, Cantrip Upgrade, the damage type picked),
   * without features' bonuses: what a zone deals again later.
   */
  readonly damage_parts: readonly DamagePart[];
  readonly targets: readonly SpellTargetResult[];
  /**
   * The saving throw after the spell attack (Ice Knife); each result's `target` is an index into
   * the `targets` given to `castSpell` followed by `nearby`.
   */
  readonly follow_up: SpellFollowUpResult | null;
  /** Play actions for the caster: spend the slot, start Concentration. */
  readonly caster_actions: readonly PlayAction[];
  readonly notes: readonly string[];
  /** `notes` as messages (for translation). */
  readonly messages: readonly Message[];
}

export interface SpellFollowUpResult {
  readonly ability: Ability;
  readonly dc: number;
  /** Damage rolled once for every creature. */
  readonly damage: RolledDamage | null;
  readonly targets: readonly SpellTargetResult[];
}

/** Cantrip Upgrade tier: 1, then 2 at level 5, 3 at 11, 4 at 17. */
export function cantripTier(level: number): number {
  return level >= 17 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1;
}

/**
 * Cast `spell` at `targets` (combatants, or none for a spell without targets). Each result's
 * `target` is an index into `targets`; each damage preview is against the target as it is now.
 *
 * - A spell attack is rolled per target (per beam or ray: Eldritch Blast, Scorching Ray), with
 *   its own damage roll and Critical Hit; a natural 1 misses and a natural 20 hits.
 * - Beams, rays and darts go at one target, or one entry of `targets` per projectile (repeat a
 *   target to aim several at it). Darts that hit automatically (Magic Missile) share one damage
 *   roll; each dart is its own damage.
 * - A follow-up saving throw (Ice Knife) comes after the attack, hit or miss, for the target and
 *   `nearby`.
 * - Damage from a save (or an automatic hit) is rolled once for all targets (SRD "Damage against
 *   Multiple Targets"); on a successful save, each damage type is halved (rounded down) or
 *   ignored, per `save.on_success`.
 * - Healing is rolled once too, and each target regains it.
 *
 * Throws `RangeError` for an illegal slot level or too many targets. A spell without
 * `mechanics` is still cast (slot, Concentration), with a note that its effects are text.
 */
export function castSpell(
  caster: Combatant,
  spell: SpellDef,
  targets: readonly Combatant[],
  {
    slot_level,
    pact = false,
    spellcasting,
    mode = "normal",
    rng: source = mathRng,
    decide = (d) => d.recommended,
    modes = [],
    modesFor,
    within_5ft,
    nearby = [],
    damage_type,
    critical = false,
  }: CastOptions = {},
): SpellCastResult {
  // The caster's rolls (a target's saving throw is the target's: `rollSavingThrow`).
  const rng = rollingFor(source, caster.id);
  if (caster.no_spells)
    throw new RuleError(message("rule.cant_cast_spells_right", { name: caster.name }));
  const m = spell.mechanics;
  const cantrip = spell.level === 0;
  const slot = cantrip ? null : (slot_level ?? spell.level);
  if (cantrip && slot_level !== undefined) {
    throw new RuleError(message("rule.cantrip_doesnt_use_spell", { spell: spell.name }));
  }
  if (slot !== null && (slot < spell.level || slot > 9)) {
    throw new RuleError(
      message("rule.needs_spell_slot_level", { spell: spell.name, level: spell.level }),
    );
  }
  const above = slot === null ? 0 : slot - spell.level;
  const tier = cantripTier(caster.level);
  // Beams (Eldritch Blast), rays or darts: how many, each with its own attack or hit.
  const projectiles = m?.projectiles;
  const beams = projectiles
    ? projectiles.count + projectiles.upcast * above
    : cantrip && m?.cantrip_scaling === "beams"
      ? tier
      : 1;
  const maxTargets = m?.targets == null ? null : m.targets + (m.upcast?.targets ?? 0) * above;
  if (beams > 1) {
    const what = projectiles ? (m?.attack ? "rays" : "darts") : "beams";
    if (targets.length !== 1 && targets.length !== beams) {
      throw new RuleError(message("rule.give_target", { spell: spell.name, beams, what }));
    }
  } else if (maxTargets !== null && targets.length > maxTargets) {
    throw new RuleError(
      message("rule.target_most_level", { spell: spell.name, max_targets: maxTargets }),
    );
  }

  const casterActions: PlayAction[] = [];
  if (slot !== null) {
    casterActions.push(pact ? { type: "spend_pact_slot" } : { type: "spend_slot", level: slot });
  }
  if (spell.concentration) casterActions.push({ type: "set_concentration", spell: spell.name });
  const base = { spell: spell.id, slot_level: slot, caster_actions: casterActions };
  if (!m) {
    const manual = message("spell.manual", { spell: spell.name });
    return {
      ...base,
      spellcasting: null,
      save_dc: null,
      attack_bonus: null,
      damage: null,
      damage_parts: [],
      targets: [],
      follow_up: null,
      notes: [manual.text],
      messages: [manual],
    };
  }

  const line = pickSpellcasting(caster, spell, spellcasting);
  const needsLine = m.attack !== null || m.save !== null || m.follow_up !== null;
  const modifierUsed = m.damage.some((d) => d.add_modifier) || m.heal?.add_modifier === true;
  if (!line && (needsLine || modifierUsed)) {
    throw new RuleError(
      message("rule.no_spellcasting_feature_cast", { name: caster.name, spell: spell.name }),
    );
  }
  const modifier = line?.modifier ?? 0;

  // Damage parts: the base dice, times the cantrip tier, plus upcast dice of the same type.
  const parts: DamagePart[] = m.damage.map((d) => {
    const { count, sides } = parseDiceExpression(d.dice);
    const scaled = cantrip && m.cantrip_scaling === "dice" ? count * tier : count;
    return {
      dice: `${scaled}d${sides}`,
      bonus: (d.add_modifier ? modifier : 0) + d.bonus,
      type: d.type,
    };
  });
  for (const extra of m.upcast?.damage ?? []) {
    if (!above) break;
    const { count, sides } = parseDiceExpression(extra.dice);
    const i = parts.findIndex((p) => p.type === extra.type);
    const part = parts[i];
    if (part?.dice && parseDiceExpression(part.dice).sides === sides) {
      parts[i] = {
        ...part,
        dice: `${parseDiceExpression(part.dice).count + count * above}d${sides}`,
      };
    } else {
      parts.push({ dice: `${count * above}d${sides}`, bonus: 0, type: extra.type });
    }
  }

  // A damage type the caster picks (Spirit Guardians), for every part.
  if (m.damage_types.length) {
    const options = m.damage_types.join(" or ");
    if (!damage_type)
      throw new RuleError(message("rule.choose_damage_type", { spell: spell.name, options }));
    if (!m.damage_types.includes(damage_type)) {
      throw new RuleError(message("rule.damage_not", { spell: spell.name, options, damage_type }));
    }
    for (const [i, part] of parts.entries()) parts[i] = { ...part, type: damage_type };
  } else if (damage_type) {
    throw new RuleError(message("rule.damage_type_isnt_choice", { spell: spell.name }));
  }

  // Spell damage bonuses from features (Potent Spellcasting): an ability modifier added to the
  // first damage part, to every roll or to the first one only (`one_roll`).
  const types = new Set(parts.map((p) => p.type));
  const matching = caster.spell_damage.filter(
    (d) =>
      parts.length > 0 &&
      (!d.cantrip || cantrip) &&
      (d.list === null || spell.lists.includes(d.list)) &&
      (d.school === null || spell.school.toLowerCase() === d.school) &&
      (d.damage_type === null || types.has(d.damage_type)) &&
      (d.spell == null || d.spell === spell.id),
  );
  const extra = (first: boolean) =>
    matching.reduce((sum, d) => sum + (!d.one_roll || first ? d.bonus : 0), 0);
  const partsFor = (first: boolean): DamagePart[] => {
    const add = extra(first);
    return add && parts[0]
      ? [{ ...parts[0], bonus: parts[0].bonus + add }, ...parts.slice(1)]
      : parts;
  };
  // Potent Cantrip: a cantrip that misses or is saved against still deals half damage.
  const potent = cantrip && caster.rules.includes("potent_cantrip");

  // Indices into `targets`: every beam at the one target, or one entry per target.
  const aimed =
    beams > 1 && targets.length === 1 ? Array<number>(beams).fill(0) : [...targets.keys()];
  const results: SpellTargetResult[] = [];
  let shared: RolledDamage | null = null;
  const sharedDamage = () => {
    shared ??=
      parts.length && targets.length ? rollDamage(partsFor(true), { rng, what: spell.name }) : null;
    return shared;
  };

  if (m.attack) {
    const bonus = line?.attack_bonus ?? 0;
    const shots = new Map<number, number>();
    for (const [beam, index] of aimed.entries()) {
      const target = targets[index] as Combatant;
      const shot = shots.get(index) ?? 0;
      shots.set(index, shot + 1);
      // Conditions change the roll like a weapon attack's; a melee spell attack is within 5 ft.
      const effective = attackMode(caster, target, {
        spell: true,
        mode,
        within_5ft: within_5ft?.[index] ?? m.attack === "melee",
        modes: [...(m.attack === "ranged" ? modes : []), ...(modesFor?.(index, shot) ?? [])],
      });
      const what = message("roll.spell_attack_with", { spell: spell.name });
      const roll = rollD20({ mode: effective.mode, rng, purpose: what });
      const critical_miss = roll.d20 === 1;
      let total = roll.d20 + bonus;
      // Bardic Inspiration on a miss (not a natural 1 or 20).
      const inspiration =
        roll.d20 === 20 || critical_miss
          ? null
          : inspire(caster, total, target.armor_class, what, decide, rng);
      total += inspiration ?? 0;
      const hit = roll.d20 === 20 || (!critical_miss && total >= target.armor_class);
      const critical_hit = roll.d20 === 20 || (hit && effective.critical_on_hit);
      const { reasons, reason_messages } = effective;
      const attack = {
        ...{ roll, total, hit, critical_hit, critical_miss },
        ...{ reasons, reason_messages, inspiration },
      };
      const rolled =
        (hit || potent) && parts.length
          ? rollDamage(partsFor(beam === 0), { critical: critical_hit, rng, what: spell.name })
          : null;
      let instances = rolled ? toInstances(rolled) : [];
      if (!hit) instances = instances.map((d) => ({ ...d, amount: Math.floor(d.amount / 2) }));
      const conditions = hit ? conditionsOn(m, "hit") : [];
      const on_hit = hit ? m.on_hit : [];
      const r = { attack, instances, critical: critical_hit, conditions, on_hit };
      results.push(targetResult(index, target, r));
    }
  } else if (m.save) {
    const effect = {
      ...m.save,
      dc: line?.save_dc ?? 0,
      conditions: conditionsOn(m, "failed_save"),
    };
    const resolved = resolveSave(effect, partsFor(true), targets, rng, decide, potent, spell.name);
    shared = resolved.damage;
    results.push(...resolved.targets);
  } else if (projectiles) {
    // Darts that hit automatically: one roll for all of them, a feature's `one_roll` bonus on
    // the first dart only.
    shared = parts.length && targets.length ? rollDamage(parts, { rng, what: spell.name }) : null;
    for (const [dart, index] of aimed.entries()) {
      const add = extra(dart === 0);
      const instances = shared
        ? toInstances(shared).map((d, i) => (i === 0 ? { ...d, amount: d.amount + add } : d))
        : [];
      results.push(targetResult(index, targets[index] as Combatant, { instances }));
    }
  } else {
    if (critical && parts.length && targets.length) {
      shared = rollDamage(partsFor(true), { critical: true, rng, what: spell.name });
    }
    const rolled = sharedDamage();
    for (const [i, target] of targets.entries()) {
      results.push(
        targetResult(i, target, { instances: rolled ? toInstances(rolled) : [], critical }),
      );
    }
  }

  // A saving throw after the attack, hit or miss: the target and the creatures near it.
  let follow_up: SpellFollowUpResult | null = null;
  if (m.follow_up) {
    const f = m.follow_up;
    const followParts: DamagePart[] = f.damage.map((d) => ({
      dice: d.dice,
      bonus: 0,
      type: d.type,
    }));
    for (const more of f.upcast) {
      if (!above) break;
      const { count, sides } = parseDiceExpression(more.dice);
      const i = followParts.findIndex(
        (p) => p.type === more.type && parseDiceExpression(p.dice ?? "").sides === sides,
      );
      const part = followParts[i];
      if (part?.dice) {
        followParts[i] = {
          ...part,
          dice: `${parseDiceExpression(part.dice).count + count * above}d${sides}`,
        };
      } else followParts.push({ dice: `${count * above}d${sides}`, bonus: 0, type: more.type });
    }
    const dc = line?.save_dc ?? 0;
    const effect = { ...f.save, dc, conditions: [] };
    const resolved = resolveSave(
      effect,
      followParts,
      [...targets, ...nearby],
      rng,
      decide,
      false,
      spell.name,
    );
    follow_up = { ability: f.save.ability, dc, damage: resolved.damage, targets: resolved.targets };
  }

  if (m.heal) {
    const healParts: DamagePart[] = [
      { dice: m.heal.dice, bonus: m.heal.add_modifier ? modifier : 0, type: "healing" },
    ];
    if (m.upcast?.heal && above) {
      const { count, sides } = parseDiceExpression(m.upcast.heal);
      healParts.push({ dice: `${count * above}d${sides}`, bonus: 0, type: "healing" });
    }
    const healing = rollDamage(healParts, { rng, what: spell.name }).total;
    for (const [i, target] of targets.entries()) {
      const current = results[i] ?? targetResult(i, target, {});
      const actions: PlayAction[] = [...current.actions, { type: "heal", amount: healing }];
      results[i] = { ...current, healing, actions };
    }
  }

  return {
    ...base,
    spellcasting: line?.source ?? null,
    save_dc: m.save || m.follow_up ? (line?.save_dc ?? null) : null,
    attack_bonus: m.attack ? (line?.attack_bonus ?? null) : null,
    damage: shared,
    damage_parts: parts,
    targets: results,
    follow_up,
    notes: [],
    messages: [],
  };
}

/**
 * The spellcasting feature to cast with: the one named by `source`, else the best (highest
 * save DC) whose spell list includes the spell, else the best overall.
 */
function pickSpellcasting(
  caster: Combatant,
  spell: SpellDef,
  source: string | undefined,
): CombatantSpellcasting | null {
  if (source !== undefined) {
    const named = caster.spellcasting.find((s) => s.source === source);
    if (!named) throw new RuleError(message("rule.no_spellcasting", { name: caster.name, source }));
    return named;
  }
  const best = (lines: readonly CombatantSpellcasting[]) =>
    lines.reduce<CombatantSpellcasting | null>(
      (top, s) => (top === null || s.save_dc > top.save_dc ? s : top),
      null,
    );
  const onList = caster.spellcasting.filter((s) => s.list !== null && spell.lists.includes(s.list));
  return best(onList) ?? best(caster.spellcasting);
}

function conditionsOn(m: NonNullable<SpellDef["mechanics"]>, on: "hit" | "failed_save"): string[] {
  return m.conditions.filter((c) => c.on === on).map((c) => c.condition);
}

function toInstances(rolled: RolledDamage): DamageInstance[] {
  return rolled.parts.map((p) => ({ amount: p.total, type: p.type }));
}

/** One target's result: the damage preview and the play actions that apply it. */
function targetResult(
  index: number,
  target: Combatant,
  r: {
    attack?: SpellAttackRoll;
    save?: SaveResult;
    instances?: DamageInstance[];
    critical?: boolean;
    conditions?: string[];
    on_hit?: readonly "advantage_against"[];
  },
): SpellTargetResult {
  const instances = r.instances ?? [];
  const critical = r.critical ?? false;
  // A target immune to a condition doesn't get it (a monster's condition Immunities).
  const conditions = (r.conditions ?? []).filter((c) => !target.condition_immunities.includes(c));
  const outcome = instances.length
    ? takeDamage(
        { hp: target.hp, temp: target.temp_hp, max: target.max_hp },
        instances,
        target.defenses,
        { critical },
      )
    : null;
  const actions: PlayAction[] = [];
  if (instances.length) actions.push({ type: "damage", instances, critical });
  for (const condition of conditions) actions.push({ type: "add_condition", condition });
  return {
    target: index,
    id: target.id ?? null,
    name: target.name,
    attack: r.attack ?? null,
    save: r.save ?? null,
    instances,
    critical,
    outcome,
    healing: 0,
    conditions,
    on_hit: r.on_hit ?? [],
    actions,
  };
}

/** A saving throw effect: an ability, a DC, what happens on a success and on a failure. */
export interface SaveEffect {
  readonly ability: Ability;
  readonly dc: number;
  readonly on_success: "half" | "none";
  readonly conditions: readonly string[];
}

/**
 * Every target saves; the damage is rolled once for all of them (SRD "Damage against Multiple
 * Targets") and each damage type is halved (rounded down) or ignored on a success.
 */
function resolveSave(
  effect: SaveEffect,
  parts: readonly DamagePart[],
  targets: readonly Combatant[],
  rng: Rng,
  decide: Decide,
  potent = false,
  what?: string,
): { damage: RolledDamage | null; targets: SpellTargetResult[] } {
  const saves = targets.map((t) => rollSavingThrow(t, effect.ability, effect.dc, { rng, decide }));
  const damage = parts.length && targets.length ? rollDamage(parts, { rng, what }) : null;
  const results = targets.map((target, i) => {
    const save = saves[i] as SaveResult;
    let instances = damage ? toInstances(damage) : [];
    const half = () => instances.map((d) => ({ ...d, amount: Math.floor(d.amount / 2) }));
    // Evasion: no damage on a success and half on a failure, for a Dexterity save that halves.
    const evasion =
      effect.ability === "dex" &&
      effect.on_success === "half" &&
      target.rules.includes("evasion") &&
      !target.conditions.includes("incapacitated");
    if (save.success) instances = effect.on_success === "half" || potent ? half() : [];
    if (evasion) instances = save.success ? [] : half();
    const conditions = save.success ? [] : [...effect.conditions];
    return targetResult(i, target, { save, instances, conditions });
  });
  return { damage, targets: results };
}

/**
 * Targets save against an effect, the damage rolled once for all of them (`resolveSave`): a
 * zone's save when creatures enter it or end their turn there. `by` rolls the damage (the
 * zone's caster), `what` names it.
 */
export function saveAgainst(
  effect: SaveEffect,
  parts: readonly DamagePart[],
  targets: readonly Combatant[],
  {
    rng = mathRng,
    decide = (d) => d.recommended,
    by,
    what,
  }: { rng?: Rng; decide?: Decide; by?: string | null; what?: string } = {},
): { damage: RolledDamage | null; targets: SpellTargetResult[] } {
  return resolveSave(effect, parts, targets, rollingFor(rng, by), decide, false, what);
}

export interface SaveActionResult {
  readonly action: string;
  readonly ability: Ability;
  readonly dc: number;
  /** Damage rolled once for every target. */
  readonly damage: RolledDamage | null;
  readonly targets: readonly SpellTargetResult[];
}

/**
 * Use one of the combatant's saving throw effects (a monster's breath weapon) against targets.
 * Like `castSpell`, it changes nothing: each target's `actions` apply the result. Recharge is
 * the caller's to track.
 */
export function useSaveAction(
  user: Combatant,
  name: string,
  targets: readonly Combatant[],
  { rng = mathRng, decide = (d) => d.recommended }: { rng?: Rng; decide?: Decide } = {},
): SaveActionResult {
  const action = user.save_actions.find((a) => a.name === name);
  if (!action) {
    const known = user.save_actions.map((a) => a.name).join(", ");
    throw new RuleError(
      message("rule.no_saving_throw_action", { name: user.name, action: name, known }),
    );
  }
  // The user's damage dice (each target's save is its own).
  const roller = rollingFor(rng, user.id);
  const resolved = resolveSave(action, action.damage_parts, targets, roller, decide, false, name);
  return {
    action: action.name,
    ability: action.ability,
    dc: action.dc,
    damage: resolved.damage,
    targets: resolved.targets,
  };
}
