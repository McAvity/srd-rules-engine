/**
 * An encounter: combatants in initiative order, the round and whose turn it is, and what each has
 * spent this turn. A saved document of its own, like `CharacterState`.
 *
 * Characters are referenced by a key into the caller's characters (build + state): their HP and
 * conditions stay in their `CharacterState`. Monsters live here, with their current HP and
 * conditions (the stat block in the catalog holds the rest).
 */

import { z } from "zod";
import { ABILITIES, DAMAGE_TYPES, SKILLS, SpellAreaSchema } from "./content";
import { MessageSchema } from "./messages";
import { PlayActionSchema } from "./state";
import { DocumentVersionSchema } from "./version";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lowercase slugs");

export const EncounterCombatantSchema = z.object({
  id,
  name: z.string(),
  /** Who's on whose side (`party`, `enemies`…): informational. */
  side: z.string().default(""),
  /** A monster's catalog id… */
  monster: z.string().nullable().default(null),
  /** …or the key of a character in the caller's `characters`. */
  character: z.string().nullable().default(null),
  /** The Initiative count; `null` until rolled. */
  initiative: z.int().nullable().default(null),
  /** Monsters only: current HP, Temporary HP and conditions. */
  hp: z.int().min(0).nullable().default(null),
  temp_hp: z.int().min(0).default(0),
  conditions: z.array(z.string()).default([]),
  /** A monster at 0 Hit Points (SRD "Monster Death"): skipped in the turn order. */
  defeated: z.boolean().default(false),
  /** Regeneration doesn't work at the start of its next turn (it took Acid or Fire damage). */
  regeneration_blocked: z.boolean().default(false),
  /** Spent this turn (the reaction until the start of its next turn). */
  used: z
    .object({
      action: z.boolean().default(false),
      bonus_action: z.boolean().default(false),
      reaction: z.boolean().default(false),
    })
    .prefault({}),
  /** Feet moved this turn, and extra movement from Dash. */
  moved: z.int().min(0).default(0),
  extra_movement: z.int().min(0).default(0),
  /** Attacks left in this turn's Attack action (Extra Attack). */
  attacks_left: z.int().min(0).default(0),
  /** Once-per-turn riders already used this turn (Sneak Attack), reset at every turn's start. */
  riders_used: z.array(z.string()).default([]),
  /** Abilities with a Recharge that were used and haven't recharged (`Fire Breath`). */
  expended: z.array(z.string()).default([]),
  /**
   * Monsters only: daily uses spent, by action name ("Divine Aid (2/Day)") and by
   * `<action>#<spell>` for a spell's own uses ("Spellcasting#fireball"). Not reset in the
   * encounter (no rests).
   */
  daily_used: z.record(z.string(), z.int().min(0)).default({}),
  /** Monsters only: what it's concentrating on. */
  concentration: z.string().nullable().default(null),
  /** Toggles (Rage) switched on this turn, and whether one was extended this turn. */
  toggled_on: z.array(z.string()).default([]),
  /** Rounds left of toggles with a duration (Rage: 100), counted at the start of its turns. */
  toggle_rounds: z.record(z.string(), z.int().min(0)).default({}),
  extended: z.boolean().default(false),
  /** Monsters only: in its lair (more legendary uses, when the stat block says so). */
  in_lair: z.boolean().default(false),
  /** Legendary action uses spent since the start of its last turn, and once-per-round ones taken. */
  legendary_used: z.int().min(0).default(0),
  legendary_taken: z.array(z.string()).default([]),
  /** Legendary Resistance uses spent, and whether it spends them automatically on a failed save. */
  legendary_resistance_used: z.int().min(0).default(0),
  auto_legendary_resistance: z.boolean().default(true),
  /** Took the Dodge action: its benefits last until the start of its next turn. */
  dodging: z.boolean().default(false),
  /** Took the Disengage action: its movement doesn't provoke Opportunity Attacks this turn. */
  disengaged: z.boolean().default(false),
  /** Light weapons it attacked with in this turn's Attack action (the Light property's extra attack). */
  light_attacks: z.array(z.string()).default([]),
  /** Made the Light property's extra attack as part of the Attack action this turn (Nick). */
  nick_used: z.boolean().default(false),
  /** A hit this turn that allows a Cleave attack (the weapon and the creature hit), until used. */
  cleave: z.object({ attack: z.string(), target: z.string() }).nullable().default(null),
  /** Made its Cleave attack this turn. */
  cleave_used: z.boolean().default(false),
  /** Took Action Surge this turn: its additional action can't be the Magic action. */
  surged: z.boolean().default(false),
  /** Attacks a feature granted this turn (Flurry of Blows), used with `attack` `granted: true`. */
  granted_attacks: z
    .object({ attack: z.string(), count: z.int().min(0) })
    .nullable()
    .default(null),
  /** Creatures it hit this turn (Stunning Strike needs a hit). */
  hits: z.array(z.string()).default([]),
  /** Its last hit this turn: a melee attack, a Critical Hit (Divine Smite rides it). */
  last_hit: z
    .object({ target: z.string(), melee: z.boolean(), critical: z.boolean() })
    .nullable()
    .default(null),
  /** Once-per-turn features used this turn. */
  features_used: z.array(z.string()).default([]),
  /**
   * Who makes its decisions (Bardic Inspiration, Legendary Resistance, Uncanny Dodge): `ask`
   * stops for an answer after the roll, `auto` takes the recommended choice; `null`: the
   * encounter's `decisions`.
   */
  decisions: z.enum(["ask", "auto"]).nullable().default(null),
  /**
   * Its square on a 5-foot grid (the top-left one, for a creature larger than Medium), or `null`
   * when positions aren't used: then the caller says what's within 5 feet or in range.
   */
  position: z.object({ x: z.int(), y: z.int() }).nullable().default(null),
  /**
   * Hidden (the Hide action): its Stealth check's total, the DC to find it with Perception; it has
   * the Invisible condition while hidden. `null`: not hidden.
   */
  hidden: z.int().nullable().default(null),
  /**
   * The Ready action: what triggers its reaction (the caller's to watch) and the action it takes
   * then (`release`), until the start of its next turn. `held`: a readied spell, cast already
   * (slot spent) and held with Concentration.
   */
  readied: z
    .object({
      trigger: z.string(),
      action: z.lazy(() => ReadiedActionSchema),
      held: z.boolean().default(false),
    })
    .nullable()
    .default(null),
  /** A Bardic Inspiration die it holds, and who gave it; used on its next failed D20 Test. */
  inspiration: z
    .object({ die: z.int().min(2), by: z.string() })
    .nullable()
    .default(null),
});
export type EncounterCombatant = z.infer<typeof EncounterCombatantSchema>;

