/**
 * Schemas for static rules content (species, classes, backgrounds, feats, items).
 *
 * Content is data: it lives in YAML under `content/` and is validated against these schemas
 * at load time. Every top-level entity carries a stable slug `id` and a `source` tag so SRD
 * material can always be told apart from homebrew.
 */

import { z } from "zod";

export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;
export type Ability = (typeof ABILITIES)[number];

export const ABILITY_NAMES: Readonly<Record<Ability, string>> = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
};

export const SKILLS = [
  "acrobatics",
  "animal-handling",
  "arcana",
  "athletics",
  "deception",
  "history",
  "insight",
  "intimidation",
  "investigation",
  "medicine",
  "nature",
  "perception",
  "performance",
  "persuasion",
  "religion",
  "sleight-of-hand",
  "stealth",
  "survival",
] as const;
export type Skill = (typeof SKILLS)[number];

export const SKILL_ABILITY: Readonly<Record<Skill, Ability>> = {
  acrobatics: "dex",
  "animal-handling": "wis",
  arcana: "int",
  athletics: "str",
  deception: "cha",
  history: "int",
  insight: "wis",
  intimidation: "cha",
  investigation: "int",
  medicine: "wis",
  nature: "int",
  perception: "wis",
  performance: "cha",
  persuasion: "cha",
  religion: "int",
  "sleight-of-hand": "dex",
  stealth: "dex",
  survival: "wis",
};

export function isSkill(value: string): value is Skill {
  return (SKILLS as readonly string[]).includes(value);
}

export function skillName(skill: Skill): string {
  return titleCase(skill.replaceAll("-", " ")).replace(" Of ", " of ");
}

/** Python-style `str.title()` for plain ASCII labels: "light armor" → "Light Armor". */
export function titleCase(text: string): string {
  return text.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, pre, c) => pre + c.toUpperCase());
}

export const SIZES = ["small", "medium"] as const;
export type Size = (typeof SIZES)[number];

/**
 * Builder steps, in the order they are presented.
 *
 * Ordered by dependency: each step only needs what earlier steps decided. Equipment comes
 * before features so Weapon Mastery / Fighting Style can be picked knowing your gear, and
 * proficiencies come late so every skill grant (species, background, feats) is known before
 * you spend free picks. Spells come after features because features can decide which list
 * you pick from (Magic Initiate, Divine Order).
 */
export const STEPS = [
  "class",
  "species",
  "background",
  "abilities",
  "equipment",
  "features",
  "spells",
  "proficiencies",
  "languages",
  "details",
] as const;
export type Step = (typeof STEPS)[number];

export const CHOICE_KINDS = [
  "option", // pick among inline options, each with its own grants
  "ability",
  "skill",
  "tool",
  "skill_or_tool",
  "language",
  "feat",
  "weapon_mastery",
  "spell",
  "expertise", // a skill you're already proficient in
  "subclass", // the class's subclass (options: subclasses of the source's class)
  "ability_increase", // each pick is +1 to an ability; the same ability can be picked again
  "feature", // a selectable class feature (Eldritch Invocation, Metamagic): `features` table
] as const;
export type ChoiceKind = (typeof CHOICE_KINDS)[number];

const DEFAULT_STEP_BY_KIND: Partial<Record<ChoiceKind, Step>> = {
  skill: "proficiencies",
  tool: "proficiencies",
  skill_or_tool: "proficiencies",
  language: "languages",
  feat: "features",
  weapon_mastery: "features",
  spell: "spells",
  expertise: "proficiencies",
  subclass: "features",
  ability_increase: "features",
  feature: "features",
};

export const EFFECT_OPS = ["add", "set", "max", "min"] as const;
export type EffectOp = (typeof EFFECT_OPS)[number];

/** Effect targets the sheet reads, besides the per-skill, per-save and per-score ones. */
const EFFECT_TARGET_NAMES = [
  "ac",
  "attack.critical",
  "attack.ranged",
  "attacks",
  "checks",
  "darkvision",
  "hp_per_class_level",
  "hp_per_level",
  "initiative",
  "martial_arts.die",
  "saves",
  "skill.unproficient",
  "speed",
  "spell.save_dc",
  "attack.weapon",
] as const;
export type EffectTarget =
  | (typeof EFFECT_TARGET_NAMES)[number]
  | `skill.${Skill}`
  | `save.${Ability}`
  | `score.${Ability}`;
/** Every effect target the sheet understands; content using any other target is rejected. */
export const EFFECT_TARGETS: readonly EffectTarget[] = [
  ...EFFECT_TARGET_NAMES,
  ...SKILLS.map((s) => `skill.${s}` as const),
  ...ABILITIES.map((a) => `save.${a}` as const),
  ...ABILITIES.map((a) => `score.${a}` as const),
];

/** Conditions an effect can depend on (`when`), evaluated from what the character wears. */
export const EFFECT_CONDITIONS = [
  "wearing_armor",
  "wielding_shield",
  "wearing_heavy_armor",
  "not_wearing_heavy_armor",
  "unarmored",
] as const;
export type EffectCondition = (typeof EFFECT_CONDITIONS)[number];

/**
 * A declarative numeric modifier. Minimal precursor of the full Effect engine.
 *
 * `target` is one of `EFFECT_TARGETS`. `value` is an integer, the token `"prof"` (Proficiency
 * Bonus), `"half_prof"` (half of it, rounded down) or an ability (`"wis"`: that ability's
 * modifier). `min` is a floor for the value ("Wisdom modifier, minimum of +1"). `when` is one
 * of `EFFECT_CONDITIONS`.
 */
export const EffectSchema = z.strictObject({
  target: z.enum(EFFECT_TARGETS as [EffectTarget, ...EffectTarget[]], {
    error: (issue) => `unknown effect target '${String(issue.input)}' (see docs/CONTENT.md)`,
  }),
  op: z.enum(EFFECT_OPS).default("add"),
  value: z.union([z.int(), z.literal("prof"), z.literal("half_prof"), z.enum(ABILITIES)]),
  min: z.int().nullable().default(null),
  when: z
    .enum(EFFECT_CONDITIONS, {
      error: (issue) => `unknown effect condition '${String(issue.input)}' (see docs/CONTENT.md)`,
    })
    .nullable()
    .default(null),
});
export type Effect = z.infer<typeof EffectSchema>;

export const DAMAGE_TYPES = [
  "acid",
  "bludgeoning",
  "cold",
  "fire",
  "force",
  "lightning",
  "necrotic",
  "piercing",
  "poison",
  "psychic",
  "radiant",
  "slashing",
  "thunder",
] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];

const Dice = z.string().regex(/^\d+d\d+$/, "dice like 8d6");

/**
 * What a feature can give Advantage on: `save.<ability>`, `check.<ability>`, `initiative`,
 * `attack.str` (attack rolls using Strength), or `attacked` (attack rolls against you: Reckless
 * Attack's price).
 */
export type AdvantageTarget =
  | `save.${Ability}`
  | `check.${Ability}`
  | "initiative"
  | "attack.str"
  | "attack.spell"
  | "attacked";
export const ADVANTAGE_TARGETS: readonly AdvantageTarget[] = [
  "initiative",
  "attack.str",
  "attack.spell",
  "attacked",
  ...ABILITIES.map((a) => `save.${a}` as const),
  ...ABILITIES.map((a) => `check.${a}` as const),
];

/**
 * Extra damage on some attacks (Rage Damage, Sneak Attack, Divine Strike). `damage` is dice
 * (`1d8`), a flat amount (`+2`), or a column of the source class's table (`{progression:
 * "Sneak Attack"}`) read at its current level. An `automatic` rider is part of every matching
 * attack line's damage; the others are listed on the line for `makeAttack` to apply on request.
 * A later rider with the same `id` replaces an earlier one (Divine Strike: 1d8, then 2d8).
 */
