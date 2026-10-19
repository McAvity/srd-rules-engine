/**
 * Play state: what changes at the table, kept apart from the build (the character's
 * characteristics). A state belongs to one build and is checked against it; changing the build
 * (a level-up, an override edit) doesn't touch the state, and `reconcileState` fixes up anything
 * that no longer fits.
 */

import { z } from "zod";
import { DocumentVersionSchema } from "./version";

export const ItemInstanceSchema = z.object({
  /** Stable id within this state's inventory (`i1`, `i2`…). */
  id: z.string(),
  /** A catalog item: a weapon, armor, gear, tool, or magic item id. */
  item: z.string(),
  /** For a magic item made from a mundane one (Weapon, +1): which one (`longsword`). */
  base: z.string().nullable().default(null),
  /** For a magic item with kinds (Ring of Resistance): which one (`fire`). */
  variant: z.string().nullable().default(null),
  qty: z.int().min(1).default(1),
  /** Worn or held. */
  equipped: z.boolean().default(false),
  attuned: z.boolean().default(false),
  charges_spent: z.int().min(0).default(0),
  notes: z.string().default(""),
});
export type ItemInstance = z.infer<typeof ItemInstanceSchema>;

export const CURRENCIES = ["cp", "sp", "ep", "gp", "pp"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const CharacterStateSchema = z.object({
  /** The document format (`DOCUMENT_VERSION`); missing means 1. */
  version: DocumentVersionSchema,
  hp: z
    .object({
      /** Current Hit Points; `null` means at the maximum (it follows the maximum if it changes). */
      current: z.int().min(0).nullable().default(null),
      temp: z.int().min(0).default(0),
    })
    .prefault({}),
  /** Spent Hit Point Dice by die size: `{ "10": 2 }`. */
  hit_dice_spent: z.record(z.string(), z.int().min(0)).default({}),
  death_saves: z
    .object({
      successes: z.int().min(0).max(3).default(0),
      failures: z.int().min(0).max(3).default(0),
    })
    .prefault({}),
  stable: z.boolean().default(false),
  dead: z.boolean().default(false),
  exhaustion: z.int().min(0).max(6).default(0),
  /** Condition ids (Exhaustion is `exhaustion`, above). */
  conditions: z.array(z.string()).default([]),
  /** The spell or effect you're concentrating on. */
  concentration: z.string().nullable().default(null),
  /** Toggles switched on (`barbarian:rage`): their grants apply while active. */
  active: z.array(z.string()).default([]),
  heroic_inspiration: z.boolean().default(false),
  /** Spent spell slots per spell level: `[1, 0, 2]`. */
  spell_slots_spent: z.array(z.int().min(0)).default([]),
  pact_slots_spent: z.int().min(0).default(0),
  /** Spent uses of limited features by key (`barbarian:rage`). */
  uses_spent: z.record(z.string(), z.int().min(0)).default({}),
  /**
   * Today's picks for choices you can change after a rest (Cleric prepared spells, Weapon
   * Mastery…), by choice key. They replace the build's starting picks while playing.
   */
  choices: z.record(z.string(), z.array(z.string())).default({}),
  inventory: z.array(ItemInstanceSchema).default([]),
  currency: z
    .object({
      cp: z.int().min(0).default(0),
      sp: z.int().min(0).default(0),
      ep: z.int().min(0).default(0),
      gp: z.int().min(0).default(0),
      pp: z.int().min(0).default(0),
    })
    .prefault({}),
  /** Next inventory id number. */
  next_item: z.int().min(1).default(1),
  /**
   * Whether the build's starting equipment and gold are in the inventory (`createState` on a
   * finished build, or the `take_starting_equipment` action later). Missing in states saved
   * before it existed: `parseState` reads them as taken when the inventory or the purse isn't
   * empty (see `startingEquipmentTaken`).
   */
  starting_equipment: z.boolean().optional(),
});
export type CharacterState = z.infer<typeof CharacterStateSchema>;

/** Parse a state, e.g. one loaded from JSON. Throws a `ZodError` if invalid. */
export function parseState(input: unknown): CharacterState {
  const state = CharacterStateSchema.parse(input);
  return { ...state, starting_equipment: startingEquipmentTaken(state) };
}

/**
 * Whether the starting equipment was taken. A state from before `starting_equipment` existed
 * has it if anything is in the inventory or the purse (`createState` always put it there).
 */
export function startingEquipmentTaken(state: CharacterState): boolean {
  return (
    state.starting_equipment ??
    (state.inventory.length > 0 || Object.values(state.currency).some((n) => n > 0))
  );
}

/** Maximum number of magic items a creature can be attuned to (SRD Rules Glossary). */
export const MAX_ATTUNED = 3;

const n = z.int();
const id = z.string();

/**
 * Everything that can happen to a character in play, as plain JSON. `applyAction` checks each
 * one against the build and the rules.
 */
export const PlayActionSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("damage"),
      /** One amount of one type… */
      amount: n.min(0).optional(),
      damage_type: z.string().optional(),
      /** …or several, each adjusted for its own type (a Flame Tongue hit: slashing and fire). */
      instances: z
        .array(z.object({ amount: n.min(0), type: z.string().nullable().optional() }))
        .optional(),
      critical: z.boolean().optional(),
    }),
    z.object({ type: z.literal("heal"), amount: n.min(0) }),
    z.object({ type: z.literal("set_hp"), current: n.min(0) }),
    z.object({ type: z.literal("set_temp_hp"), amount: n.min(0), replace: z.boolean().optional() }),
    /** Omit `roll` to roll the d20. */
    z.object({ type: z.literal("death_save"), roll: n.min(1).max(20).optional() }),
    z.object({ type: z.literal("stabilize") }),
    /** Hit Point Dice to spend, one entry per die; omit `roll` to roll it. */
    z.object({
      type: z.literal("short_rest"),
      hit_dice: z.array(z.object({ die: n, roll: n.min(1).optional() })).optional(),
    }),
    z.object({ type: z.literal("long_rest") }),
    z.object({ type: z.literal("spend_slot"), level: n.min(1).max(9) }),
    z.object({ type: z.literal("restore_slot"), level: n.min(1).max(9) }),
    z.object({ type: z.literal("spend_pact_slot") }),
    z.object({ type: z.literal("restore_pact_slot") }),
    /** A limited-use feature by its key (see the play sheet's `uses`). */
    z.object({ type: z.literal("use"), key: z.string(), amount: n.min(1).optional() }),
    z.object({ type: z.literal("restore_use"), key: z.string(), amount: n.min(1).optional() }),
    /**
     * Use a feature (`sheet.actions`: `fighter:second-wind`): spends its resource (`amount` for a
     * pool like Lay on Hands) and, for one that heals you (Second Wind), rolls and heals. Its other
     * effects need an encounter (`feature`).
     */
    z.object({
      type: z.literal("use_feature"),
      key: z.string(),
      amount: n.min(1).optional(),
      /** Spend its uses only: what it heals is the table's (manual play). */
      manual: z.boolean().optional(),
      /**
       * A spell slot paying for it (`slot_payment`): instead of its uses (`instead`), or the slot
       * it always takes (`required`, Font of Inspiration).
       */
      payment: z
        .discriminatedUnion("type", [
          z.object({ type: z.literal("slot"), level: n.min(1).max(9) }),
          z.object({ type: z.literal("pact") }),
        ])
        .optional(),
      /** The GM overrides a refusal of legality (Incapacitated): the feature is used anyway. */
      force: z.boolean().optional(),
    }),
    z.object({ type: z.literal("add_condition"), condition: id }),
    z.object({ type: z.literal("remove_condition"), condition: id }),
    z.object({ type: z.literal("set_exhaustion"), level: n.min(0).max(6) }),
    z.object({ type: z.literal("set_concentration"), spell: z.string().nullable() }),
    z.object({ type: z.literal("set_inspiration"), value: z.boolean() }),
    /** Spend Heroic Inspiration (to reroll a die): refused without it. */
    z.object({ type: z.literal("spend_inspiration") }),
    /** Switch a toggle on (spending its use) or off: `barbarian:rage`. */
    z.object({ type: z.literal("activate"), key: z.string() }),
    z.object({ type: z.literal("deactivate"), key: z.string() }),
    /** Today's picks for a choice you can change after a rest (prepared spells…). */
    z.object({ type: z.literal("set_choice"), key: z.string(), values: z.array(id) }),
    /** Go back to the build's picks. */
    z.object({ type: z.literal("reset_choice"), key: z.string() }),
    z.object({
      type: z.literal("add_item"),
      item: id,
      qty: n.min(1).optional(),
      base: id.optional(),
      variant: id.optional(),
    }),
    z.object({ type: z.literal("remove_item"), id, qty: n.min(1).optional() }),
    /**
     * Put the build's starting equipment (worn armor and Shield equipped) and gold in the
     * inventory, once: for a state made before the build had its equipment.
     */
    z.object({ type: z.literal("take_starting_equipment") }),
    z.object({ type: z.literal("equip"), id, equipped: z.boolean() }),
    z.object({ type: z.literal("attune"), id, attuned: z.boolean() }),
    /** Drink a potion, spend a charge… `roll` overrides the healing roll. */
    z.object({ type: z.literal("use_item"), id, roll: n.min(0).optional() }),
    z.object({ type: z.literal("set_charges"), id, spent: n.min(0) }),
    /**
     * Buy an item at its price (`qty` times its bundle: 20 Arrows for 1 GP), paying from the coins
     * with change; `price` overrides it (`"40 GP"`: a deal, or an item without a listed price).
     */
    z.object({
      type: z.literal("buy"),
      item: id,
      qty: n.min(1).optional(),
      price: z.string().optional(),
      base: id.optional(),
      variant: id.optional(),
    }),
    /** Sell an inventory entry (or `qty` of it) for half its price (SRD "Selling Equipment"). */
    z.object({
      type: z.literal("sell"),
      id,
      qty: n.min(1).optional(),
      price: z.string().optional(),
    }),
    z.object({
      type: z.literal("adjust_currency"),
      changes: z.partialRecord(z.enum(CURRENCIES), n),
    }),
  ])
  .meta({ id: "PlayAction" });
export type PlayAction = z.infer<typeof PlayActionSchema>;