/**
 * When a timed effect ends: at the start or end of the `count`-th turn of combatant `of` (from
 * now). "Until the end of its next turn" is `{ at: end, of: it, count: 1 }`; "1 minute" is
 * `{ at: start, of: the source, count: 10 }`.
 */
export const EffectEndSchema = z.object({
  at: z.enum(["start", "end"]),
  of: z.string(),
  count: z.int().min(1),
  /** Created during `of`'s own turn: that turn's end doesn't count. */
  skip_current: z.boolean().default(false),
});
export type EffectEnd = z.infer<typeof EffectEndSchema>;

/** A condition with a duration or tied to someone's Concentration (Hold Person). */
export const EncounterEffectSchema = z.object({
  id: z.string(),
  target: z.string(),
  condition: z.string(),
  /** What caused it: `Hold Person`. With `concentration`, the source's Concentration on it. */
  label: z.string(),
  source: z.string().nullable().default(null),
  concentration: z.boolean().default(false),
  ends: EffectEndSchema.nullable().default(null),
  /** A grapple: the DC of the `escape` check (Athletics or Acrobatics) that ends it. */
  escape_dc: z.int().nullable().default(null),
  /** The only skill the `escape` check can use (Black Tentacles: Athletics); `null`: either. */
  escape_skill: z.enum(["athletics", "acrobatics"]).nullable().default(null),
  /** It also ends when the target takes damage, or when its source is Incapacitated. */
  ends_on: z.array(z.enum(["damage", "source_incapacitated"])).default([]),
  /** The target repeats this save at the end of each of its turns, ending it on a success. */
  repeat_save: z
    .object({ ability: z.enum(ABILITIES), dc: z.int() })
    .nullable()
    .default(null),
});
export type EncounterEffect = z.infer<typeof EncounterEffectSchema>;

/**
 * The Help action's benefit, until it's used or the start of the helper's next turn: Advantage on
 * the next attack roll by one of `by`'s allies against `on` (no `skill`), or on `on`'s next check
 * with `skill`.
 */
export const HelpSchema = z.object({
  by: z.string(),
  on: z.string(),
  skill: z.enum(SKILLS).nullable().default(null),
});
export type Help = z.infer<typeof HelpSchema>;

/**
 * A Weapon Mastery's lasting effect, until used or `ends`: Vex (`by`'s next attack roll against
 * `on` has Advantage), Sap (`on`'s next attack roll has Disadvantage), Slow (`on`'s Speed −10 ft).
 */
export const MasteryMarkSchema = z.object({
  mastery: z.enum(["vex", "sap", "slow"]),
  by: z.string(),
  on: z.string(),
  ends: EffectEndSchema,
});
export type MasteryMark = z.infer<typeof MasteryMarkSchema>;

/**
 * A spell's lasting effect on `on`, until used or `ends`: `advantage_against` gives the next
 * attack roll against it Advantage, whoever makes it (Guiding Bolt).
 */
export const SpellMarkSchema = z.object({
  // `quarry`: `by`'s attack hits on `on` deal `damage` more, while `by` concentrates on `label`
  // (Hunter's Mark, Hex).
  /**
   * `speed_halved`: `on`'s Speed is halved (Stunning Strike's successful save); `hamstrung`: −15
   * feet (Hamstring Blow); `staggered`: Disadvantage on its next save, no Opportunity Attacks
   * (Staggering Blow); `sundered`: +5 to the next attack roll against it by someone else than
   * `by` (Sundering Blow).
   */
  kind: z.enum([
    "advantage_against",
    "speed_halved",
    "hamstrung",
    "staggered",
    "sundered",
    "quarry",
  ]),
  /** The spell's name: `Guiding Bolt`. */
  label: z.string(),
  by: z.string(),
  on: z.string(),
  /** `null` for a mark that lasts while `by` concentrates on `label`. */
  ends: EffectEndSchema.nullable(),
  damage: z.object({ dice: z.string(), type: z.string() }).nullable().default(null),
});
export type SpellMark = z.infer<typeof SpellMarkSchema>;

/**
 * A spell's area that lasts (Moonbeam, Spirit Guardians): creatures in it save again when they
 * enter it (or it moves onto them), or start or end their turn there (`triggers`). Its square
 * comes from `point`, or from its caster's space for an Emanation (`point: null`); without
 * positions, `zone_save` makes the creatures the caller names save.
 */
