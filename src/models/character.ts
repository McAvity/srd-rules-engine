import { z } from "zod";

export const CHARACTER_CLASSES = [
  "barbarian",
  "bard",
  "cleric",
  "druid",
  "fighter",
  "monk",
  "paladin",
  "ranger",
  "rogue",
  "sorcerer",
  "warlock",
  "wizard",
] as const;

export const ABILITY_FULL_NAMES = [
  "strength",
  "dexterity",
  "constitution",
  "intelligence",
  "wisdom",
  "charisma",
] as const;
export type AbilityFullName = (typeof ABILITY_FULL_NAMES)[number];

/** An ability given by full name, case-insensitive ("Dexterity", "dexterity"). */
export const AbilityFullNameSchema = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  z.enum(ABILITY_FULL_NAMES),
);

const score = z.int().min(1).max(30);

export const AbilityScoresSchema = z.object({
  strength: score,
  dexterity: score,
  constitution: score,
  intelligence: score,
  wisdom: score,
  charisma: score,
});

/** A combat-ready character snapshot, as used by the combat and spell rules. */
export const CharacterSchema = z.object({
  name: z.string(),
  character_class: z.enum(CHARACTER_CLASSES),
  level: z.int().min(1).max(20),
  ability_scores: AbilityScoresSchema,
  max_hit_points: z.int().min(1),
  current_hit_points: z.int().min(0),
  armor_class: z.int().min(1),
  proficiency_bonus: z.int().min(2).max(6),
  speed: z.int().min(0).default(30),
});
export type Character = Readonly<z.infer<typeof CharacterSchema>>;
