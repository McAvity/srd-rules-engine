/** The character build: the player's choices, and nothing derived from them. */

import { z } from "zod";
import { MESSAGES_EN } from "../messages/en";
import { ABILITIES, type Ability } from "./content";
import { DocumentVersionSchema } from "./version";

export const ABILITY_METHODS = ["standard_array", "point_buy", "roll"] as const;
export type AbilityMethod = (typeof ABILITY_METHODS)[number];

export const ALIGNMENTS = ["LG", "NG", "CG", "LN", "N", "CN", "LE", "NE", "CE"] as const;
export type Alignment = (typeof ALIGNMENTS)[number];

/** English names; message codes `alignment.<id>` (`MESSAGES_EN`) for other languages. */
export const ALIGNMENT_NAMES: Readonly<Record<Alignment, string>> = Object.fromEntries(
  ALIGNMENTS.map((a) => [a, MESSAGES_EN[`alignment.${a}`]]),
) as Record<Alignment, string>;

export type AbilityMap = Partial<Record<Ability, number>>;

/**
 * One level gained after level 1: the class it goes into, and how Hit Points were gained.
 * `hp: null` takes the fixed value (hit die / 2 + 1); a number is the Hit Die roll, stored so the
 * build stays reproducible.
 */
export const LevelUpSchema = z.object({
  class_id: z.string(),
  hp: z.int().min(1).nullable().default(null),
});

/**
 * A (possibly incomplete) character build. Immutable: setters return a new build.
 *
 * Level 1 is created with `class_id` (the starting class) and the other creation fields; each
 * later level is an entry in `levels` (index 0 is level 2), which may go into another class
 * (multiclassing). `choices` maps an active choice key (see `rules/build-resolution`) to the ids selected for
 * it, e.g. `{"class:fighter#skills": ["athletics", "perception"]}`.
 */
export const CharacterBuildSchema = z.object({
  /** The document format (`DOCUMENT_VERSION`); missing means 1. */
  version: DocumentVersionSchema,
  name: z.string().default(""),
  alignment: z.enum(ALIGNMENTS).nullable().default(null),
  class_id: z.string().nullable().default(null),
  species_id: z.string().nullable().default(null),
  background_id: z.string().nullable().default(null),
  ability_method: z.enum(ABILITY_METHODS).nullable().default(null),
  rolled_pool: z.array(z.int()).default([]),
  base_scores: z.partialRecord(z.enum(ABILITIES), z.int()).default({}),
  background_bonus: z.partialRecord(z.enum(ABILITIES), z.int()).default({}),
  choices: z.record(z.string(), z.array(z.string())).default({}),
  levels: z.array(LevelUpSchema).default([]),
  /**
   * Content packs the build needs besides the SRD (manifest ids). Optional; validation reports
   * a listed pack that isn't loaded, instead of a list of unknown ids.
   */
  packs: z.array(z.string()).optional(),
});

type BuildShape = z.infer<typeof CharacterBuildSchema>;
export type CharacterBuild = DeepReadonly<BuildShape>;

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** Parse and freeze a build, e.g. one loaded from JSON. Throws a `ZodError` if invalid. */
export function parseBuild(input: unknown): CharacterBuild {
  return freezeBuild(CharacterBuildSchema.parse(input));
}

/** An empty build, optionally with some fields already set. */
export function createBuild(fields: Partial<CharacterBuild> = {}): CharacterBuild {
  return parseBuild(fields);
}

/** Total character level: 1 plus every level-up. */
export function characterLevel(build: CharacterBuild): number {
  return 1 + build.levels.length;
}

/** Return a copy of `build` with `update` applied (the equivalent of `model_copy`). */
export function updateBuild(
  build: CharacterBuild,
  update: Partial<CharacterBuild>,
): CharacterBuild {
  return freezeBuild({ ...build, ...update } as BuildShape);
}

function freezeBuild(build: BuildShape): CharacterBuild {
  for (const value of Object.values(build.choices)) Object.freeze(value);
  Object.freeze(build.choices);
  Object.freeze(build.base_scores);
  Object.freeze(build.background_bonus);
  Object.freeze(build.rolled_pool);
  for (const level of build.levels) Object.freeze(level);
  Object.freeze(build.levels);
  return Object.freeze(build);
}