export const ZoneSchema = z.object({
  id: z.string(),
  /** The spell's id and name. */
  spell: z.string(),
  label: z.string(),
  by: z.string(),
  area: SpellAreaSchema,
  point: z.object({ x: z.int(), y: z.int() }).nullable().default(null),
  save: z
    .object({
      ability: z.enum(ABILITIES),
      on_success: z.enum(["half", "none"]),
      dc: z.int(),
    })
    .nullable(),
  damage: z
    .array(z.object({ dice: z.string().nullable(), bonus: z.int(), type: z.string() }))
    .default([]),
  /** Conditions on a failed save; `escape_dc`: an action's check against it ends one. */
  conditions: z.array(z.string()).default([]),
  escape_dc: z.int().nullable().default(null),
  escape_skill: z.enum(["athletics", "acrobatics"]).nullable().default(null),
  /** Conditions that end at the end of the creature's turn (Stinking Cloud's Poisoned). */
  until: z.enum(["end_of_its_turn"]).nullable().default(null),
  triggers: z.array(z.enum(["enter", "start_turn", "end_turn", "move"])),
  once_per_turn: z.boolean().default(true),
  /** The caster decides each time whether to force the save. */
  optional: z.boolean().default(false),
  /** An Emanation from `point` (not its caster): its space, in squares. */
  space: z.int().min(1).default(1),
  /** Its squares are Difficult Terrain (Web, Spike Growth). */
  difficult: z.boolean().default(false),
  /** A wall spell's squares (instead of its area), or the grid-line segments it stands on. */
  squares: z
    .array(z.object({ x: z.int(), y: z.int() }))
    .nullable()
    .default(null),
  segments: z
    .array(
      z.object({
        from: z.object({ x: z.int(), y: z.int() }),
        to: z.object({ x: z.int(), y: z.int() }),
      }),
    )
    .default([]),
  /** The wall's own squares, when the zone also reaches beyond them (Wall of Fire's side). */
  wall_squares: z.array(z.object({ x: z.int(), y: z.int() })).default([]),
  /** Lines through `wall_squares` get this cover (Blade Barrier: Three-Quarters). */
  cover: z.enum(["three_quarters", "total"]).nullable().default(null),
  /** Feet of movement per foot moved in its squares (Wall of Thorns: 4). */
  cost: z.int().min(1).default(1),
  /** Other creatures' Speed is halved in it (Spirit Guardians). */
  speed_halved: z.boolean().default(false),
  /** Its later triggers deal `damage` without a save (Wall of Fire). */
  no_save: z.boolean().default(false),
  /** `move_zone` onto a creature makes it save. */
  ram: z.boolean().default(false),
  on_fail: z.array(z.enum(["no_actions", "lose_concentration"])).default([]),
  /** Creatures the caster designated: the zone doesn't affect them. */
  unaffected: z.array(z.string()).default([]),
  /** It ends when its caster stops concentrating on `label`. */
  concentration: z.boolean().default(false),
  ends: EffectEndSchema.nullable().default(null),
  /** Creatures that saved against it this turn. */
  saved: z.array(z.string()).default([]),
});
export type Zone = z.infer<typeof ZoneSchema>;

/**
 * An action stopped for a decision: the action, the dice it rolled so far and the answers given;
 * `decide` replays it with the same dice and one more answer.
 */
export const PendingSchema = z.object({
  action: z.lazy(() => EncounterActionSchema),
  rolls: z.array(z.int()),
  answers: z.array(z.boolean()),
  /** Who decides, and what. */
  combatant: z.string(),
  kind: z.enum([
    "inspiration",
    "legendary_resistance",
    "uncanny_dodge",
    "zone_force",
    "indomitable",
    "deflect_attacks",
    "relentless_rage",
  ]),
  question: z.string(),
  /** `question` as a message (for translation); absent in documents saved before it. */
  question_message: MessageSchema.optional(),
  /** What `auto` would answer (only when it can turn the failure into a success). */
  recommended: z.boolean().default(true),
});
export type Pending = z.infer<typeof PendingSchema>;

const square = z.object({ x: z.int(), y: z.int() });

/**
 * The battlefield, on the 5-foot grid: walls between squares (segments between grid corners:
 * corner `x,y` is the top-left corner of square `x,y`), squares of Difficult Terrain, and squares
 * that can't be entered (a pillar, solid rock).
 */
export const BattleMapSchema = z.object({
  walls: z.array(z.object({ from: square, to: square })).default([]),
  difficult: z.array(square).default([]),
  blocked: z.array(square).default([]),
});
export type BattleMap = z.infer<typeof BattleMapSchema>;

/** What a point of interest is (an app picks its icon from it). */
export const POINT_KINDS = [
  "door",
  "trap",
  "puzzle",
  "detail",
  "fight",
  "room",
  "passage",
  "scene",
  "person",
  "treasure",
] as const;
export type PointKind = (typeof POINT_KINDS)[number];

/**
 * A point of interest: a place on the map the GM prepared (a door, a trap, a clue). The players
 * don't know it until the GM reveals it. With a `dc`, a character can notice it: within `within`
 * feet, with a clear line to its square (walls and blocked squares stop it), and a Passive
 * Perception of at least the DC; the engine adds it to `noticed_by` after a move or a placing,
 * for the GM to reveal it (or not).
 */
export const PointOfInterestSchema = z.object({
  id: z.string(),
  at: square,
  title: z.string().min(1),
  kind: z.enum(POINT_KINDS).default("detail"),
  /** What the players read or are told, once it's revealed. */
  text: z.string().default(""),
  /** The GM's own notes: secrets, what happens here, where it leads. */
  notes: z.string().default(""),
  revealed: z.boolean().default(false),
  /** Passive Perception that notices it (0: anyone who sees it); `null`: only the GM reveals it. */
  dc: z.int().min(0).nullable().default(null),
  /** How near a character must be to notice it, in feet. */
  within: z.int().min(0).default(30),
  /** Characters (combatant ids) that noticed it while it was hidden. */
  noticed_by: z.array(z.string()).default([]),
});
export type PointOfInterest = z.infer<typeof PointOfInterestSchema>;