export const DamageRiderSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  /**
   * `{progression, die}`: that many dice of the column's value (Frenzy: "a number of d6s equal
   * to your Rage Damage bonus").
   */
  damage: z.union([
    Dice,
    z.string().regex(/^[+-]\d+$/, "a flat amount like +2"),
    z.strictObject({ progression: z.string(), die: z.int().min(2).optional() }),
  ]),
  /** The weapon's damage type, a type, or a choice of types made when it's applied. */
  type: z
    .union([z.literal("weapon"), z.enum(DAMAGE_TYPES), z.array(z.enum(DAMAGE_TYPES)).min(2)])
    .default("weapon"),
  /** Which attacks: using an ability, with a weapon (not an Unarmed Strike), with a property or kind. */
  applies_to: z
    .strictObject({
      ability: z.enum(ABILITIES).nullable().default(null),
      weapon: z.boolean().default(false),
      /** Any of these weapon properties or kinds (`finesse`, `ranged`). */
      any_of: z.array(z.string()).default([]),
    })
    .prefault({}),
  automatic: z.boolean().default(false),
  once_per_turn: z.boolean().default(false),
  /**
   * Sneak Attack: Advantage on the roll, or an ally next to the target (and no Disadvantage);
   * `target_damaged`: the target is missing any of its Hit Points (Colossus Slayer).
   */
  requires: z.enum(["advantage_or_ally", "target_damaged"]).nullable().default(null),
  /** Only while all these toggles (by id) are active: Frenzy needs `rage` and `reckless-attack`. */
  while_active: z.array(z.string()).default([]),
  /** Only on your own turns (Divine Strike: "once on each of your turns"). */
  own_turn: z.boolean().default(false),
});
export type DamageRider = z.infer<typeof DamageRiderSchema>;

/**
 * Rules in code that a feature switches on (listed under "Named rules in code" in
 * ARCHITECTURE.md): `evasion` (Dexterity saves for half damage: none on a success, half on a
 * failure), `reliable_talent` (a d20 of 9 or lower counts as 10 on checks with a skill you're
 * proficient in), `potent_cantrip` (a cantrip that misses, or is saved against, still deals half
 * damage).
 */
export const FEATURE_RULES = [
  "evasion",
  "reliable_talent",
  "potent_cantrip",
  "indomitable",
  "cunning_strike",
  "improved_cunning_strike",
  "brutal_strike",
  "improved_brutal_strike",
  "relentless_rage",
] as const;
export type FeatureRule = (typeof FEATURE_RULES)[number];

/**
 * An ability modifier added to spell damage (Potent Spellcasting: Wisdom to Cleric cantrips;
 * Empowered Evocation: Intelligence to Wizard evocation spells), to the spells matching every
 * filter given.
 */
export const SpellDamageSchema = z.strictObject({
  name: z.string(),
  ability: z.enum(ABILITIES),
  cantrip: z.boolean().default(false),
  list: z.string().nullable().default(null),
  school: z.string().nullable().default(null),
  /** Spells dealing this damage type (Elemental Affinity). */
  damage_type: z.enum(DAMAGE_TYPES).nullable().default(null),
  /** To "one damage roll of that spell" (the first beam), not to each. */
  one_roll: z.boolean().default(false),
  /** Only this spell (an id, or `$<choice id>`: Agonizing Blast's cantrip). */
  spell: z.string().nullable().default(null),
});
export type SpellDamage = z.infer<typeof SpellDamageSchema>;

/** An Advantage, unless the character has one of these conditions (Danger Sense: Incapacitated). */
export const AdvantageGrantSchema = z.union([
  z.enum(ADVANTAGE_TARGETS as [AdvantageTarget, ...AdvantageTarget[]]),
  z.strictObject({
    target: z.enum(ADVANTAGE_TARGETS as [AdvantageTarget, ...AdvantageTarget[]]),
    unless: z.array(z.string()).default([]),
  }),
]);
export type AdvantageGrant = AdvantageTarget | { target: AdvantageTarget; unless: string[] };

/**
 * A feature you use in a turn (Second Wind, Action Surge, Flurry of Blows): its economy, the
 * resource it spends, and what it does. The encounter action `feature` resolves it; the play
 * action `use_feature` spends it (and heals you, for a self-healing feature).
 */
export const FeatureActionSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  /** `free`: no action, on your turn (Action Surge, Stunning Strike). */
  economy: z.enum(["action", "bonus_action", "reaction", "free"]),
  /** The resource (of the same source) it spends. */
  uses: z.string().nullable().default(null),
  cost: z.int().min(1).default(1),
  /** The caller says how much of the resource to spend (Lay on Hands' pool). */
  pool: z.boolean().default(false),
  /** Who it's used on: yourself, any creature (you included), or another creature. */
  target: z.enum(["self", "creature", "other"]).default("self"),
  /** Healing: dice + bonus (a number, an ability modifier, or `class_level`), or the pool spent. */
  heal: z
    .strictObject({
      dice: Dice.nullable().default(null),
      /** More dice at higher class levels: `[{level: 7, dice: 2d8}]`. */
      scaling: z.array(z.strictObject({ level: z.int(), dice: Dice })).default([]),
      bonus: z.union([z.int(), z.enum(ABILITIES), z.literal("class_level")]).default(0),
      pooled: z.boolean().default(false),
    })
    .nullable()
    .default(null),
  /** One additional action this turn (Action Surge), not the Magic action. */
  extra_action: z.boolean().default(false),
  /** Standard actions it takes along (Patient Defense: Disengage and Dodge). */
  also: z.array(z.enum(["dash", "disengage", "dodge"])).default([]),
  /** Attacks it grants this turn (Flurry of Blows: two Unarmed Strikes). */
  attacks: z
    .strictObject({ attack: z.string(), count: z.int().min(1) })
    .nullable()
    .default(null),
  /** Used after hitting the target this turn (Stunning Strike). */
  after_hit: z.boolean().default(false),
  once_per_turn: z.boolean().default(false),
  /**
   * The target's saving throw, DC 8 + `dc_ability` modifier + Proficiency Bonus (`spell`: the
   * spell save DC of the source class's Spellcasting, Channel Divinity's): on a failure, the
   * conditions until the start of your next turn (or for `rounds`) and `damage` (half on a
   * success with `half`); on a success, `on_success` (Stunning Strike: Speed halved, Advantage
   * on the next attack roll against it, until the start of your next turn).
   */
  save: z
    .strictObject({
      ability: z.enum(ABILITIES),
      dc_ability: z.union([z.enum(ABILITIES), z.literal("spell")]),
      conditions: z.array(z.string()).default([]),
      rounds: z.int().min(1).nullable().default(null),
      /** The conditions also end when the target takes damage, or you're Incapacitated (Turn Undead). */
      ends_on: z.array(z.enum(["damage", "source_incapacitated"])).default([]),
      damage: z
        .strictObject({
          dice: Dice,
          /** More dice at higher class levels: `[{level: 7, dice: 2d8}]`. */
          scaling: z.array(z.strictObject({ level: z.int(), dice: Dice })).default([]),
          bonus: z.union([z.int(), z.enum(ABILITIES)]).default(0),
          /** The damage type, or the user's choice among several. */
          types: z.array(z.enum(DAMAGE_TYPES)).min(1),
          half: z.boolean().default(true),
        })
        .nullable()
        .default(null),
      on_success: z.array(z.enum(["speed_halved", "advantage_against"])).default([]),
    })
    .nullable()
    .default(null),
  /** How far its target can be, in feet (checked with positions). */
  range: z.int().min(0).nullable().default(null),
  /** It affects several creatures at once (`targets`), of these creature types if any. */
  many: z.boolean().default(false),
  creature_types: z.array(z.string()).default([]),
  /** Conditions it ends on the target (Lay On Hands: Poisoned). */
  removes: z.array(z.string()).default([]),
  /**
   * Your reaction when an attack hits you: reduce its damage by `dice` + the abilities'
   * modifiers (+ the class level), if it deals one of `types` (Deflect Attacks).
   */
  reduces_attack_damage: z
    .strictObject({
      dice: Dice,
      abilities: z.array(z.enum(ABILITIES)).default([]),
      class_level: z.boolean().default(false),
      types: z.array(z.enum(DAMAGE_TYPES)).default([]),
    })
    .nullable()
    .default(null),
  /** Gives the target a die (a class table column: "Bardic Die") to add to a failed D20 Test. */
  inspiration: z.strictObject({ progression: z.string() }).nullable().default(null),
  /** Your reaction when an attack hits you: halve its damage (Uncanny Dodge). */
  halves_attack_damage: z.boolean().default(false),
  /**
   * The resource (of the same source) it gives one use of back (Font of Inspiration: Bardic
   * Inspiration). Optional, so older content parses to the same object.
   */
  restores: z.string().optional(),
  /**
   * Paid with a spell slot of any level: `instead` of its `uses` when the player chooses
   * (a feature whose own use is spent), or always (`required`: Font of Inspiration).
   */
  slot_payment: z.enum(["instead", "required"]).optional(),
  /**
   * A die the user rolls when using it (a class table column: `{progression: Bardic Die}`, or
   * fixed `{dice: 1d6}`); what it does is the table's (a target's next save, …).
   */
  roll: z
    .union([z.strictObject({ progression: z.string() }), z.strictObject({ dice: Dice })])
    .optional(),
});
export type FeatureActionDef = z.infer<typeof FeatureActionSchema>;

