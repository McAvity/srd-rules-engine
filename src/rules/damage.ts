/**
 * Damage: rolling it and taking it (SRD 5.2.1 "Playing the Game" > "Damage and Healing").
 *
 * Pure functions shared by play (`applyAction` → `damage`) and encounters, so the rules for
 * Resistance, Temporary Hit Points, dropping to 0 and death live in one place.
 */

import type { Message } from "../models/messages";
import { parseDiceExpression, roll, signed } from "./dice";
import { message, texts } from "./messages";
import { mathRng, type Rng } from "./rng";

/** One part of an attack's damage: `dice` (or none, for a fixed amount) + `bonus`, of a type. */
export interface DamagePart {
  /** `1d8`, `2d6`; `null` for fixed damage (an Unarmed Strike without Martial Arts). */
  readonly dice: string | null;
  readonly bonus: number;
  readonly type: string;
  /** Who added it (the GM's `damage_bonus_dice`), when labelled. */
  readonly label?: string;
}

/** `1d8+3`, `1d6-1`, `4` (fixed); several parts joined with ` + `: `1d8+3 + 2d6`. */
export function formatDamage(parts: readonly DamagePart[]): string {
  return parts
    .map((p) => {
      if (p.dice === null) return String(p.bonus);
      return p.bonus === 0 ? p.dice : `${p.dice}${signed(p.bonus)}`;
    })
    .join(" + ");
}

export interface RolledDamagePart extends DamagePart {
  readonly rolls: readonly number[];
  /** Dice + bonus, never below 0. */
  readonly total: number;
  /**
   * On a Critical Hit, the index in `rolls` where the second set of dice starts (`rolls` holds
   * the first set, then the second); absent otherwise.
   */
  readonly critical_from?: number;
}

export interface RolledDamage {
  readonly parts: readonly RolledDamagePart[];
  readonly total: number;
  readonly critical: boolean;
}

/**
 * Roll every part. A Critical Hit rolls each part's dice twice (not the bonus). A penalty can
 * bring a part to 0 but not below (SRD "Damage Rolls").
 */
export function rollDamage(
  parts: readonly DamagePart[],
  { critical = false, rng = mathRng }: { critical?: boolean; rng?: Rng } = {},
): RolledDamage {
  const rolled = parts.map((part): RolledDamagePart => {
    if (part.dice === null) return { ...part, rolls: [], total: Math.max(0, part.bonus) };
    const { count, sides } = parseDiceExpression(part.dice);
    const result = roll(`${critical ? count * 2 : count}d${sides}`, rng);
    const total = Math.max(0, result.total + part.bonus);
    return critical
      ? { ...part, rolls: result.rolls, total, critical_from: count }
      : { ...part, rolls: result.rolls, total };
  });
  return { parts: rolled, total: rolled.reduce((n, p) => n + p.total, 0), critical };
}

/** One instance of damage: an amount and its type (`null`: untyped). */
export interface DamageInstance {
  readonly amount: number;
  readonly type?: string | null;
}

/**
 * Damage types the target resists, is vulnerable to, or is immune to. `"all"` in a list means
 * every type (Petrified: Resistance to all damage).
 */
export interface Defenses {
  readonly resistances?: readonly string[];
  readonly vulnerabilities?: readonly string[];
  readonly immunities?: readonly string[];
}

/**
 * The damage an instance really deals, after Immunity, then Resistance (halved, rounded down),
 * then Vulnerability (doubled) (SRD "Order of Application"). Several Resistances to the same
 * damage count once ("No Stacking").
 */