export const EncounterSchema = z.object({
  /** The document format (`DOCUMENT_VERSION`); missing means 1. */
  version: DocumentVersionSchema,
  /** 0 before the fight starts. */
  round: z.int().min(0).default(0),
  /** Index into `order` of whose turn it is. */
  turn: z.int().min(0).default(0),
  /** Combatant ids in initiative order (set when the fight starts). */
  order: z.array(z.string()).default([]),
  combatants: z.array(EncounterCombatantSchema).default([]),
  /** Timed and Concentration effects in play. */
  effects: z.array(EncounterEffectSchema).default([]),
  /** Next effect id number. */
  next_effect: z.int().min(1).default(1),
  /** Help actions not used yet. */
  helps: z.array(HelpSchema).default([]),
  /** Weapon Mastery effects in play (Vex, Sap, Slow). */
  masteries: z.array(MasteryMarkSchema).default([]),
  /** Spell effects on the next attack roll against a creature (Guiding Bolt). */
  marks: z.array(SpellMarkSchema).default([]),
  /** Spell areas that last (Moonbeam, Spirit Guardians). */
  zones: z.array(ZoneSchema).default([]),
  /** Decisions after a roll: `ask` the combatant (or its player), or `auto` (the recommendation). */
  decisions: z.enum(["ask", "auto"]).default("auto"),
  /** An action waiting for a decision (`decide`); nothing else can happen until it's answered. */
  pending: z
    .preprocess(
      // Older documents: a stop for dice rolled at the table (no longer supported) is dropped.
      (p) => ((p as { kind?: unknown } | null | undefined)?.kind === "roll" ? null : p),
      PendingSchema.nullable(),
    )
    .default(null),
  /** Roll a dying character's Death Saving Throw at the start of its turn (else just a reminder). */
  auto_death_saves: z.boolean().default(true),
  /** Walls and terrain on the grid (positions only). */
  map: BattleMapSchema.prefault({}),
  /** Points of interest on the map (`add_point`). */
  points: z.array(PointOfInterestSchema).default([]),
  /** Next point id number. */
  next_point: z.int().min(1).default(1),
  /**
   * Outside a fight, the group's travel pace (SRD "Travel Pace"): Fast gives Disadvantage on
   * Wisdom (Perception) checks (−5 to Passive Perception), Slow gives Advantage (+5).
   */
  pace: z.enum(["fast", "normal", "slow"]).default("normal"),
  /**
   * When a character notices a hidden point while moving, the GM's choice: `noticer` stops that
   * character on the square where it noticed; `everyone` also halts every move (`halted`) until
   * the GM reveals the point or `resume`s.
   */
  notice_stops: z.enum(["noticer", "everyone"]).default("noticer"),
  /** The point every move waits on (`notice_stops: everyone`), until revealed or resumed. */
  halted: z.string().nullable().default(null),
  /**
   * The GM's setting for creatures off the map: `optional`, a distance with an unplaced creature
   * is unknown and passes; `required`, once anyone is on the map, an action that checks reach or
   * range is refused when the actor or a target has no position.
   */
  positions: z.enum(["optional", "required"]).default("optional"),
});
export type Encounter = z.infer<typeof EncounterSchema>;

export function parseEncounter(input: unknown): Encounter {
  return EncounterSchema.parse(input);
}

const n = z.int();
/**
 * `force` on an action taken in turns: the GM overrides a refusal of legality
 * (`FORCEABLE_REFUSALS`: turn, economy, range, movement, resources); the action applies, a cost
 * that can't be paid isn't spent, and the log notes each override (`override.applied`).
 */
const force = z.boolean().optional();
export const ECONOMY = ["action", "bonus_action", "reaction"] as const;

const mode = z.enum(["normal", "advantage", "disadvantage"]).optional();
const dice = z.string().regex(/^[1-9]\d*d[1-9]\d*$/, "dice like 1d4");

/**
 * Additions to a D20 Test or an attack rolled by hand that the table (the GM) gives: more reasons
 * for Advantage or Disadvantage, a mode that replaces the computed one, flat modifiers and dice
 * added to the d20's total, and for an attack, flat damage (once) and damage dice (doubled on a
 * Critical Hit). Each is listed in the result with its label.
 */
export const DmOptionsSchema = z
  .strictObject({
    modes: z
      .array(z.strictObject({ mode: z.enum(["advantage", "disadvantage"]), label: z.string() }))
      .optional(),
    mode_override: z
      .strictObject({ mode: z.enum(["normal", "advantage", "disadvantage"]), reason: z.string() })
      .optional(),
    modifiers: z.array(z.strictObject({ value: n, label: z.string() })).optional(),
    bonus_dice: z
      .array(
        z.strictObject({
          dice,
          label: z.string(),
          sign: z.union([z.literal(1), z.literal(-1)]).optional(),
        }),
      )
      .optional(),
    damage_modifiers: z.array(z.strictObject({ value: n, label: z.string() })).optional(),
    damage_bonus_dice: z
      .array(z.strictObject({ dice, type: z.enum(DAMAGE_TYPES), label: z.string() }))
      .optional(),
  })
  .meta({ id: "DmOptions" });
export type DmOptions = z.infer<typeof DmOptionsSchema>;

/** How a spell rolled by hand is paid: a slot (the default), a free cast's use, or as a ritual. */
export const SpellPaymentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("slot") }),
  z.object({ type: z.literal("free"), use: z.string() }),
  z.object({ type: z.literal("ritual") }),
]);
export type SpellPayment = z.infer<typeof SpellPaymentSchema>;

/** A spell slot paying for a feature (`slot_payment`): one of a level, or the Pact Magic slot. */
export const SlotPaymentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("slot"), level: n.min(1).max(9) }),
  z.object({ type: z.literal("pact") }),
]);
export type SlotPayment = z.infer<typeof SlotPaymentSchema>;

/**
 * What's rolled by hand (`rollByHand`, the encounter's `roll` action): an attack, a Grapple or
 * Shove, a spell, a feature, a saving throw effect or a legendary action, with the fields of the
 * action that would take it, less its target, area and economy.
 */