export const TraitSchema = z.strictObject({ name: z.string(), text: z.string() });
export type Trait = z.infer<typeof TraitSchema>;

/**
 * An alternative way to compute Armor Class while wearing no armor (Unarmored Defense, Mage
 * Armor): `base` + the listed ability modifiers. The sheet uses whichever option is best; they
 * never stack with each other or with worn armor.
 */
export const AcCalculationSchema = z.strictObject({
  name: z.string(),
  base: z.int().default(10),
  abilities: z.array(z.enum(ABILITIES)),
  /** Whether a Shield can still be used (Barbarian: yes; Monk: no). */
  shield: z.boolean().default(true),
});
export type AcCalculation = z.infer<typeof AcCalculationSchema>;

/**
 * A spellcasting feature. `list` is a class spell list id (`null` for a fixed set of spells,
 * like a species' cantrips); `ability` is the spellcasting ability. Either can be
 * `"$<choice id>"` to use the answer to one of the same source's choices (Magic Initiate lets
 * you pick both).
 */
export const SpellcastingSchema = z.strictObject({
  list: z.string().nullable().default(null),
  ability: z.string(),
  /**
   * How class levels turn into spell slots: `full` (each level counts), `half` (half, rounded
   * up), both through the Multiclass Spellcaster table in the creation rules; `pact` (Warlock
   * Pact Magic, from `pact_slots`); `null` for spells cast without class slots.
   */
  progression: z.enum(["full", "half", "pact"]).nullable().default(null),
  /** Pact Magic by class level (20 entries): number of slots and their level. */
  pact_slots: z.array(z.strictObject({ count: z.int(), level: z.int() })).default([]),
});
export type Spellcasting = z.infer<typeof SpellcastingSchema>;

/** A fixed ability score increase with its own cap (Primal Champion: Str +4, max 25). */
export const AbilityBonusSchema = z.strictObject({
  ability: z.enum(ABILITIES),
  value: z.int(),
  max: z.int().default(20),
});
export type AbilityBonus = z.infer<typeof AbilityBonusSchema>;

/**
 * A limited-use feature (Rage, Channel Divinity, Sorcery Points…). The maximum is one of:
 * `value`, a class table column (`progression`), an ability modifier (`ability`, with `min`),
 * the Proficiency Bonus (`proficiency`), or `per_class_level` × the class level. A later source
 * with the same `id` in the same class replaces the earlier definition (Action Surge: 2 uses at
 * level 17).
 */
export const ResourceSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  max: z.strictObject({
    value: z.int().nullable().default(null),
    progression: z.string().nullable().default(null),
    ability: z.enum(ABILITIES).nullable().default(null),
    proficiency: z.boolean().default(false),
    per_class_level: z.int().nullable().default(null),
    min: z.int().default(0),
  }),
  /** `short`: all uses back on a Short or Long Rest; `long`: on a Long Rest. */
  recharge: z.enum(["short", "long"]),
  /** For `long` resources that also regain some uses on a Short Rest (Rage: 1). */
  short_rest_regain: z.int().nullable().default(null),
  /**
   * What a use can be spent on besides the feature itself: Advantage on your own D20 Test
   * (`d20_advantage`, before or right after the roll) or Disadvantage on an attack roll against
   * you (`impose_disadvantage`). Optional, so older content parses to the same object.
   */
  spend_for: z.array(z.enum(["d20_advantage", "impose_disadvantage"])).optional(),
});
export type ResourceDef = z.infer<typeof ResourceSchema>;

/**
 * A spell its source lets you cast without a spell slot, spending a limited use of the same
 * source instead: `spells` by id, or the spells picked in its `choice` (Magic Initiate's level 1
 * spell). At the spell's own level, with the source's spellcasting feature.
 */
export const FreeCastSchema = z.strictObject({
  uses: z.string(),
  spells: z.array(z.string()).optional(),
  choice: z.string().optional(),
});
export type FreeCast = z.infer<typeof FreeCastSchema>;

/**
 * A d20 roll of `min - 1` or lower counts as `min` on some ability checks (Reliable Talent-like):
 * checks with one of `skills` (any skill when absent), made with one of `abilities` (any when
 * absent), only proficient ones with `proficient`. Each d20 is raised before one is kept.
 */
export const D20FloorSchema = z.strictObject({
  min: z.int().min(2).max(20),
  kind: z.literal("check"),
  skills: z.array(z.enum(SKILLS)).optional(),
  abilities: z.array(z.enum(ABILITIES)).optional(),
  proficient: z.boolean().optional(),
  label: z.string().optional(),
});
export type D20Floor = z.infer<typeof D20FloorSchema>;

export const ItemGrantSchema = z.strictObject({
  item: z.string(),
  qty: z.int().min(1).default(1),
});
export type ItemGrant = z.infer<typeof ItemGrantSchema>;

export const FeatGrantSchema = z.strictObject({
  feat: z.string(),
  /** Pre-filled answers to the feat's own choices, e.g. `{spell_list: cleric}`. */
  params: z.record(z.string(), z.string()).default({}),
});
export type FeatGrant = z.infer<typeof FeatGrantSchema>;

// Grants → ChoiceDef → ChoiceOption → Grants is recursive, so these three types are written
// out by hand and the schemas are annotated with them.

export interface ChoiceOption {
  id: string;
  name: string;
  description: string;
  grants: Grants;
}

