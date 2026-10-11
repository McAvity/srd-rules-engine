/**
 * What an encounter action changed, as data (`EncounterResult.events`), for a UI to animate and
 * log: worked out by comparing the encounter and the character states before and after it, so
 * it covers every change whatever caused it. Notes stay the readable account.
 */

import { z } from "zod";
import { MessageSchema } from "./messages";

const square = z.object({ x: z.int(), y: z.int() });

export const EncounterEventSchema = z
  .discriminatedUnion("type", [
    /** A new round or turn started. */
    z.object({ type: z.literal("turn"), round: z.int(), id: z.string() }),
    z.object({ type: z.literal("fight_ended") }),
    z.object({ type: z.literal("joined"), id: z.string() }),
    z.object({ type: z.literal("left"), id: z.string() }),
    z.object({ type: z.literal("initiative"), id: z.string(), value: z.int().nullable() }),
    /** Moved or placed: from where to where (`null`: not on the grid). */
    z.object({
      type: z.literal("moved"),
      id: z.string(),
      from: square.nullable(),
      to: square.nullable(),
      feet: z.int().min(0),
    }),
    /** Hit Points and Temporary Hit Points before and after (damage or healing). */
    z.object({
      type: z.literal("hp"),
      id: z.string(),
      from: z.int(),
      to: z.int(),
      temp_from: z.int(),
      temp_to: z.int(),
    }),
    z.object({ type: z.literal("condition_added"), id: z.string(), condition: z.string() }),
    z.object({ type: z.literal("condition_removed"), id: z.string(), condition: z.string() }),
    /** A monster defeated, a character dead, down at 0 HP, or stable. */
    z.object({
      type: z.literal("status"),
      id: z.string(),
      status: z.enum(["defeated", "dead", "down", "stable", "up"]),
    }),
    z.object({
      type: z.literal("concentration"),
      id: z.string(),
      spell: z.string().nullable(),
      previous: z.string().nullable(),
    }),
    /** The action economy spent: action, Bonus Action, reaction. */
    z.object({
      type: z.literal("used"),
      id: z.string(),
      what: z.enum(["action", "bonus_action", "reaction"]),
    }),
    /** A character's resources spent or regained: spell slots (by level), Pact Magic, uses. */
    z.object({
      type: z.literal("resource"),
      id: z.string(),
      resource: z.string(),
      spent_from: z.int(),
      spent_to: z.int(),
    }),
    z.object({
      type: z.literal("effect_added"),
      effect: z.string(),
      target: z.string(),
      condition: z.string(),
      label: z.string(),
    }),
    z.object({ type: z.literal("effect_ended"), effect: z.string(), target: z.string() }),
    z.object({ type: z.literal("zone_added"), zone: z.string(), label: z.string() }),
    z.object({ type: z.literal("zone_moved"), zone: z.string(), to: square.nullable() }),
    z.object({ type: z.literal("zone_ended"), zone: z.string() }),
    /** The map changed (walls, terrain). */
    z.object({ type: z.literal("map") }),
    /** The action stopped for a decision (`encounter.pending`). */
    z.object({
      type: z.literal("pending"),
      combatant: z.string(),
      kind: z.string(),
      question: z.string(),
      question_message: MessageSchema.optional(),
    }),
  ])
  .meta({ id: "EncounterEvent" });
export type EncounterEvent = z.infer<typeof EncounterEventSchema>;

/**
 * Why the engine refused an action, as a code a UI can act on (the message says it in words).
 * `refused` covers the rest.
 */
export const REFUSAL_CODES = [
  "pending_decision",
  /** Outside a fight, every move waits on a noticed point (`notice_stops: everyone`). */
  "halted",
  "not_started",
  "not_your_turn",
  "incapacitated",
  "defeated",
  "economy_used",
  "no_attacks_left",
  "once_per_turn",
  "out_of_range",
  /** With `positions: required`, the actor or a target isn't on a map in use. */
  "off_map",
  "total_cover",
  /** No creature to aim it at (an option with no candidate, or none within its range). */
  "no_target",
  "no_path",
  "no_movement",
  "no_resources",
  "unknown",
  "incomplete",
  "refused",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/**
 * What a refusal is about, so a client can choose which ones to enforce (play by hand ignores
 * `economy`, `turn` and `target`): the action economy; whose turn it is and the fight's flow; the
 * target, its range, cover and the map; movement; resources (slots, uses, Recharge); the actor's
 * own state (Incapacitated, defeated); missing or unknown input; anything else.
 */
export const REFUSAL_CATEGORY_NAMES = [
  "economy",
  "turn",
  "target",
  "movement",
  "resource",
  "state",
  "input",
  "other",
] as const;
export type RefusalCategory = (typeof REFUSAL_CATEGORY_NAMES)[number];

/** Each refusal code's category. */
export const REFUSAL_CATEGORIES: Readonly<Record<RefusalCode, RefusalCategory>> = {
  pending_decision: "turn",
  halted: "turn",
  not_started: "turn",
  not_your_turn: "turn",
  incapacitated: "state",
  defeated: "state",
  economy_used: "economy",
  no_attacks_left: "economy",
  once_per_turn: "economy",
  out_of_range: "target",
  off_map: "target",
  total_cover: "target",
  no_target: "target",
  no_path: "movement",
  no_movement: "movement",
  no_resources: "resource",
  unknown: "input",
  incomplete: "input",
  refused: "other",
};
/**
 * The refusals a GM can override with `force: true` on an action: legality (turn, economy, range,
 * movement, resources). The rest (unknown ids, missing input, a defeated creature, no path) still
 * refuse.
 */
export const FORCEABLE_REFUSALS = [
  "not_your_turn",
  "incapacitated",
  "economy_used",
  "no_attacks_left",
  "once_per_turn",
  "out_of_range",
  "off_map",
  "no_movement",
  "no_resources",
] as const satisfies readonly RefusalCode[];