export const RollWhatSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("attack"),
      attack: z.string(),
      mode,
      two_handed: z.boolean().optional(),
      riders: z.array(z.object({ rider: z.string(), type: z.string().optional() })).optional(),
      light_extra: z.boolean().optional(),
      cleave: z.boolean().optional(),
      /** Cunning Strike effects, paid with Sneak Attack dice (needs the `sneak-attack` rider). */
      cunning: z.array(z.enum(["poison", "trip", "withdraw"])).optional(),
      /** Brutal Strike effects: Advantage forgone while Reckless, for 1d10 and an effect. */
      brutal: z.array(z.enum(["forceful", "hamstring", "staggering", "sundering"])).optional(),
      /** The GM's additions to this attack (`DmOptions`). */
      dm: DmOptionsSchema.optional(),
    }),
    /** The DC only: the target picks Strength or Dexterity, unless `save` gives it. */
    z.object({
      type: z.literal("unarmed"),
      option: z.enum(["grapple", "shove"]),
      save: z.enum(["str", "dex"]).optional(),
    }),
    z.object({
      type: z.literal("cast"),
      spell: z.string(),
      /** A monster's action that casts it, when several do. */
      via: z.string().optional(),
      /**
       * A character's spellcasting feature to cast it with (`SpellLine.spellcasting`, e.g. `Bard`); by default the one
       * the spell's feature gives when there's one, else the best on whose list it is (`castSpell`).
       */
      spellcasting: z.string().optional(),
      slot_level: n.min(1).max(9).optional(),
      pact: z.boolean().optional(),
      mode,
      damage_type: z.enum(DAMAGE_TYPES).optional(),
      /** A character's spell: a slot (default), a free cast's use (`free_casts`), or a ritual. */
      payment: SpellPaymentSchema.optional(),
      /** The GM's additions to its attack rolls and damage (`DmOptions`). */
      dm: DmOptionsSchema.optional(),
    }),
    /** A character's feature (`sheet.actions`, by key or name); `amount` for a pool. */
    z.object({
      type: z.literal("feature"),
      feature: z.string(),
      amount: n.min(1).optional(),
      damage_type: z.enum(DAMAGE_TYPES).optional(),
      /** A spell slot instead of its uses, or the slot it requires (`slot_payment`). */
      payment: SlotPaymentSchema.optional(),
    }),
    /** A saving throw effect (a breath weapon), by name. */
    z.object({ type: z.literal("save_action"), ability: z.string() }),
    z.object({
      type: z.literal("legendary"),
      action: z.string(),
      attack: z.string().optional(),
      mode,
    }),
  ])
  .meta({ id: "RollWhat" });
export type RollWhat = z.infer<typeof RollWhatSchema>;

/**
 * What a roll by hand costs (`rollByHand`'s `costs`; the `spend` action pays them): a play
 * action on the character's state (a spell slot, Concentration, a feature's uses), one of a
 * monster's daily uses (`key` counts up to `per_day`; `name` is what's used), or a monster's
 * ability expended until it recharges.
 */
export const RollCostSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("play"), action: PlayActionSchema }),
    z.object({
      type: z.literal("daily"),
      key: z.string(),
      per_day: n.min(1),
      name: z.string(),
    }),
    z.object({ type: z.literal("recharge"), name: z.string() }),
  ])
  .meta({ id: "RollCost" });
export type RollCost = z.infer<typeof RollCostSchema>;

const AttackActionSchema = z.object({
  type: z.literal("attack"),
  force,
  id: z.string(),
  target: z.string(),
  attack: z.string(),
  mode: z.enum(["normal", "advantage", "disadvantage"]).optional(),
  two_handed: z.boolean().optional(),
  riders: z.array(z.object({ rider: z.string(), type: z.string().optional() })).optional(),
  ally_adjacent: z.boolean().optional(),
  /** Within 5 feet of the target (default: a melee attack is, a ranged one isn't). */
  within_5ft: z.boolean().optional(),
  reaction: z.boolean().optional(),
  opportunity: z.boolean().optional(),
  light_extra: z.boolean().optional(),
  cleave: z.boolean().optional(),
  mastery: z.boolean().optional(),
  /** One of the attacks a feature granted this turn (Flurry of Blows). */
  granted: z.boolean().optional(),
  /** Throw a melee weapon with the Thrown property: a ranged attack at its range. */
  thrown: z.boolean().optional(),
  /** The target's cover from this attack: +2 or +5 AC; Total Cover can't be targeted. */
  cover: z.enum(["half", "three_quarters", "total"]).optional(),
  /** Cunning Strike effects, paid with Sneak Attack dice (needs the `sneak-attack` rider). */
  cunning: z.array(z.enum(["poison", "trip", "withdraw"])).optional(),
  /** Brutal Strike effects: Advantage forgone while Reckless, for 1d10 and an effect. */
  brutal: z.array(z.enum(["forceful", "hamstring", "staggering", "sundering"])).optional(),
});

const UnarmedActionSchema = z.object({
  type: z.literal("unarmed"),
  force,
  id: z.string(),
  target: z.string(),
  option: z.enum(["grapple", "shove"]),
  shove: z.enum(["push", "prone"]).optional(),
  save: z.enum(["str", "dex"]).optional(),
  reaction: z.boolean().optional(),
});

const CastActionSchema = z.object({
  type: z.literal("cast"),
  force,
  id: z.string(),
  spell: z.string(),
  via: z.string().optional(),
  /** A character's spellcasting feature to cast it with (see the `roll` action's `cast`). */
  spellcasting: z.string().optional(),
  targets: z.array(z.string()).optional(),
  /** An area spell or effect: its point (Sphere, Cube) or the square it's aimed toward (Cone,
   * Line); its targets are the positioned creatures in it. */
  area: z
    .object({
      point: z.object({ x: n, y: n }).optional(),
      toward: z.object({ x: n, y: n }).optional(),
    })
    .optional(),
  /** Targets' cover, by id: +2 or +5 to AC and Dexterity saves; Total Cover can't be targeted. */
  cover: z.record(z.string(), z.enum(["half", "three_quarters", "total"])).optional(),
  slot_level: n.min(1).max(9).optional(),
  pact: z.boolean().optional(),
  /**
   * A wall spell's placement: from square `from` to square `to` (its squares), or from grid corner
   * to grid corner for a wall between squares; `side` is Wall of Fire's damaging side, left or
   * right of the line from `from` to `to`.
   */
  wall: z
    .object({
      from: z.object({ x: n, y: n }),
      to: z.object({ x: n, y: n }),
      side: z.enum(["left", "right"]).optional(),
    })
    .optional(),
  mode: z.enum(["normal", "advantage", "disadvantage"]).optional(),
  /**
   * A follow-up saving throw's other creatures, within its radius of the target (Ice Knife),
   * when positions aren't used; with positions they're found on the grid.
   */
  nearby: z.array(z.string()).optional(),
  /** The damage type, for a spell that offers a choice (Spirit Guardians). */
  damage_type: z.enum(DAMAGE_TYPES).optional(),
  /** Creatures a zone doesn't affect, for a spell whose caster designates them. */
  unaffected: z.array(z.string()).optional(),
});

