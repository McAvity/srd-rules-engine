/**
 * What a combatant can do now (`combatantOptions`): each option is an encounter action ready to
 * send, with its cost, whether the engine would take it now and, if not, why. A computed result,
 * not a saved document.
 */

import { z } from "zod";
import { SpellAreaSchema } from "./content";
import { EncounterActionSchema } from "./encounter";
import { REFUSAL_CATEGORY_NAMES, REFUSAL_CODES } from "./events";
import { MessageSchema } from "./messages";

/**
 * One reason the engine would refuse an option now, with its category (`REFUSAL_CATEGORIES`), so
 * the client decides which ones it enforces (play by hand ignores `economy`, `turn`, `target`).
 */
export const OptionReasonSchema = z.object({
  code: z.enum(REFUSAL_CODES),
  category: z.enum(REFUSAL_CATEGORY_NAMES),
  text: z.string(),
  /** `text` as a message (for translation). */
  message: MessageSchema,
});
export type OptionReason = z.infer<typeof OptionReasonSchema>;

const reasonsField = {
  /**
   * Every reason the engine would refuse it now, not only the first (`[]` when available): each
   * refusal the GM could override, then the one that stops it, if any.
   */
  reasons: z.array(OptionReasonSchema).default([]),
  /**
   * It can be rolled by hand: `{ type: "roll", id, what }` takes it, its `resource` and `state`
   * reasons aside (Dash, a check or a zone can't).
   */
  rollable: z.boolean().default(false),
};

/**
 * What an option spends: an action, a Bonus Action or a reaction; `attack`, one of the Attack
 * action's attacks (the first takes the action); `free` (no economy: a granted attack, moving a
 * zone, a check); `movement`; a monster's `legendary` action use.
 */
export const OPTION_COSTS = [
  "action",
  "bonus_action",
  "reaction",
  "attack",
  "free",
  "movement",
  "legendary",
] as const;
export type OptionCost = (typeof OPTION_COSTS)[number];

/** Who or what an option is aimed at. */
export const TargetSpecSchema = z.object({
  /** `creature`: ids in `target`/`targets`; `area`: a point or direction (`area`); `point`: a square. */
  kind: z.enum(["creature", "area", "self", "point"]),
  /** The most creatures it can target (`null`: not limited, or not known). */
  count: z.int().min(1).nullable(),
  /** How far, in feet (reach, long range, a spell's range, movement left); `null`: not checked. */
  range: z.int().min(0).nullable(),
  /**
   * Candidate creatures, enemies first, then nearest first: with positions, only those within
   * `range`; creatures without a position are listed last (the engine doesn't measure them).
   */
  ids: z.array(z.string()),
  /** The area's shape, for `kind: area`. */
  area: SpellAreaSchema.nullable(),
});
export type TargetSpec = z.infer<typeof TargetSpecSchema>;

/**
 * A Cunning Strike or Brutal Strike effect an attack option can carry (SRD Rogue "Cunning
 * Strike", Barbarian "Brutal Strike"): send `action` (the attack with the effect, and the Sneak
 * Attack rider for Cunning Strike), or add `id` to the attack's `cunning` / `brutal` list.
 */
export const StrikeOptionSchema = z.object({
  /** Which list it goes in on the attack action. */
  send: z.enum(["cunning", "brutal"]),
  /** `trip`, `hamstring`. */
  id: z.string(),
  /** `Trip`, `Hamstring Blow`. */
  name: z.string(),
  /** What it costs: Sneak Attack dice forgone (`1d6`), or Reckless Attack's Advantage. */
  cost: z.string(),
  /** `cost` as a message (for translation). */
  cost_message: MessageSchema,
  /** Sneak Attack dice it forgoes (Cunning Strike); 0 for Brutal Strike. */
  sneak_attack_dice: z.int().min(0),
  /** The attack action with this effect, ready to send. */
  action: EncounterActionSchema,
  /** The engine would take `action` now (a dry run); why not, in its words and as a code. */
  available: z.boolean(),
  reason: z.string().nullable(),
  code: z.enum(REFUSAL_CODES).nullable().default(null),
  /** `reason` as a message (for translation). */
  reason_message: MessageSchema.nullable().default(null),
  ...reasonsField,
});
export type StrikeOption = z.infer<typeof StrikeOptionSchema>;

