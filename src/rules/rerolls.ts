/**
 * Changing a roll after it's made, from its own result: Heroic Inspiration rerolls one die
 * (`rerollDie`), Advantage given late (a luck-style resource: `addAdvantageDie`), a Critical Hit the table
 * decides (`setCritical`). Pure: the rule context is the result's `resolution` (captured when it
 * was rolled), so no build, state or catalog is needed; no other die is rolled again and nothing
 * is spent (the caller pays what the change costs: `spend_inspiration`, a `use`).
 */

import type { RollResult } from "../models/combat";
import type { Message } from "../models/messages";
import {
  type AppliedFloor,
  type AttackDice,
  type D20Resolution,
  type D20Roll,
  type D20TestResult,
  type RolledBonusDie,
  type RollMode,
  resolveMode,
} from "./combatant";
import type { RolledDamage, RolledDamagePart } from "./damage";
import { parseDiceExpression } from "./dice";
import { message, plainMessage, RuleError } from "./messages";
import type { Rng } from "./rng";

/** Where a new die comes from: the dice (`rng`), or a value given (a test, a replay). */
export type DieSource = { readonly rng: Rng } | { readonly value: number };

/**
 * Where the dice a Critical Hit adds come from when a change makes one: the `rng`, or the values
 * given in order (`critical_dice`), part by part.
 */
export type CriticalDice = { readonly rng: Rng } | { readonly values: readonly number[] };

/** One die to reroll: a d20, a bonus die, a damage die, or a die of a single roll result. */
export type RerollTarget =
  | { readonly kind: "d20"; readonly roll: D20TestResult | AttackDice; readonly die: number }
  | {
      readonly kind: "bonus_die";
      readonly roll: D20TestResult | AttackDice;
      readonly group: number;
      readonly die: number;
    }
  | {
      readonly kind: "damage";
      readonly roll: AttackDice | RolledDamage;
      readonly part: number;
      readonly die: number;
    }
  | { readonly kind: "single"; readonly roll: RollResult; readonly die: number };

type Rolled = D20TestResult | AttackDice;
const isAttackDice = (r: Rolled): r is AttackDice => "damage" in r;

function newValue(source: DieSource | CriticalDice, sides: number, queue?: number[]): number {
  let v: number | undefined;
  if ("rng" in source) v = source.rng.int(1, sides);
  else if ("value" in source) v = source.value;
  else v = queue?.shift();
  if (v === undefined) throw new RuleError(message("refusal.dice_missing"));
  if (!Number.isInteger(v) || v < 1 || v > sides) {
    throw new RuleError(message("refusal.roll_between", { die: sides }));
  }
  return v;
}

const unknownDie = (): never => {
  throw new RuleError(message("refusal.reroll_die_unknown"));
};

/** An index into a list of `length`: a whole number in range, else `refusal.reroll_die_unknown`. */
function index(i: number, length: number): number {
  if (!Number.isInteger(i) || i < 0 || i >= length) unknownDie();
  return i;
}

/** The kept die of `rolls` for `mode` (first of a tie), or the one forced (a late normal roll). */
function keptOf(rolls: readonly number[], mode: RollMode, forced?: number): number {
  if (forced !== undefined) return forced;
  if (mode === "normal" || rolls.length < 2) return 0;
  const best = mode === "advantage" ? Math.max(...rolls) : Math.min(...rolls);
  return rolls.indexOf(best);
}

function floored(
  roll: Omit<D20Roll, "d20" | "natural">,
  resolution: D20Resolution,
): { roll: D20Roll; applied: AppliedFloor[] } {
  const natural = roll.rolls[roll.kept] ?? 0;
  const top = resolution.floors.reduce<{ min: number; label: string } | null>(
    (t, f) => (!t || f.min > t.min ? f : t),
    null,
  );
  const applied = top
    ? roll.rolls.flatMap((v) => (v < top.min ? [{ label: top.label, from: v, to: top.min }] : []))
    : [];
  return { roll: { ...roll, natural, d20: top ? Math.max(natural, top.min) : natural }, applied };
}