const MoveActionSchema = z.object({
  type: z.literal("move"),
  force,
  id: z.string(),
  feet: n.min(0).optional(),
  to: z.object({ x: n, y: n }).optional(),
  path: z
    .array(z.object({ x: n, y: n }))
    .min(1)
    .optional(),
});

const HelpActionSchema = z.object({
  type: z.literal("help"),
  force,
  id: z.string(),
  target: z.string(),
  skill: z.enum(SKILLS).optional(),
});

/** What the Ready action can hold for the reaction. */
export const ReadiedActionSchema = z.discriminatedUnion("type", [
  AttackActionSchema,
  UnarmedActionSchema,
  CastActionSchema,
  MoveActionSchema,
  HelpActionSchema,
]);

/** Everything that can happen in an encounter, as plain JSON. */
export const EncounterActionSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("add_monster"),
      monster: z.string(),
      /** Default: the monster's id, numbered if taken (`goblin-warrior-2`). */
      id: id.optional(),
      name: z.string().optional(),
      side: z.string().optional(),
      /** Fixed HP; default the stat block's average, or `roll_hp` to roll its Hit Dice. */
      hp: n.min(1).optional(),
      roll_hp: z.boolean().optional(),
      /** In its lair: the stat block's lair values for legendary uses. */
      in_lair: z.boolean().optional(),
      /** `false`: don't spend Legendary Resistance automatically on a failed save. */
      auto_legendary_resistance: z.boolean().optional(),
      decisions: z.enum(["ask", "auto"]).optional(),
    }),
    z.object({
      type: z.literal("add_character"),
      character: z.string(),
      id: id.optional(),
      name: z.string().optional(),
      side: z.string().optional(),
      decisions: z.enum(["ask", "auto"]).optional(),
    }),
    /** Answer the pending decision. */
    z.object({ type: z.literal("decide"), use: z.boolean() }),
    /** Change who decides: one combatant's mode (`null`: the encounter's), or the encounter's. */
    z.object({
      type: z.literal("set_decisions"),
      id: z.string().optional(),
      mode: z.enum(["ask", "auto"]).nullable(),
    }),
    z.object({ type: z.literal("remove"), id: z.string() }),
    z.object({
      type: z.literal("roll_initiative"),
      /** Who rolls (default: everyone without an Initiative yet). */
      ids: z.array(z.string()).optional(),
      /** Surprised combatants roll with Disadvantage. */
      surprised: z.array(z.string()).optional(),
      /** Identical monsters (same stat block) share one roll. */
      group: z.boolean().optional(),
    }),
    z.object({ type: z.literal("set_initiative"), id: z.string(), value: n }),
    /** Put tied combatants in the order the GM and players decide: every id, in order. */
    z.object({ type: z.literal("set_order"), ids: z.array(z.string()) }),
    z.object({ type: z.literal("start") }),
    z.object({ type: z.literal("next_turn") }),
    z.object({ type: z.literal("end") }),
    z.object({ type: z.literal("use"), force, id: z.string(), what: z.enum(ECONOMY) }),
    /**
     * Move `feet`, or to the square `to`, or along `path` (each square next to the one before,
     * ending at the destination). Each square costs 5 feet, 10 if it's Difficult Terrain (the
     * map's, a zone's, or a creature's space that isn't an ally's or a Tiny creature's); walls,
     * blocked squares and creatures that can't be passed through stop a step. `to` goes straight
     * (diagonals first) when nothing is in the way, else by the cheapest path around. Zones on
     * the way count: entering one, and damage for moving in it. Leaving an enemy's reach is
     * noted: it can make an Opportunity Attack (unless the mover Disengaged).
     */
    MoveActionSchema,
    /** Put a combatant on a square without spending movement (setup, a shove, a teleport). */
    z.object({ type: z.literal("place"), id: z.string(), x: n, y: n }),
    /** Make squares Difficult Terrain, blocked (can't be entered) or clear again (the GM's). */
    z.object({
      type: z.literal("set_terrain"),
      squares: z.array(z.object({ x: n, y: n })).min(1),
      kind: z.enum(["difficult", "blocked", "clear"]),
    }),
    /** Put up or take down a wall between grid corners `from` and `to` (the GM's). */
    z.object({
      type: z.literal("add_wall"),
      from: z.object({ x: n, y: n }),
      to: z.object({ x: n, y: n }),
    }),
    z.object({
      type: z.literal("remove_wall"),
      from: z.object({ x: n, y: n }),
      to: z.object({ x: n, y: n }),
    }),
    /** Put a point of interest on the map (the GM's); it starts hidden unless `revealed`. */
    z.object({
      type: z.literal("add_point"),
      at: z.object({ x: n, y: n }),
      title: z.string().min(1),
      kind: z.enum(POINT_KINDS).optional(),
      text: z.string().optional(),
      notes: z.string().optional(),
      revealed: z.boolean().optional(),
      dc: n.min(0).nullable().optional(),
      within: n.min(0).optional(),
    }),
    /** Change a point: move it, rewrite it, reveal or hide it (hiding clears `noticed_by`). */
    z.object({
      type: z.literal("update_point"),
      id: z.string(),
      at: z.object({ x: n, y: n }).optional(),
      title: z.string().min(1).optional(),
      kind: z.enum(POINT_KINDS).optional(),
      text: z.string().optional(),
      notes: z.string().optional(),
      revealed: z.boolean().optional(),
      dc: n.min(0).nullable().optional(),
      within: n.min(0).optional(),
    }),
    z.object({ type: z.literal("remove_point"), id: z.string() }),
    /** Exploration settings (the GM's): the travel pace, and who stops when a point is noticed. */
    z.object({
      type: z.literal("set_exploration"),
      pace: z.enum(["fast", "normal", "slow"]).optional(),
      notice_stops: z.enum(["noticer", "everyone"]).optional(),
    }),
    /** Let moves go on after a halt (`notice_stops: everyone`) without revealing the point. */
    z.object({ type: z.literal("resume") }),
    /** The GM's setting for creatures off the map (`Encounter.positions`). */
    z.object({ type: z.literal("set_positions"), mode: z.enum(["optional", "required"]) }),

    /**
     * The Dash action: uses the action, adds the combatant's Speed to this turn's movement.
     * `bonus_action: true` takes it as a Bonus Action instead (a feature that allows it: Cunning
     * Action), as for `disengage` and `dodge`.
     */
    z.object({
      type: z.literal("dash"),
      force,
      id: z.string(),
      bonus_action: z.boolean().optional(),
    }),
    /** The Disengage action: its movement doesn't provoke Opportunity Attacks this turn. */
    z.object({
      type: z.literal("disengage"),
      force,
      id: z.string(),
      bonus_action: z.boolean().optional(),
    }),
    /**
     * The Dodge action: until the start of its next turn, attack rolls against it have
     * Disadvantage and it makes Dexterity saves with Advantage (not while Incapacitated or at
     * Speed 0).
     */
    z.object({
      type: z.literal("dodge"),
      force,
      id: z.string(),
      bonus_action: z.boolean().optional(),
    }),
    /**
     * The Help action: Advantage on an ally's next attack roll against `target` (an enemy), or,
     * with `skill` (one the helper is proficient in), on `target`'s (an ally's) next check with
     * it. Either expires at the start of the helper's next turn.
     */
    HelpActionSchema,
    /**
     * An Unarmed Strike to grapple or shove (in place of one attack, like `attack`): the target
     * saves (Strength or Dexterity: default the better) against 8 + Strength modifier + Proficiency
     * Bonus, or is Grappled (escape DC the same) or shoved (`push` 5 feet, or `prone`).
     */
    UnarmedActionSchema,
    /**
     * Escape a grapple or a spell's hold (Black Tentacles, Web): the action, a Strength (Athletics)
     * or Dexterity (Acrobatics) check (default the better; some allow only Athletics) against its
     * escape DC. `effect` picks the one when there are several.
     */
    z.object({
      type: z.literal("escape"),
      force,
      id: z.string(),
      skill: z.enum(["athletics", "acrobatics"]).optional(),
      effect: z.string().optional(),
    }),
    /** Right itself from Prone: half its Speed in movement. */
    z.object({ type: z.literal("stand"), force, id: z.string() }),
    /**
     * The Hide action: a DC 15 Dexterity (Stealth) check; on a success it's hidden (Invisible,
     * `hidden` holds the total). With positions it needs Three-Quarters or Total Cover from every
     * enemy, unless it's Heavily Obscured (`obscured: true`, the caller's to judge). It stops
     * being hidden when it makes an attack roll, casts a spell with a Verbal component, or is
     * found (`search`); `reveal` ends it for anything else (a sound).
     */
    z.object({
      type: z.literal("hide"),
      force,
      id: z.string(),
      bonus_action: z.boolean().optional(),
      obscured: z.boolean().optional(),
    }),
    z.object({ type: z.literal("reveal"), id: z.string() }),
    /**
     * The Search action: a Wisdom check (Perception by default); with Perception it finds the
     * hidden enemies (or the `target`) whose Stealth total it equals or beats, and notices the
     * hidden points of interest it could see (SRD "Finding Hidden Objects": within the point's
     * range, in sight) whose DC it equals or beats. Outside a fight it takes no action, and the
     * travel pace applies (Fast: Disadvantage, Slow: Advantage).
     */
    z.object({
      type: z.literal("search"),
      force,
      id: z.string(),
      skill: z.enum(["perception", "insight", "medicine", "survival"]).optional(),
      target: z.string().optional(),
      dc: n.optional(),
    }),
    /** The Study action: an Intelligence check (Arcana, History, Investigation, Nature, Religion). */
    z.object({
      type: z.literal("study"),
      force,
      id: z.string(),
      skill: z.enum(["arcana", "history", "investigation", "nature", "religion"]).optional(),
      dc: n.optional(),
    }),
    /**
     * The Influence action: a Charisma (Deception, Intimidation, Performance, Persuasion) or Wisdom
     * (Animal Handling) check; against a monster `target`, the DC defaults to 15 or its
     * Intelligence score, whichever is higher.
     */
    z.object({
      type: z.literal("influence"),
      force,
      id: z.string(),
      skill: z.enum(["deception", "intimidation", "performance", "persuasion", "animal-handling"]),
      target: z.string().optional(),
      dc: n.optional(),
    }),
    /** The Utilize action: use an object that needs an action (`what`, for the notes). */
    z.object({ type: z.literal("utilize"), force, id: z.string(), what: z.string().optional() }),
    /**
     * The Ready action: `trigger` (the caller watches for it) and the action to take then with the
     * reaction (`action`: an attack, an Unarmed Strike, a spell with a casting time of an action, a
     * move up to its Speed, Help). A readied spell is cast now (slot spent) and held with
     * Concentration; it's lost if Concentration ends. Lasts until the start of its next turn.
     */
    z.object({
      type: z.literal("ready"),
      force,
      id: z.string(),
      trigger: z.string(),
      action: ReadiedActionSchema,
    }),
    /** Take the readied action now, with the reaction (the trigger happened). */
    z.object({ type: z.literal("release"), force, id: z.string() }),
    /**
     * Apply play actions to a combatant (what `makeAttack`, `castSpell` and `useSaveAction` return):
     * a character's go to its state; a monster supports damage, heal, set_temp_hp and conditions.
     */
    z.object({
      type: z.literal("effects"),
      id: z.string(),
      actions: z.array(PlayActionSchema),
      /** Who caused them: a condition added here becomes a timed effect when a duration is given. */
      source: z.string().optional(),
      /** `N` rounds (ends at the start of the source's turn, or the target's), or… */
      rounds: n.min(1).optional(),
      /** …until the start or end of someone's next turn (default: the source's). */
      until: z.object({ at: z.enum(["start", "end"]), of: z.string().optional() }).optional(),
      /** The conditions end when the source's Concentration on `label` ends. */
      concentration: z.boolean().optional(),
      label: z.string().optional(),
      /** A grapple from `source` (a stat block's "escape DC 13"): `escape` checks against it. */
      escape_dc: n.optional(),
    }),
    z.object({ type: z.literal("end_effect"), effect: z.string() }),
    /**
     * One attack with an attack line (`makeAttack`), applied to the target. The first attack of a
     * turn uses the action (Extra Attack allows more); `reaction: true` uses the reaction instead
     * (`opportunity: true`: an Opportunity Attack, melee only, refused against a Disengaged
     * target). `light_extra: true` is the Light property's extra attack: a Bonus Action after
     * attacking with a Light weapon in the Attack action, with a different Light weapon, without a
     * positive ability modifier on damage (with a Nick weapon: part of the Attack action, once per
     * turn). `cleave: true` is the Cleave mastery's attack against a second creature after a hit.
     * The weapon's mastery property applies unless `mastery: false`. Once-per-turn riders are
     * enforced; an attack roll extends Rage; Help against the target is used up.
     */
    AttackActionSchema,
    /**
     * A character's feature used in a turn (`sheet.actions`, by key or name): its economy and
     * resource are spent, then it heals, gives an additional action (Action Surge), takes
     * standard actions (Patient Defense), grants attacks (Flurry of Blows), forces a save after a
     * hit (Stunning Strike), or gives a Bardic Inspiration die. `amount` for a pool (Lay on Hands).
     */
    z.object({
      type: z.literal("feature"),
      force,
      id: z.string(),
      feature: z.string(),
      target: z.string().optional(),
      /** The creatures a feature that affects several takes (Turn Undead). */
      targets: z.array(z.string()).optional(),
      amount: n.min(1).optional(),
      /** The damage type, for a feature that offers a choice (Divine Spark). */
      damage_type: z.enum(DAMAGE_TYPES).optional(),
    }),
    /** A saving throw effect (a monster's breath weapon) against targets; uses the action. */
    z.object({
      type: z.literal("save_action"),
      force,
      id: z.string(),
      ability: z.string(),
      targets: z.array(z.string()).optional(),
      /** An area spell or effect: its point (Sphere, Cube) or the square it's aimed toward (Cone,
       * Line); its targets are the positioned creatures in it. */
      area: z
        .object({
          point: z.object({ x: n, y: n }).optional(),
          toward: z.object({ x: n, y: n }).optional(),
        })
        .optional(),
      /** Targets' cover, by id: +2 or +5 to Dexterity saves; Total Cover can't be targeted. */
      cover: z.record(z.string(), z.enum(["half", "three_quarters", "total"])).optional(),
    }),
    /**
     * Cast a catalog spell (`castSpell`): uses the action, Bonus Action or reaction its casting
     * time says, spends the slot, applies the effects; a Concentration spell's conditions last
     * while the caster concentrates, up to its duration. A monster casts it through the action
     * that lists it (`via` when several do): that action's section decides the economy, its level
     * is fixed, and daily uses and Recharge are counted.
     */
    CastActionSchema,
    /**
     * Creatures save against a zone (when positions don't tell who enters it or ends its turn
     * there); each saves once per turn when the spell says so.
     */
    z.object({
      type: z.literal("zone_save"),
      zone: z.string(),
      targets: z.array(z.string()),
    }),
    /**
     * Move a zone's point (Moonbeam's Magic action, Cloudkill drifting): the creatures it moves
     * onto save. The action it takes is the caller's.
     */
    z.object({
      type: z.literal("move_zone"),
      zone: z.string(),
      point: z.object({ x: n, y: n }),
      /** The creature whose space it's moved into, for a zone that rams (Flaming Sphere). */
      onto: z.string().optional(),
    }),
    z.object({ type: z.literal("end_zone"), zone: z.string() }),
    /**
     * Move a Hunter's Mark or Hex to a new creature (a Bonus Action), once its target dropped to 0
     * Hit Points; `spell` picks the mark when the caster has several.
     */
    z.object({
      type: z.literal("move_mark"),
      id: z.string(),
      target: z.string(),
      spell: z.string().optional(),
    }),
    /**
     * An ability check, with a skill or not, or a saving throw (`save`), against a DC or not. Uses
     * no action by itself; a save applies nothing (the table does).
     */
    z.object({
      type: z.literal("check"),
      id: z.string(),
      skill: z.enum(SKILLS).optional(),
      ability: z.enum(ABILITIES).optional(),
      save: z.enum(ABILITIES).optional(),
      dc: n.optional(),
      mode: z.enum(["normal", "advantage", "disadvantage"]).optional(),
    }),
    /** Extend Rage this turn some other way (forcing a saving throw). */
    z.object({ type: z.literal("extend"), id: z.string() }),
    /**
     * Roll by hand (`rollByHand`), a free roll: the actor's dice for `what`, and nothing else. No
     * target, no action economy, no turn, nothing spent, no outcome (the table applies it with
     * `effects`). The result is a `DeclaredResult` with what it costs and whether each cost can be
     * paid now; `spend` pays them.
     */
    z.object({ type: z.literal("roll"), id: z.string(), what: RollWhatSchema }),
    /**
     * Pay a roll's costs (`DeclaredResult.costs`): spell slots, Concentration and feature uses on
     * the character's state, a monster's daily uses and Recharge. Refused when one can't be paid
     * (`force` pays what it can).
     */
    z.object({ type: z.literal("spend"), force, id: z.string(), costs: z.array(RollCostSchema) }),
    /**
     * A legendary action, taken right after another creature's turn: an attack (`target`, and
     * `attack` when it offers a choice), a saving throw effect (`targets`), another action it uses,
     * or text. Uses per round come back at the start of the monster's turn.
     */
    z.object({
      type: z.literal("legendary"),
      force,
      id: z.string(),
      action: z.string(),
      target: z.string().optional(),
      targets: z.array(z.string()).optional(),
      /** An area spell or effect: its point (Sphere, Cube) or the square it's aimed toward (Cone,
       * Line); its targets are the positioned creatures in it. */
      area: z
        .object({
          point: z.object({ x: n, y: n }).optional(),
          toward: z.object({ x: n, y: n }).optional(),
        })
        .optional(),
      attack: z.string().optional(),
      mode: z.enum(["normal", "advantage", "disadvantage"]).optional(),
      within_5ft: z.boolean().optional(),
    }),
  ])
  .meta({ id: "EncounterAction" });
export type EncounterAction = z.infer<typeof EncounterActionSchema>;