export const OptionEntrySchema = z.object({
  /**
   * The encounter action to send. Its target is the first candidate (`targets.ids[0]`), or `""`
   * when there's none; an area spell has `targets: []` (send `area` instead to place it).
   */
  action: EncounterActionSchema,
  /** `Longsword +5 · 1d8+3 slashing`, `Fireball (level 3)`, `Second Wind`. */
  label: z.string(),
  /** `label` as a message (for translation). */
  label_message: MessageSchema,
  cost: z.enum(OPTION_COSTS),
  /** The engine would take `action` now (a dry run with fixed dice: `checkAction`). */
  available: z.boolean(),
  /** Why not, in the engine's words; `null` when available. */
  reason: z.string().nullable(),
  /** Why not, as a code (`REFUSAL_CODES`); `null` when available. */
  code: z.enum(REFUSAL_CODES).nullable().default(null),
  /** Why not, as a message (for translation); `null` when available. */
  reason_message: MessageSchema.nullable().default(null),
  ...reasonsField,
  targets: TargetSpecSchema.nullable(),
  /** A spell: the slot levels it can be cast with now (empty for a cantrip). */
  slot_levels: z.array(z.int()).default([]),
  /** A spell: the level of a Pact Magic slot it can use now (`pact: true`), if any. */
  pact_slot: z.int().nullable().default(null),
  /** Limited uses left (a feature's, a monster's daily uses, legendary uses this round). */
  uses: z.object({ left: z.int(), max: z.int() }).nullable().default(null),
  /**
   * The odds against its first candidate target (`target`), from the same modifiers the engine
   * would use (Advantage, cover, conditions): the chance to hit and to score a Critical Hit, or
   * that the target fails its save, and the average damage it would take (crits, a save's half
   * damage and its defenses included; features' extra dice left out). `null` when it has none.
   */
  odds: z
    .object({
      target: z.string(),
      hit: z.number().min(0).max(1).nullable(),
      critical: z.number().min(0).max(1).nullable(),
      fail_save: z.number().min(0).max(1).nullable(),
      average_damage: z.number().min(0).nullable(),
    })
    .nullable()
    .default(null),
  /** Something to know before choosing it ("Casting it ends Concentration on Bless"). */
  note: z.string().nullable().default(null),
  /** `note` as a message (for translation). */
  note_message: MessageSchema.nullable().default(null),
  /**
   * An attack: the Cunning Strike / Brutal Strike effects its attacker has, each judged on its own
   * (at level 11 or 17 two can go on one attack: merge their lists).
   */
  strikes: z.array(StrikeOptionSchema).default([]),
});
export type OptionEntry = z.infer<typeof OptionEntrySchema>;

export const CombatantOptionsSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** It's this combatant's turn. */
    turn: z.boolean(),
    /** What it hasn't spent yet (the action and Bonus Action are only usable on its turn). */
    economy: z.object({
      action: z.boolean(),
      bonus_action: z.boolean(),
      reaction: z.boolean(),
      /** Feet of movement left this turn (its Speed, plus Dash, minus what it moved). */
      movement: z.int().min(0),
      /** Attacks left in the Attack action it took (Extra Attack, Multiattack). */
      attacks_left: z.int().min(0),
      /** Attacks a feature granted this turn (Flurry of Blows). */
      granted: z.object({ attack: z.string(), count: z.int() }).nullable(),
      /** A Cleave attack it can make (the weapon and the creature it hit). */
      cleave: z.object({ attack: z.string(), target: z.string() }).nullable(),
      /** A monster's legendary action uses left until the start of its turn. */
      legendary: z.object({ left: z.int(), max: z.int() }).nullable(),
    }),
    /** One per attack line, and its variants: thrown, Opportunity Attack, Light, Cleave, granted. */
    attacks: z.array(OptionEntrySchema),
    /** Spells it can cast: a character's cantrips and prepared spells, a monster's listed spells. */
    spells: z.array(OptionEntrySchema),
    /** A character's features used in turns (`sheet.actions`). */
    features: z.array(OptionEntrySchema),
    /** A monster's saving throw effects (`save_action`). */
    save_actions: z.array(OptionEntrySchema),
    /** A monster's legendary actions. */
    legendary: z.array(OptionEntrySchema),
    /** Dash, Disengage, Dodge, Help, Grapple, Shove, escape, stand up, move. */
    standard: z.array(OptionEntrySchema),
    /** The zones it created: move or end them. */
    zones: z.array(OptionEntrySchema),
  })
  .meta({ id: "CombatantOptions" });
export type CombatantOptions = z.infer<typeof CombatantOptionsSchema>;

/** The result of `checkAction`: the engine would take the action, or why not. */
export const ActionCheckSchema = z.object({
  ok: z.boolean(),
  reasons: z.array(z.string()),
  /** A code per reason (`REFUSAL_CODES`). */
  codes: z.array(z.enum(REFUSAL_CODES)),
  /** `reasons` as messages (for translation). */
  reason_messages: z.array(MessageSchema).default([]),
  /**
   * Only with `force: true`: the refusals the GM would override (`ok` is then true), as messages,
   * and their codes (`FORCEABLE_REFUSALS`).
   */
  overrides: z.array(MessageSchema).optional(),
  override_codes: z.array(z.enum(REFUSAL_CODES)).optional(),
});
export type ActionCheck = z.infer<typeof ActionCheckSchema>;