export interface ChoiceDef {
  id: string;
  label: string;
  kind: ChoiceKind;
  count: number;
  /** For `kind: option`. */
  options: ChoiceOption[];
  /** Restricts ids for other kinds; `null` means any. */
  allowed: string[] | null;
  /** Feat/tool/language/weapon category filter (any of these). */
  category: string[] | null;
  step: Step | null;
  hint: string;
  /** `kind: spell`: only spells of this level. */
  spell_level: number | null;
  /** `kind: spell`: spells of level 1 up to this one (a level you have slots for). */
  max_spell_level: number | null;
  /**
   * `kind: spell`: class spell lists (any of them), each possibly `"$<choice id>"` for the
   * answer to a sibling choice. `null` means any list.
   */
  spell_list: string[] | null;
  /** `kind: spell`: only spells you already have from another source (Agonizing Blast). */
  known_only: boolean;
  /** A label shared by related choices; `subset_of` refers to it. */
  tag: string | null;
  /** `kind: ability_increase`: the score can't go above this. */
  max_score: number;
  /** `kind: spell`: only spells with the Ritual tag. */
  ritual: boolean;
  /** `kind: spell`: only spells of this school (Evoker: evocation). */
  school: string | null;
  /** `kind: spell`: the picks are always prepared (they don't count against a class's limit). */
  always_prepared: boolean;
  /**
   * A list that grows with the class and can be changed freely (SRD: "after a Long Rest"):
   * `count` / `max_spell_level` by the source class's current level (20 values each).
   */
  scaling: { count: number[] | null; max_spell_level: number[] | null } | null;
  /**
   * The picks can be replaced one at a time later (SRD: "whenever you gain a level, you can
   * replace one…"): `class_level` at each later level in the source's class, `any_level` at every
   * later character level (Magic Initiate). Choices with the same `tag` form one family.
   */
  swap: "class_level" | "any_level" | null;
  /** A replacement spell must be of the same level as the one it replaces. */
  same_level: boolean;
  /**
   * The picks can be changed after a rest (SRD: "whenever you finish a Long Rest, you can
   * change…"). The build holds a starting set; the play state holds today's picks.
   */
  rest_change: "short" | "long" | null;
  /** Options are limited to what the choices with this `tag` picked (Wizard: prepare from the spellbook). */
  subset_of: string | null;
  /** `kind: weapon_mastery`: only melee or ranged weapons. */
  weapon_kind: "melee" | "ranged" | null;
}

/** A feature you switch on in play (Rage). Its key is like a resource's: `barbarian:rage`. */
export interface ToggleDef {
  id: string;
  name: string;
  /** A resource of the same source spent to switch it on (`rage`). */
  uses: string | null;
  /** What it gives while active. */
  grants: Grants;
  /** Can't be switched on, and ends, while one of these holds (`wearing_heavy_armor`). */
  blocked_when: EffectCondition[];
  /** Ends when the character has one of these conditions (`incapacitated`, implied ones too). */
  ends_on: string[];
  /** No Concentration and no spellcasting while active. */
  no_spells: boolean;
  /**
   * In an encounter, it ends at the end of each of your turns unless you extended it that turn
   * (Rage: an attack roll, forcing a save, or a Bonus Action), except the turn it started.
   */
  extends_each_turn: boolean;
  /** In an encounter, it ends at the start of your next turn (Reckless Attack). */
  ends_at_turn_start: boolean;
  /** In an encounter, it lasts at most this many rounds (Rage: 100, ten minutes). */
  rounds: number | null;
}

export interface Grants {
  size: Size | null;
  skills: Skill[];
  tools: string[];
  languages: string[];
  saving_throws: Ability[];
  armor_training: string[];
  weapon_proficiencies: string[];
  feats: FeatGrant[];
  resistances: string[];
  cantrips: string[];
  /** Spells you always have prepared (Hunter's Mark, Speak with Animals…). */
  spells: string[];
  spellcasting: Spellcasting | null;
  ac_calculations: AcCalculation[];
  ability_bonuses: AbilityBonus[];
  /** Limited-use features tracked in play (Rage, Second Wind…). */
  resources: ResourceDef[];
  /** Things a Long Rest gives besides recovery (Human: Heroic Inspiration). */
  on_long_rest: "heroic_inspiration"[];
  effects: Effect[];
  /** Extra damage on some attacks. */
  damage_riders: DamageRider[];
  /** Advantage on saving throws, ability checks, Initiative or attack rolls. */
  advantages: AdvantageGrant[];
  /** Rules in code it switches on (Evasion). */
  rules: FeatureRule[];
  /** Ability modifiers added to some spells' damage. */
  spell_damage: SpellDamage[];
  /** Features you use in a turn (Second Wind, Action Surge). */
  actions: FeatureActionDef[];
  /** Features you switch on in play (Rage); their grants apply while active. */
  toggles: ToggleDef[];
  /** Spells cast without a slot, spending a use (Magic Initiate). Optional. */
  free_casts?: FreeCast[];
  /** d20 floors on ability checks (Reliable Talent-like features in packs). Optional. */
  d20_floors?: D20Floor[];
  items: ItemGrant[];
  gp: number;
  traits: Trait[];
  choices: ChoiceDef[];
  /**
   * More grants that switch on as the source's class gains levels, e.g. a subclass's spells at
   * class levels 5, 7 and 9, or what a Land type gives at level 10.
   */
  at_class_level: { level: number; grants: Grants }[];
}

/** Grants fields that are plain lists of ids, usable with `Resolution.granted()`. */
export type GrantedIdList =
  | "armor_training"
  | "weapon_proficiencies"
  | "resistances"
  | "cantrips"
  | "spells";

export const ChoiceOptionSchema: z.ZodType<ChoiceOption, unknown> = z
  .lazy(() =>
    z.strictObject({
      id: z.string(),
      name: z.string(),
      description: z.string().default(""),
      grants: GrantsSchema.prefault({}),
    }),
  )
  .meta({ id: "ChoiceOption" });

export const ChoiceDefSchema: z.ZodType<ChoiceDef, unknown> = z
  .lazy(() =>
    z
      .strictObject({
        id: z.string(),
        label: z.string(),
        kind: z.enum(CHOICE_KINDS),
        count: z.int().min(1).default(1),
        options: z.array(ChoiceOptionSchema).default([]),
        allowed: z.array(z.string()).nullable().default(null),
        category: z
          .union([z.string(), z.array(z.string())])
          .transform((c) => (typeof c === "string" ? [c] : c))
          .nullable()
          .default(null),
        step: z.enum(STEPS).nullable().default(null),
        hint: z.string().default(""),
        spell_level: z.int().min(0).max(9).nullable().default(null),
        max_spell_level: z.int().min(1).max(9).nullable().default(null),
        spell_list: z
          .union([z.string(), z.array(z.string())])
          .transform((c) => (typeof c === "string" ? [c] : c))
          .nullable()
          .default(null),
        known_only: z.boolean().default(false),
        tag: z.string().nullable().default(null),
        max_score: z.int().default(20),
        ritual: z.boolean().default(false),
        school: z.string().nullable().default(null),
        always_prepared: z.boolean().default(false),
        subset_of: z.string().nullable().default(null),
        scaling: z
          .strictObject({
            count: z.array(z.int().min(0)).length(20).nullable().default(null),
            max_spell_level: z.array(z.int().min(0).max(9)).length(20).nullable().default(null),
          })
          .nullable()
          .default(null),
        swap: z.enum(["class_level", "any_level"]).nullable().default(null),
        same_level: z.boolean().default(false),
        rest_change: z.enum(["short", "long"]).nullable().default(null),
        weapon_kind: z.enum(["melee", "ranged"]).nullable().default(null),
      })
      .refine((c) => c.swap === null || c.tag !== null, {
        error: (issue) =>
          `choice '${(issue.input as { id?: string }).id}': a choice with \`swap\` needs a \`tag\` (its family)`,
      })
      .refine((c) => (c.kind === "option") === c.options.length > 0, {
        error: (issue) =>
          `choice '${(issue.input as { id?: string }).id}': inline options are required iff kind=option`,
      }),
  )
  .meta({ id: "ChoiceDef" });

/** Everything a content source gives the character, plus the choices it asks for. */
const ToggleSchema: z.ZodType<ToggleDef, unknown> = z.lazy(() =>
  z.strictObject({
    id: z.string(),
    name: z.string(),
    uses: z.string().nullable().default(null),
    grants: GrantsSchema,
    blocked_when: z.array(z.enum(EFFECT_CONDITIONS)).default([]),
    ends_on: z.array(z.string()).default([]),
    no_spells: z.boolean().default(false),
    extends_each_turn: z.boolean().default(false),
    ends_at_turn_start: z.boolean().default(false),
    rounds: z.int().min(1).nullable().default(null),
  }),
);

