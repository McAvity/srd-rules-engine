/**
 * Play state: what changes at the table, kept apart from the build (the character's
 * characteristics). A state belongs to one build and is checked against it; changing the build
 * (a level-up, an override edit) doesn't touch the state, and `reconcileState` fixes up anything
 * that no longer fits.
 */

import { z } from "zod";
import { CUSTOM_STATE_VERSION, STORED_STATE_VERSION, StateVersionSchema } from "./version";

/** Limits of a custom item (kenli F-011 contracts/changes.md §6.1). */
export const CUSTOM_ITEM_LIMITS = { name: 120, description: 4000 } as const;
const codePoints = (s: string) => [...s].length;

/**
 * A custom item: not in the catalog (an heirloom, a found trinket, an unidentified thing). The
 * table writes its name, a plain-text description and its weight, `null` when unknown (never read
 * as 0). It has no rules: it is never worn, attuned to, charged, priced or attacked with.
 */
export const CustomItemSchema = z.strictObject({
  /** Trimmed, 1–120 characters. */
  name: z
    .string()
    .refine(
      (v) => v === v.trim() && codePoints(v) >= 1 && codePoints(v) <= CUSTOM_ITEM_LIMITS.name,
      {
        error: `a custom item's name is 1–${CUSTOM_ITEM_LIMITS.name} characters, without spaces around it`,
      },
    ),
  /** Plain text (never markup), up to 4000 characters. */
  description: z.string().refine((v) => codePoints(v) <= CUSTOM_ITEM_LIMITS.description, {
    error: `a custom item's description is at most ${CUSTOM_ITEM_LIMITS.description} characters`,
  }),
  /** Pounds for one; `null`: unknown (not counted, and not taken for 0). */
  weight_lb: z
    .number()
    .refine((v) => Number.isFinite(v) && v >= 0, { error: "a weight is a finite number ≥ 0" })
    .nullable(),
});
export type CustomItem = z.infer<typeof CustomItemSchema>;

/** The keys a custom line may have (`item: null`); any other one is refused, never dropped. */
const CUSTOM_LINE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "item",
  "custom",
  "base",
  "variant",
  "qty",
  "equipped",
  "attuned",
  "charges_spent",
  "notes",
  "location",
]);

/**
 * A custom line is strict (kenli F-011, review03 R03-01): Zod's object drops unknown keys before a
 * refinement sees them, so they are checked here, on the raw line, first. A catalog line is not
 * looked at: it keeps its old reading (unknown keys dropped, the same errors, v1/v2 bytes).
 */
function refuseUnknownCustomKeys(raw: unknown, ctx: z.core.$RefinementCtx): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const line = raw as Record<string, unknown>;
  if (line.item !== null) return raw;
  const unknown = Object.keys(line).filter((k) => !CUSTOM_LINE_KEYS.has(k));
  if (unknown.length)
    ctx.addIssue({
      code: "unrecognized_keys",
      keys: unknown,
      input: line,
      message: `Unrecognized key${unknown.length > 1 ? "s" : ""}: ${unknown.map((k) => `"${k}"`).join(", ")}`,
    });
  return raw;
}

const ItemObjectSchema = z
  .object({
    /** Stable id within this state's inventory (`i1`, `i2`…). */
    id: z.string(),
    /**
     * A catalog item: a weapon, armor, gear, tool, or magic item id; `null` for a custom item, which
     * has `custom` instead (kenli F-011).
     */
    item: z.string().nullable(),
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
    /**
     * Put away, not on the character (left at camp, in a bag of holding at home…): still owned,
     * but not carried (no weight), no attack line and its magic inactive; it can't be equipped
     * or used until it's taken back (the `store` action). Missing means carried; never written
     * for a carried item, so existing states keep their bytes. A state with one is version 2.
     */
    location: z.literal("stored").optional(),
    /**
     * A custom item's name, description and weight (with `item: null`). Never on a catalog item; a
     * custom item is never equipped, attuned or charged and has no base, kind or notes of its own. A
     * state with one is version 3.
     */
    custom: CustomItemSchema.optional(),
  })
  .superRefine((i, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message, input: i });
    if (i.item === null && !i.custom) issue("an item without a catalog id needs its custom fields");
    if (i.item !== null && i.custom) issue("a catalog item can't have custom fields");
    if (i.custom) {
      if (i.base !== null || i.variant !== null) issue("a custom item has no base or kind");
      if (i.equipped || i.attuned || i.charges_spent !== 0)
        issue("a custom item is never worn, attuned or charged");
      if (i.notes !== "") issue("a custom item's text is its description, not notes");
    }
  });
/** An inventory line: a catalog item, or a custom one (`item: null`, strict). */
export const ItemInstanceSchema = z.preprocess(refuseUnknownCustomKeys, ItemObjectSchema);
export type ItemInstance = z.infer<typeof ItemObjectSchema>;

export const CURRENCIES = ["cp", "sp", "ep", "gp", "pp"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const CharacterStateSchema = z.object({
  /**
   * The document format: 1, or 2 when an item is stored (`stateVersion`; `parseState` sets it).
   * Missing means 1.
   */
  version: StateVersionSchema,
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
  return {
    ...state,
    version: stateVersion(state),
    starting_equipment: startingEquipmentTaken(state),
  };
}

/**
 * The format a state is written in: 3 if it has a custom item (an older engine must refuse it,
 * not drop the item), 2 if an item is stored (not read as carried), else 1. `parseState`, and so
 * every action, sets it.
 */
export function stateVersion(state: Pick<CharacterState, "inventory">): 1 | 2 | 3 {
  if (state.inventory.some((i) => i.custom)) return CUSTOM_STATE_VERSION;
  return state.inventory.some((i) => i.location === "stored") ? STORED_STATE_VERSION : 1;
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
    /**
     * A custom item (kenli F-011): its name (trimmed), plain-text description and weight in pounds
     * (`null`: unknown). Always a new line, never merged with one of the same name.
     */
    z.object({
      type: z.literal("add_custom_item"),
      name: z.string(),
      description: z.string(),
      weight_lb: z.number().nullable(),
      qty: n.min(1).optional(),
    }),
    z.object({ type: z.literal("remove_item"), id, qty: n.min(1).optional() }),
    /**
     * Put the build's starting equipment (worn armor and Shield equipped) and gold in the
     * inventory, once: for a state made before the build had its equipment.
     */
    z.object({ type: z.literal("take_starting_equipment") }),
    z.object({ type: z.literal("equip"), id, equipped: z.boolean() }),
    /**
     * Put an item away (`stored: true`: still owned, not carried; take it off first) or take it
     * back (`stored: false`). A stored item can't be equipped, attuned to or used.
     */
    z.object({ type: z.literal("store"), id, stored: z.boolean() }),
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