export function adjustDamage(
  instance: DamageInstance,
  defenses: Defenses = {},
): { amount: number; notes: string[]; messages: Message[] } {
  const type = instance.type?.toLowerCase() ?? null;
  const has = (list: readonly string[] = []) =>
    list.includes("all") || (type !== null && list.includes(type));
  const label = type ?? "all";
  const base = Math.max(0, Math.floor(instance.amount));
  if (has(defenses.immunities)) {
    const messages = base ? [message("damage.immunity", { type: label, amount: base })] : [];
    return { amount: 0, notes: texts(messages), messages };
  }
  let amount = base;
  const messages: Message[] = [];
  if (has(defenses.resistances)) {
    amount = Math.floor(amount / 2);
    messages.push(message("damage.resistance", { type: label, amount: base, after: amount }));
  }
  if (has(defenses.vulnerabilities)) {
    messages.push(message("damage.vulnerability", { type: label, amount, after: amount * 2 }));
    amount *= 2;
  }
  return { amount, notes: texts(messages), messages };
}

/** What a creature has before taking damage. */
export interface Vitals {
  readonly hp: number;
  readonly temp: number;
  readonly max: number;
}

export interface DamageResult {
  /** Damage dealt after Immunity, Resistance and Vulnerability, before Temporary Hit Points. */
  readonly dealt: number;
  /** The part of it that Temporary Hit Points absorbed. */
  readonly absorbed: number;
  /** Hit Points and Temporary Hit Points afterwards. */
  readonly hp: number;
  readonly temp: number;
  /** Went from above 0 to 0 Hit Points without dying. */
  readonly dropped_to_zero: boolean;
  /** Died outright: massive damage, or damage at 0 HP at least the Hit Point maximum. */
  readonly died: boolean;
  /** Death Saving Throw failures to add (damage at 0 HP: 1, or 2 from a Critical Hit). */
  readonly death_save_failures: number;
  /** The Constitution save to keep Concentration, if the damage calls for one. */
  readonly concentration_dc: number | null;
  readonly notes: readonly string[];
  /** `notes` as messages (for translation). */
  readonly messages: readonly Message[];
}

/**
 * Bloodied (SRD Rules Glossary): at half its Hit Point maximum or fewer, 0 included; Temporary
 * Hit Points don't count. `maxHp` is the current maximum (after any reduction).
 */
export function isBloodied(hp: number, maxHp: number): boolean {
  return hp * 2 <= maxHp;
}

/**
 * Take one or more instances of damage (SRD "Damage and Healing"): each is adjusted for the
 * target's defenses, Temporary Hit Points absorb the total first, then Hit Points drop.
 *
 * Interpretations (flagged in docs/ARCHITECTURE.md): damage fully absorbed by Temporary Hit
 * Points causes no Concentration save and no Death Saving Throw failure, and the Concentration
 * DC uses the damage that got past them.
 */
export function takeDamage(
  vitals: Vitals,
  instances: readonly DamageInstance[],
  defenses: Defenses = {},
  { critical = false }: { critical?: boolean } = {},
): DamageResult {
  const messages: Message[] = [];
  let dealt = 0;
  for (const instance of instances) {
    const adjusted = adjustDamage(instance, defenses);
    dealt += adjusted.amount;
    messages.push(...adjusted.messages);
  }
  const absorbed = Math.min(vitals.temp, dealt);
  if (absorbed) messages.push(message("damage.absorbed", { amount: absorbed }));
  const rest = dealt - absorbed;
  const result = {
    dealt,
    absorbed,
    hp: vitals.hp,
    temp: vitals.temp - absorbed,
    dropped_to_zero: false,
    died: false,
    death_save_failures: 0,
    concentration_dc: rest > 0 ? Math.min(30, Math.max(10, Math.floor(rest / 2))) : null,
  };
  const done = (more: Partial<DamageResult>, last?: Message): DamageResult => {
    const all = last ? [...messages, last] : messages;
    return { ...result, ...more, notes: texts(all), messages: all };
  };
  if (vitals.hp === 0) {
    if (rest >= vitals.max) return done({ died: true }, message("damage.at_zero_dies"));
    if (rest > 0) {
      const failures = critical ? 2 : 1;
      return done({ death_save_failures: failures }, message("damage.at_zero", { failures }));
    }
    return done({});
  }
  const after = vitals.hp - rest;
  if (after > 0) return done({ hp: after });
  if (-after >= vitals.max) return done({ hp: 0, died: true }, message("damage.massive"));
  return done({ hp: 0, dropped_to_zero: true });
}