export const GrantsSchema: z.ZodType<Grants, unknown> = z
  .lazy(() =>
    z.strictObject({
      size: z.enum(SIZES).nullable().default(null),
      skills: z.array(z.enum(SKILLS)).default([]),
      tools: z.array(z.string()).default([]),
      languages: z.array(z.string()).default([]),
      saving_throws: z.array(z.enum(ABILITIES)).default([]),
      armor_training: z.array(z.string()).default([]),
      weapon_proficiencies: z.array(z.string()).default([]),
      feats: z.array(FeatGrantSchema).default([]),
      resistances: z.array(z.string()).default([]),
      cantrips: z.array(z.string()).default([]),
      spells: z.array(z.string()).default([]),
      spellcasting: SpellcastingSchema.nullable().default(null),
      ac_calculations: z.array(AcCalculationSchema).default([]),
      ability_bonuses: z.array(AbilityBonusSchema).default([]),
      resources: z.array(ResourceSchema).default([]),
      on_long_rest: z.array(z.enum(["heroic_inspiration"])).default([]),
      effects: z.array(EffectSchema).default([]),
      damage_riders: z.array(DamageRiderSchema).default([]),
      advantages: z.array(AdvantageGrantSchema).default([]),
      rules: z.array(z.enum(FEATURE_RULES)).default([]),
      spell_damage: z.array(SpellDamageSchema).default([]),
      actions: z.array(FeatureActionSchema).default([]),
      toggles: z.array(ToggleSchema).default([]),
      free_casts: z.array(FreeCastSchema).optional(),
      d20_floors: z.array(D20FloorSchema).optional(),
      items: z.array(ItemGrantSchema).default([]),
      gp: z.int().default(0),
      traits: z.array(TraitSchema).default([]),
      choices: z.array(ChoiceDefSchema).default([]),
      at_class_level: z
        .array(z.strictObject({ level: z.int().min(1).max(20), grants: GrantsSchema }))
        .default([]),
    }),
  )
  .meta({ id: "Grants" });

/** The builder step a choice is asked in. */
export function choiceStep(choice: ChoiceDef): Step {
  return choice.step ?? DEFAULT_STEP_BY_KIND[choice.kind] ?? "features";
}

/**
 * Where content comes from when an entity doesn't say: `createCatalog` fills in the pack's name
 * instead (`srd-5.2.1` for the SRD folder), so this default only applies to schemas used alone.
 */
export const DEFAULT_SOURCE = "homebrew";

const entity = {
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lowercase slugs"),
  name: z.string(),
  source: z.string().default(DEFAULT_SOURCE),
  description: z.string().default(""),
};

export const SpeciesSchema = z.strictObject({
  ...entity,
  creature_type: z.string().default("Humanoid"),
  grants: GrantsSchema,
});
export type SpeciesDef = z.infer<typeof SpeciesSchema>;

export const BackgroundSchema = z.strictObject({
  ...entity,
  ability_scores: z.array(z.enum(ABILITIES)).length(3),
  grants: GrantsSchema,
});
export type BackgroundDef = z.infer<typeof BackgroundSchema>;

export const ClassSchema = z.strictObject({
  ...entity,
  primary_abilities: z.array(z.enum(ABILITIES)),
  /** `any` (Str OR Dex) or `all` (Dex AND Wis). */
  primary_mode: z.enum(["any", "all"]).default("any"),
  hit_die: z.int(),
  complexity: z.string(),
  standard_array: z.record(z.enum(ABILITIES), z.int()),
  /** Core traits, gained only when this is your first class: saves, skills, proficiencies, gear. */
  grants: GrantsSchema,
  /** What you gain instead of `grants` when you multiclass into this class. */
  multiclass: GrantsSchema.prefault({}),
  /** Features by class level (`1`–`20`). Level 1 features apply to both starting and multiclass. */
  features: z.record(z.string().regex(/^([1-9]|1[0-9]|20)$/), GrantsSchema).default({}),
  /**
   * Named columns of the class table, one value per class level (20 values), shown on the
   * sheet as class resources, e.g. `Rages: [2, 2, 3, …]`.
   */
  progression: z.record(z.string(), z.array(z.union([z.int(), z.string()])).length(20)).default({}),
  /** The class level at which you choose a subclass. */
  subclass_level: z.int().min(1).max(20).default(3),
});
export type ClassDef = z.infer<typeof ClassSchema>;

export const SubclassSchema = z.strictObject({
  ...entity,
  /** The class this subclass belongs to. */
  class: z.string(),
  /** Features by class level. */
  features: z.record(z.string().regex(/^([1-9]|1[0-9]|20)$/), GrantsSchema).default({}),
});
export type SubclassDef = z.infer<typeof SubclassSchema>;

/**
 * What you need to take a feat or a class feature option. Every listed condition must hold.
 * Character level counts levels in all classes; `class_level` counts one class.
 */
export const PrerequisiteSchema = z.strictObject({
  level: z.int().nullable().default(null),
  class_level: z
    .strictObject({ class: z.string(), level: z.int().default(1) })
    .nullable()
    .default(null),
  /** At least one of these abilities must have a score of `min` or more. */
  abilities: z
    .strictObject({ any_of: z.array(z.enum(ABILITIES)), min: z.int() })
    .nullable()
    .default(null),
  /** Feats or features (ids) you must already have. */
  requires: z.array(z.string()).default([]),
  /** A trait you must have, by name (e.g. "Fighting Style"). */
  trait: z.string().nullable().default(null),
  /** You must have a Spellcasting or Pact Magic feature. */
  spellcasting: z.boolean().default(false),
  /** You must know at least one of these spells. */
  spells: z.array(z.string()).default([]),
});
export type Prerequisite = z.infer<typeof PrerequisiteSchema>;

export const FeatSchema = z.strictObject({
  ...entity,
  /** origin, general, fighting_style, epic_boon; features: eldritch_invocation, metamagic */
  category: z.string(),
  prerequisite: PrerequisiteSchema.nullable().default(null),
  repeatable: z.boolean().default(false),
  /** For repeatable feats: each instance must pick a different value for this choice id. */
  repeat_requires_different: z.string().nullable().default(null),
  grants: GrantsSchema.prefault({}),
  /** Notes about parts of the feat the builder does not automate yet. */
  unsupported: z.string().default(""),
});
export type FeatDef = z.infer<typeof FeatSchema>;

export const WeaponSchema = z.strictObject({
  ...entity,
  category: z.enum(["simple", "martial"]),
  kind: z.enum(["melee", "ranged"]),
  damage: z.string(),
  damage_type: z.string(),
  properties: z.array(z.string()).default([]),
  versatile_damage: z.string().nullable().default(null),
  range: z.string().nullable().default(null),
  mastery: z.string(),
  weight: z.string().default(""),
  cost: z.string().default(""),
});
export type WeaponDef = z.infer<typeof WeaponSchema>;

export const ArmorSchema = z.strictObject({
  ...entity,
  category: z.enum(["light", "medium", "heavy", "shield"]),
  base_ac: z.int(),
  /** `null` = no cap; `0` = Dex not added. */
  dex_cap: z.int().nullable().default(null),
  strength: z.int().nullable().default(null),
  stealth_disadvantage: z.boolean().default(false),
  weight: z.string().default(""),
  cost: z.string().default(""),
});
export type ArmorDef = z.infer<typeof ArmorSchema>;

export const GearSchema = z.strictObject({
  ...entity,
  /** Its price (`2 GP`, `5 SP`), for a `bundle` of this many (Arrows: 20). */
  cost: z.string().default(""),
  weight: z.string().default(""),
  bundle: z.int().min(1).default(1),
  /** Ammunition (SRD "Ammunition" table): what a magic item of kind `ammunition` is made from. */
  ammunition: z.boolean().default(false),
});
export type GearDef = z.infer<typeof GearSchema>;

export const ToolSchema = z.strictObject({
  ...entity,
  /** artisan | gaming-set | musical-instrument | other */
  category: z.string(),
  cost: z.string().default(""),
  weight: z.string().default(""),
});
export type ToolDef = z.infer<typeof ToolSchema>;