/** Recompute a damage roll for a new Critical Hit state: the second set added or dropped. */
function recritical(damage: RolledDamage, critical: boolean, extra: CriticalDice): RolledDamage {
  if (damage.critical === critical) return damage;
  const queue = "values" in extra ? [...extra.values] : undefined;
  const parts = damage.parts.map((p): RolledDamagePart => {
    if (p.dice === null) return p;
    const { count, sides } = parseDiceExpression(p.dice);
    if (critical) {
      const more = Array.from({ length: count }, () => newValue(extra, sides, queue));
      const rolls = [...p.rolls, ...more];
      return { ...p, rolls, total: Math.max(0, sum(rolls) + p.bonus), critical_from: count };
    }
    const { critical_from, ...rest } = p;
    const rolls = p.rolls.slice(0, critical_from ?? Math.floor(p.rolls.length / 2));
    return { ...rest, rolls, total: Math.max(0, sum(rolls) + p.bonus) };
  });
  return { parts, total: sum(parts.map((p) => p.total)), critical };
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** A roll with a new d20 roll (and resolution): its total, success, Critical Hit and damage again. */
function settle<T extends Rolled>(
  r: T,
  roll: Omit<D20Roll, "d20" | "natural">,
  resolution: D20Resolution,
  extra: CriticalDice | undefined,
  more: { reason?: Message } = {},
): T {
  const f = floored(roll, resolution);
  const total = f.roll.d20 + resolution.bonus + sum(r.bonus_dice.map((b) => b.total));
  const reason_messages = more.reason
    ? [...r.reason_messages, more.reason]
    : [...r.reason_messages];
  const reasons = reason_messages.map((m) => m.text);
  const critical_miss = resolution.kind === "attack" && f.roll.natural === 1;
  const critical =
    resolution.kind === "attack" &&
    !critical_miss &&
    resolution.critical_on !== null &&
    f.roll.natural >= resolution.critical_on;
  if (isAttackDice(r)) {
    const damage = r.damage ? recritical(r.damage, critical, extra ?? { values: [] }) : null;
    return {
      ...r,
      roll: f.roll,
      total,
      critical_hit: critical,
      critical_miss,
      damage,
      resolution,
      reasons,
      reason_messages,
    };
  }
  const t = r as D20TestResult;
  const success =
    t.dc === null
      ? null
      : resolution.kind === "attack"
        ? critical || (!critical_miss && total >= t.dc)
        : total >= t.dc;
  return {
    ...t,
    roll: f.roll,
    total,
    success,
    critical,
    critical_miss,
    floors: f.applied,
    resolution,
    reasons,
    reason_messages,
  } as unknown as T;
}

/**
 * Advantage given after the roll (a luck-style resource): a normal roll with no
 * source gains a second d20 and keeps the higher; a roll with Disadvantage only becomes normal and
 * keeps its first d20 (no new die: `refusal.dice_unexpected` if a value is given). A roll that
 * already has Advantage, whose modes cancel, with the GM's override or failed automatically is
 * `refusal.roll_not_applicable`. On an attack a new Critical Hit adds its dice (`critical_dice`).
 */
export function addAdvantageDie<T extends Rolled>(
  r: T,
  source: DieSource | null,
  label: string,
  critical_dice?: CriticalDice,
): T {
  const res = r.resolution;
  const notApplicable = () => {
    throw new RuleError(message("refusal.roll_not_applicable"));
  };
  if (res.override || res.automatic_failure || r.roll.mode === "advantage") notApplicable();
  const computed = resolveMode(
    "normal",
    res.sources.map((x) => ({ mode: x.mode, reason: x.label })),
  ).mode;
  if (r.roll.mode === "normal" && res.sources.length > 0 && computed === "normal") notApplicable();
  const resolution: D20Resolution = {
    ...res,
    sources: [...res.sources, { mode: "advantage", label }],
  };
  const reason = message("roll.reason", { mode: "advantage", why: plainMessage(label) });
  if (r.roll.mode === "disadvantage") {
    if (source !== null) throw new RuleError(message("refusal.dice_unexpected"));
    const roll = { rolls: r.roll.rolls, mode: "normal" as const, kept: 0 };
    return settle(r, roll, resolution, critical_dice ?? source ?? undefined, { reason });
  }
  if (source === null) throw new RuleError(message("refusal.dice_missing"));
  const rolls = [...r.roll.rolls, newValue(source, 20)];
  const roll = { rolls, mode: "advantage" as const, kept: keptOf(rolls, "advantage") };
  const extra = critical_dice ?? ("rng" in source ? source : undefined);
  return settle(r, roll, resolution, extra, { reason });
}

/** The roll result `rerollDie` returns for each kind of target. */
export type RerollResult<T extends RerollTarget> = T["roll"];

/**
 * Heroic Inspiration: reroll one die and use the new value (SRD "Heroic Inspiration"). A d20: the
 * kept die, floors, total and (an attack) Critical Hit are worked out again from the result's
 * `resolution`; a new Critical Hit adds its dice (`critical_dice`, else the `rng` of `source`),
 * losing one drops them. A bonus die, a damage die or a die of a single roll: that die only, its
 * totals again. Nothing is spent here and no other die changes.
 */
export function rerollDie<T extends RerollTarget>(
  target: T,
  source: DieSource,
  critical_dice?: CriticalDice,
): RerollResult<T> {
  switch (target.kind) {
    case "d20": {
      const r = target.roll;
      if (r.resolution.automatic_failure)
        throw new RuleError(message("refusal.roll_not_applicable"));
      index(target.die, r.roll.rolls.length);
      const value = newValue(source, 20);
      const rolls = r.roll.rolls.map((v, i) => (i === target.die ? value : v));
      // A late normal roll (Disadvantage cancelled) keeps its first die; otherwise pick again.
      const forced = r.roll.mode === "normal" && rolls.length > 1 ? r.roll.kept : undefined;
      const roll = { rolls, mode: r.roll.mode, kept: keptOf(rolls, r.roll.mode, forced) };
      const extra = critical_dice ?? ("rng" in source ? source : undefined);
      return settle(r, roll, r.resolution, extra) as RerollResult<T>;
    }
    case "bonus_die": {
      // Only that bonus die: the d20, the Critical Hit (rolled or set by the table) and the
      // damage stay as they are; the group keeps its expression's modifier and sign.
      const r = target.roll;
      const g = r.bonus_dice[index(target.group, r.bonus_dice.length)] as RolledBonusDie;
      const die = index(target.die, g.rolls.length);
      const expr = parseDiceExpression(g.dice);
      const value = newValue(source, expr.sides);
      const rolls = g.rolls.map((v, i) => (i === die ? value : v));
      const bonus_dice: RolledBonusDie[] = r.bonus_dice.map((b, i) =>
        i === target.group ? { ...b, rolls, total: b.sign * (sum(rolls) + expr.modifier) } : b,
      );
      const total =
        r.total - sum(r.bonus_dice.map((b) => b.total)) + sum(bonus_dice.map((b) => b.total));
      if (isAttackDice(r)) return { ...r, bonus_dice, total } as RerollResult<T>;
      const t = r as D20TestResult;
      const success =
        t.dc === null
          ? null
          : t.resolution.kind === "attack"
            ? t.critical || (!t.critical_miss && total >= t.dc)
            : total >= t.dc;
      return { ...t, bonus_dice, total, success } as RerollResult<T>;
    }
    case "damage": {
      const r = target.roll;
      const damage = "parts" in r ? r : r.damage;
      if (!damage) return unknownDie();
      const p = damage.parts[index(target.part, damage.parts.length)] as RolledDamagePart;
      if (!p.dice) return unknownDie();
      index(target.die, p.rolls.length);
      const value = newValue(source, parseDiceExpression(p.dice).sides);
      const parts = damage.parts.map((q, i) => {
        if (i !== target.part) return q;
        const rolls = q.rolls.map((v, j) => (j === target.die ? value : v));
        return { ...q, rolls, total: Math.max(0, sum(rolls) + q.bonus) };
      });
      const next: RolledDamage = { ...damage, parts, total: sum(parts.map((q) => q.total)) };
      return ("parts" in r ? next : { ...r, damage: next }) as RerollResult<T>;
    }
    case "single": {
      const r = target.roll;
      index(target.die, r.rolls.length);
      const value = newValue(source, parseDiceExpression(r.dice_expression).sides);
      const rolls = r.rolls.map((v, i) => (i === target.die ? value : v));
      return { ...r, rolls, total: sum(rolls) + r.modifier } as RerollResult<T>;
    }
  }
}

/**
 * A Critical Hit the table decides (a Paralyzed target within 5 feet) or takes back: the attack's
 * damage gains a second set of every part's dice, or drops it; rolled dice stay, flat bonuses
 * count once. The d20 doesn't change.
 */
export function setCritical(attack: AttackDice, critical: boolean, dice: CriticalDice): AttackDice {
  if (attack.critical_hit === critical) return attack;
  return {
    ...attack,
    critical_hit: critical,
    damage: attack.damage ? recritical(attack.damage, critical, dice) : null,
  };
}