export const LanguageSchema = z.strictObject({
  ...entity,
  /** standard | rare */
  category: z.string(),
});
export type LanguageDef = z.infer<typeof LanguageSchema>;

export const MasterySchema = z.strictObject({ ...entity });
export type MasteryDef = z.infer<typeof MasterySchema>;

export const SPELL_AREAS = ["cone", "cube", "cylinder", "emanation", "line", "sphere"] as const;

/**
 * An area of effect (SRD "Area of Effect"): `size` is a Sphere's, Cylinder's or Emanation's
 * radius, a Cone's or Line's length, or a Cube's side, in feet; a Line's `width` (5 by default).
 */
export const SpellAreaSchema = z.strictObject({
  shape: z.enum(SPELL_AREAS),
  size: z.int().min(1),
  width: z.int().min(1).default(5),
});
export type SpellArea = z.infer<typeof SpellAreaSchema>;

/**
 * What a spell does, as data (`castSpell` uses it). Anything not listed here stays in the
 * spell's text: durations, movement, repeated saves, choices made while casting.
 */
export const SpellMechanicsSchema = z
  .strictObject({
    /** A spell attack roll against each target. */
    attack: z.enum(["melee", "ranged"]).nullable().default(null),
    /** A saving throw each target makes; on a success, half damage or none. */
    save: z
      .strictObject({
        ability: z.enum(ABILITIES),
        on_success: z.enum(["half", "none"]).default("none"),
      })
      .nullable()
      .default(null),
    /** Damage on a hit or a failed save (rolled once for all targets of a save). */
    damage: z
      .array(
        z.strictObject({
          dice: Dice,
          type: z.enum(DAMAGE_TYPES),
          /** Add the spellcasting ability modifier. */
          add_modifier: z.boolean().default(false),
          /** A flat bonus: Magic Missile's `1d4 + 1`. */
          bonus: z.int().min(0).default(0),
        }),
      )
      .default([]),
    /** Hit Points each target regains. */
    heal: z
      .strictObject({ dice: Dice, add_modifier: z.boolean().default(false) })
      .nullable()
      .default(null),
    /** How many creatures it can target (`null`: an area, or not limited). */
    targets: z.int().min(1).nullable().default(null),
    /** Per spell slot level above the spell's level. */
    upcast: z
      .strictObject({
        /** Dice added to the damage of the same type. */
        damage: z.array(z.strictObject({ dice: Dice, type: z.enum(DAMAGE_TYPES) })).default([]),
        heal: Dice.nullable().default(null),
        /** More targets. */
        targets: z.int().min(0).default(0),
      })
      .nullable()
      .default(null),
    /**
     * Cantrip Upgrade at character levels 5, 11 and 17: more damage dice (`dice`: 2, 3, 4 times
     * the dice), or more attacks (`beams`: Eldritch Blast).
     */
    cantrip_scaling: z.enum(["dice", "beams"]).nullable().default(null),
    /**
     * Conditions a target gets on a failed save or when hit; `until`: they end at the start or end
     * of the caster's next turn (otherwise a Concentration spell's last while it does).
     */
    conditions: z
      .array(
        z.strictObject({
          condition: z.string(),
          on: z.enum(["failed_save", "hit"]),
          until: z
            .enum(["start_of_your_next_turn", "end_of_your_next_turn", "end_of_its_turn"])
            .nullable()
            .default(null),
          /** The creature can take an action to end it with a check against the spell save DC. */
          escape: z.enum(["athletics"]).nullable().default(null),
          /** The condition ends when the target takes damage (Mass Suggestion). */
          ends_on_damage: z.boolean().default(false),
        }),
      )
      .default([]),
    area: SpellAreaSchema.nullable().default(null),
    /**
     * Darts or rays (Magic Missile, Scorching Ray): `count`, plus `upcast` per slot level above
     * the spell's. Each is a spell attack with `attack`, else it hits automatically; aimed at one
     * target or split among several.
     */
    projectiles: z
      .strictObject({ count: z.int().min(2), upcast: z.int().min(0).default(0) })
      .nullable()
      .default(null),
    /**
     * A saving throw after the spell attack, hit or miss, by the target and each creature within
     * `radius` feet of it (Ice Knife); its damage is rolled once for all of them.
     */
    follow_up: z
      .strictObject({
        save: z.strictObject({
          ability: z.enum(ABILITIES),
          on_success: z.enum(["half", "none"]).default("none"),
        }),
        damage: z.array(z.strictObject({ dice: Dice, type: z.enum(DAMAGE_TYPES) })).min(1),
        /** Dice added per spell slot level above the spell's level. */
        upcast: z.array(z.strictObject({ dice: Dice, type: z.enum(DAMAGE_TYPES) })).default([]),
        radius: z.int().min(0).default(0),
      })
      .nullable()
      .default(null),
    /**
     * What a hit does besides damage and conditions: `advantage_against` gives the next attack
     * roll against the target Advantage, until the end of the caster's next turn (Guiding Bolt).
     */
    on_hit: z.array(z.enum(["advantage_against"])).default([]),
    /**
     * Damage types the caster picks from when casting, for every damage part (Spirit Guardians:
     * Radiant or Necrotic); empty when the damage types are fixed.
     */
    damage_types: z.array(z.enum(DAMAGE_TYPES)).default([]),
    /**
     * An area that lasts (Moonbeam, Spirit Guardians): its save, damage and conditions happen
     * again when a creature enters it (or it moves onto one), or starts or ends its turn there;
     * `move`: its damage for every 5 feet a creature moves into or within it (Spike Growth).
     */
    zone: z
      .strictObject({
        triggers: z.array(z.enum(["enter", "start_turn", "end_turn", "move"])).min(1),
        /** "A creature makes this save only once per turn." */
        once_per_turn: z.boolean().default(true),
        /** Creatures in the area save when it appears (Spirit Guardians and Web: no). */
        on_cast: z.boolean().default(true),
        /** The caster can designate creatures it doesn't affect (Spirit Guardians). */
        designate: z.boolean().default(false),
        /** The caster chooses each time whether to force the save (Conjure Animals). */
        optional: z.boolean().default(false),
        /**
         * Where an Emanation spreads from: the caster, or a point it's placed at (Conjure
         * Animals' pack, Flaming Sphere) whose space is `space` squares wide.
         */
        anchor: z.enum(["caster", "point"]).default("caster"),
        space: z.int().min(1).max(4).default(1),
        /** Moving it into a creature's space makes that creature save (Flaming Sphere). */
        ram: z.boolean().default(false),
        /** What a failed save also does: no action or Bonus Action this turn, Concentration lost. */
        on_fail: z.array(z.enum(["no_actions", "lose_concentration"])).default([]),
        /** Its area is Difficult Terrain while it lasts (Web, Spike Growth). */
        difficult: z.boolean().default(false),
        /** Other creatures' Speed is halved in it (Spirit Guardians). */
        speed_halved: z.boolean().default(false),
      })
      .nullable()
      .default(null),
    /**
     * A wall placed from point to point (`cast` `wall: {from, to}`), up to `length` feet. `between`:
     * it stands on grid lines between squares and nothing passes it (Wall of Force, Stone, Ice);
     * otherwise it fills a line of 5-foot squares (Blade Barrier, Wall of Thorns, Wall of Fire):
     * creatures in it save when it appears (`save`, `damage`), and with a `zone` they save again
     * (`later: save`, with `later_type` if it differs) or just take damage (`later: damage`).
     */
    /** Cast right after hitting the target with a melee attack this turn (Divine Smite). */
    after_hit: z.boolean().default(false),
    /** More dice against these creature types (Divine Smite: Fiends and Undead). */
    bonus_vs: z
      .strictObject({ creature_types: z.array(z.string()).min(1), dice: Dice })
      .nullable()
      .default(null),
    /**
     * A mark on the target while the caster concentrates: extra damage when the caster hits it
     * with an attack roll (Hunter's Mark, Hex), moved with `move_mark` once the target drops.
     */
    mark: z
      .strictObject({ dice: Dice, type: z.enum(DAMAGE_TYPES) })
      .nullable()
      .default(null),
    wall: z
      .strictObject({
        length: z.int().min(5),
        between: z.boolean().default(false),
        /** What lines through its squares get: Three-Quarters (Blade Barrier) or Total Cover. */
        cover: z.enum(["three_quarters", "total"]).nullable().default(null),
        difficult: z.boolean().default(false),
        /** Feet of movement per foot moved through it (Wall of Thorns: 4). */
        cost: z.int().min(1).default(1),
        /** Feet beyond its chosen side that its zone reaches (Wall of Fire: 10). */
        side: z.int().min(0).nullable().default(null),
        later: z.enum(["save", "damage"]).default("save"),
        /** The later damage's type, when it differs (Wall of Thorns: Slashing). */
        later_type: z.enum(DAMAGE_TYPES).nullable().default(null),
      })
      .nullable()
      .default(null),
  })
  .refine((m) => !(m.attack && m.save), "a spell has an attack roll or a saving throw, not both")
  .refine((m) => !m.follow_up || m.attack, "a follow-up saving throw comes after a spell attack")
  .refine((m) => !m.projectiles || !m.save, "projectiles are spell attacks or automatic hits")
  .refine(
    (m) =>
      !m.zone ||
      ((m.area || m.wall) &&
        (m.save || m.wall?.later === "damage" || m.zone.triggers.every((t) => t === "move"))),
    "a zone has an area or a wall, and a saving throw unless it only deals damage",
  )
  .meta({ id: "SpellMechanics" });
export type SpellMechanics = z.infer<typeof SpellMechanicsSchema>;

export const SpellDefSchema = z.strictObject({
  ...entity,
  level: z.int().min(0).max(9),
  school: z.string(),
  /** Class spell lists that include this spell, e.g. `[cleric, druid]`. */
  lists: z.array(z.string()),
  casting_time: z.string(),
  ritual: z.boolean().default(false),
  range: z.string(),
  components: z.string(),
  duration: z.string(),
  concentration: z.boolean().default(false),
  /** What the spell does, as data; `null` while it's only text. */
  mechanics: SpellMechanicsSchema.nullable().default(null),
});
export type SpellDef = z.infer<typeof SpellDefSchema>;

/** Advantage or Disadvantage on a D20 Test. */
const RollModeSchema = z.enum(["advantage", "disadvantage"]);

/** A condition (SRD Rules Glossary). Exhaustion has levels; others are on or off. */
export const ConditionSchema = z.strictObject({
  ...entity,
  /** Your Speed is 0 and can't increase. */
  speed_zero: z.boolean().default(false),
  /** Conditions this one includes (Unconscious: Incapacitated and Prone). */
  implies: z.array(z.string()).default([]),
  /** Stacks in levels (Exhaustion: 1–6). */
  levels: z.boolean().default(false),
  /** Advantage or Disadvantage on its own attack rolls (Blinded, Poisoned: Disadvantage). */
  attack_rolls: RollModeSchema.nullable().default(null),
  /** On attack rolls against it from within 5 feet… */
  attacked: RollModeSchema.nullable().default(null),
  /** …and from farther away (Prone: Advantage within 5 feet, Disadvantage beyond). */
  attacked_beyond_5ft: RollModeSchema.nullable().default(null),
  /** A hit on it from within 5 feet is a Critical Hit (Paralyzed, Unconscious). */
  critical_within_5ft: z.boolean().default(false),
  /** Saving throws it fails automatically (Paralyzed: Strength and Dexterity). */
  fail_saves: z.array(z.enum(ABILITIES)).default([]),
  /** Saving throws it makes with Disadvantage (Restrained: Dexterity). */
  save_disadvantage: z.array(z.enum(ABILITIES)).default([]),
  /** Advantage or Disadvantage on Initiative (Invisible, Incapacitated). */
  initiative: RollModeSchema.nullable().default(null),
  /** Advantage or Disadvantage on ability checks (Poisoned, Frightened: Disadvantage). */
  ability_checks: RollModeSchema.nullable().default(null),
  /**
   * `attack_rolls` doesn't apply to attacks against the condition's source (Grappled: "any
   * target other than the grappler"), when the source is known.
   */
  except_against_source: z.boolean().default(false),
});
export type ConditionDef = z.infer<typeof ConditionSchema>;

export const MAGIC_ITEM_CATEGORIES = [
  "armor",
  "weapon",
  "ammunition",
  "potion",
  "ring",
  "rod",
  "scroll",
  "staff",
  "wand",
  "wondrous",
] as const;

/**
 * A magic item. Armor, weapons and some staffs are magic versions of a mundane item: `base`
 * says which ones, and each item in an inventory records the one it is. While the item is
 * active (worn or held, and attuned if it requires Attunement) its `grants` apply, and `bonus`
 * adds to the base weapon's attacks or the base armor's AC.
 */
export const MagicItemSchema = z.strictObject({
  ...entity,
  category: z.enum(MAGIC_ITEM_CATEGORIES),
  rarity: z.string(),
  attunement: z.boolean().default(false),
  /** Who can attune, as the SRD words it ("a Paladin", "a Spellcaster"). */
  attunement_by: z.string().nullable().default(null),
  /** Classes allowed to attune, parsed from `attunement_by` (empty: anyone, or see the text). */
  attunement_classes: z.array(z.string()).default([]),
  /** Attunement needs a Spellcasting or Pact Magic feature. */
  attunement_spellcaster: z.boolean().default(false),
  base: z
    .strictObject({
      kind: z.enum(["weapon", "armor", "shield", "ammunition"]),
      ids: z.array(z.string()).nullable().default(null),
      categories: z.array(z.string()).nullable().default(null),
      except: z.array(z.string()).default([]),
      /** For weapons: only melee (Flame Tongue: "Any Melee Weapon") or only ranged. */
      weapon_kind: z.enum(["melee", "ranged"]).nullable().default(null),
    })
    .nullable()
    .default(null),
  bonus: z
    .strictObject({
      attack: z.int().default(0),
      damage: z.int().default(0),
      ac: z.int().default(0),
      spell_attack: z.int().default(0),
    })
    .prefault({}),
  grants: GrantsSchema.prefault({}),
  /** `equipped` (worn or held) or `carried` ("while it is on your person"). */
  active_when: z.enum(["equipped", "carried"]).default("equipped"),
  charges: z.int().nullable().default(null),
  consumable: z.boolean().default(false),
  /** The base armor loses its Strength requirement and Stealth Disadvantage (Mithral). */
  ignores_armor_penalties: z.boolean().default(false),
  /** Hit Points regained when used (potions), as dice: `2d4+2`. */
  heal: z.string().nullable().default(null),
  /** Kinds of this item; each inventory item picks one (Ring of Resistance: the damage type). */
  variants: z
    .array(z.strictObject({ id: z.string(), name: z.string(), grants: GrantsSchema.prefault({}) }))
    .default([]),
});
export type MagicItemDef = z.infer<typeof MagicItemSchema>;

/** Damage as a stat block writes it: `13 (1d10 + 8) Slashing`, or a fixed `1 Piercing`. */
const MonsterDamageSchema = z.strictObject({
  average: z.int(),
  dice: Dice.nullable().default(null),
  bonus: z.int().default(0),
  type: z.enum(DAMAGE_TYPES),
});
export type MonsterDamage = z.infer<typeof MonsterDamageSchema>;

/**
 * A trait or action of a stat block. `text` is always the SRD's; `attack` (an attack roll) or
 * `save` (a saving throw effect, like a breath weapon) hold what combat can resolve.
 */
export const MonsterActionSchema = z.strictObject({
  name: z.string(),
  text: z.string(),
  /** `5–6`: it recharges on those d6 rolls. */
  recharge: z.string().nullable().default(null),
  /** A legendary action it can't take again until the start of its next turn. */
  once_per_round: z.boolean().default(false),
  /** A legendary action's attacks, by the monster's action names (one of them). */
  attacks: z.array(z.string()).default([]),
  /** A legendary action that uses another of its actions ("uses Lightning Strike"). */
  uses: z.string().nullable().default(null),
  /** Uses per day from its name ("Divine Aid (2/Day)"), shared by everything it does. */
  per_day: z.int().min(1).nullable().default(null),
  /**
   * The spells it casts (SRD "Spellcasting"): the Spellcasting action's lists, an action that
   * casts one of a few spells, or a legendary action that uses Spellcasting.
   */
  casts: z
    .strictObject({
      ability: z.enum(ABILITIES),
      save_dc: z.int().nullable(),
      attack_bonus: z.int().nullable(),
      spells: z.array(
        z.strictObject({
          spell: z.string(),
          /** "(level 3 version)": always cast at that level; `null`: the spell's level. */
          level: z.int().min(1).max(9).nullable().default(null),
          /** "1/Day Each": uses per day of this spell; `null`: at will (or the action's `per_day`). */
          per_day: z.int().min(1).nullable().default(null),
          /** A restriction from the stat block ("self only", "Beast or Humanoid form only…"). */
          note: z.string().default(""),
        }),
      ),
    })
    .nullable()
    .default(null),
  attack: z
    .strictObject({
      kind: z.enum(["melee", "ranged", "melee_or_ranged"]),
      bonus: z.int(),
      reach: z.int().nullable().default(null),
      /** `80/320` feet. */
      range: z.string().nullable().default(null),
      /** On a hit; conditions and other riders stay in the text. */
      damage: z.array(MonsterDamageSchema).default([]),
    })
    .nullable()
    .default(null),
  save: z
    .strictObject({
      ability: z.enum(ABILITIES),
      dc: z.int(),
      /** On a failed save. */
      damage: z.array(MonsterDamageSchema).default([]),
      on_success: z.enum(["half", "none"]).default("none"),
      /** Conditions on a failed save. */
      conditions: z.array(z.string()).default([]),
      /** The area it fills ("60-foot Cone"); `null`: the creatures it names. */
      area: SpellAreaSchema.nullable().default(null),
      /** "within 90 feet": how far its target, or its area's point, can be. */
      range: z.int().nullable().default(null),
    })
    .nullable()
    .default(null),
  /** A trait's `save` happens when the monster dies (Death Burst), in its area. */
  trigger: z.enum(["death"]).nullable().default(null),
  /**
   * Damage at the end of each of its turns to each creature in an Emanation of `size` feet (Fire
   * Aura); `choice`: the creatures of its choice (its enemies, by default); `not_incapacitated`:
   * not while it's Incapacitated.
   */
  aura: z
    .strictObject({
      size: z.int().min(5),
      damage: z.array(MonsterDamageSchema).min(1),
      choice: z.boolean().default(false),
      not_incapacitated: z.boolean().default(false),
    })
    .nullable()
    .default(null),
  /** Advantage on attack rolls and saves for it and its allies within `size` feet (Aura of Authority). */
  advantage_aura: z
    .strictObject({ size: z.int().min(5) })
    .nullable()
    .default(null),
  /**
   * It regains `amount` Hit Points at the start of each of its turns unless it took damage of a
   * `stopped_by` type since its last turn, and dies only if it starts its turn at 0 Hit Points
   * and doesn't regenerate (Troll).
   */
  regeneration: z
    .strictObject({ amount: z.int().min(1), stopped_by: z.array(z.enum(DAMAGE_TYPES)) })
    .nullable()
    .default(null),
});
export type MonsterAction = z.infer<typeof MonsterActionSchema>;

const abilityRecord = z.strictObject({
  str: z.int(),
  dex: z.int(),
  con: z.int(),
  int: z.int(),
  wis: z.int(),
  cha: z.int(),
});

/** A monster or animal stat block (SRD "Monsters A–Z", "Animals"). */
export const MonsterSchema = z.strictObject({
  ...entity,
  /** The SRD heading it's listed under, when several stat blocks share one (Animated Objects). */
  group: z.string().nullable().default(null),
  /** `Large`, or `Medium or Small`. */
  size: z.string(),
  /** `Dragon (Chromatic)`. */
  creature_type: z.string(),
  alignment: z.string(),
  armor_class: z.int(),
  initiative: z.int(),
  hit_points: z.int(),
  /** `19d12+133`; `null` when the stat block gives only a number. */
  hit_dice: z.string().nullable().default(null),
  /** Feet by mode: `{ walk: 40, fly: 80 }`. */
  speed: z.record(z.string(), z.int()),
  hover: z.boolean().default(false),
  /** Speeds with a qualifier: "Climb 30 ft. (bear form only)". */
  speed_note: z.string().default(""),
  /** Ability scores. */
  abilities: abilityRecord,
  /** Saving throw bonuses (the stat block's SAVE column). */
  saving_throws: abilityRecord,
  skills: z.record(z.string(), z.int()).default({}),
  resistances: z.array(z.enum(DAMAGE_TYPES)).default([]),
  vulnerabilities: z.array(z.enum(DAMAGE_TYPES)).default([]),
  immunities: z.array(z.enum(DAMAGE_TYPES)).default([]),
  condition_immunities: z.array(z.string()).default([]),
  /** Defense entries that aren't plain damage types ("…from weapons wielded by…"). */
  defenses_note: z.string().default(""),
  gear: z.string().default(""),
  senses: z.string().default(""),
  passive_perception: z.int(),
  languages: z.string().default(""),
  /** Challenge Rating: `17`, `1/4`. */
  cr: z.string(),
  xp: z.int(),
  proficiency_bonus: z.int(),
  /** Attacks its Multiattack makes (`null`: no Multiattack, or not a plain count). */
  multiattack: z.int().min(1).nullable().default(null),
  traits: z.array(MonsterActionSchema).default([]),
  actions: z.array(MonsterActionSchema).default([]),
  bonus_actions: z.array(MonsterActionSchema).default([]),
  reactions: z.array(MonsterActionSchema).default([]),
  /** The paragraph before the Legendary Actions (uses per round). */
  legendary_text: z.string().default(""),
  /** Legendary action uses per round, and in its lair. */
  legendary_uses: z
    .strictObject({ uses: z.int().min(1), in_lair: z.int().min(1).nullable().default(null) })
    .nullable()
    .default(null),
  /** Legendary Resistance uses per day, and in its lair: a failed save can succeed instead. */
  legendary_resistance: z
    .strictObject({ uses: z.int().min(1), in_lair: z.int().min(1).nullable().default(null) })
    .nullable()
    .default(null),
  legendary_actions: z.array(MonsterActionSchema).default([]),
});
export type MonsterDef = z.infer<typeof MonsterSchema>;

export const PointBuySchema = z.strictObject({
  budget: z.int(),
  min_score: z.int(),
  max_score: z.int(),
  /** Score → cost. Keys are strings once parsed from JSON/YAML. */
  costs: z.record(z.string().regex(/^\d+$/), z.int()),
});
export type PointBuyRules = z.infer<typeof PointBuySchema>;

export const CreationSchema = z.strictObject({
  source: z.string().default(DEFAULT_SOURCE),
  standard_array: z.array(z.int()),
  point_buy: PointBuySchema,
  max_score_at_creation: z.int(),
  base_grants: GrantsSchema,
  /** Fixed Hit Points per level after 1 are hit die / 2 + 1 (SRD "Gaining a Level"). */
  max_level: z.int().default(20),
  /** Minimum score in the primary abilities to multiclass (into and out of a class). */
  multiclass_min_score: z.int().default(13),
  /**
   * Multiclass Spellcaster table: spell slots per spell level for each caster level (1–20).
   * Single-class full and half casters use it too (their tables match it).
   */
  spell_slots: z.array(z.array(z.int())).length(20),
});
export type CreationRules = z.infer<typeof CreationSchema>;
