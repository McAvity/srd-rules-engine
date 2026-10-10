/**
 * Stateless character builder workflow: validated setters over an immutable build.
 *
 * Every setter returns `{ build, notes }`. Setters reject illegal input with `BuildError`;
 * upstream changes that invalidate downstream choices (e.g. a new background that already
 * grants a skill you picked) are repaired by `normalize` and reported in `notes` so the UI
 * can tell the player what was reset.
 */

import { type Catalog, lookup } from "../content/catalog";
import { MESSAGES_EN } from "../messages/en";
import {
  type AbilityMap,
  type AbilityMethod,
  type Alignment,
  type CharacterBuild,
  characterLevel,
  updateBuild,
} from "../models/build";
import { ABILITIES, STEPS, type Step } from "../models/content";
import type { Message } from "../models/messages";
import {
  backgroundBonusMessages,
  baseScoreMessages,
  definedEntries,
} from "../rules/ability-scores";
import {
  type ActiveChoice,
  answers,
  entityName,
  type Resolution,
  resolve,
} from "../rules/build-resolution";
import {
  type Issue,
  issuesForLevel,
  issuesForStep,
  multiclassBlockerMessages,
  replaceErrorMessages,
  reportErrors,
  type ValidationReport,
  validateBuild,
} from "../rules/build-validation";
import { message, texts, toMessage } from "../rules/messages";
import { computeSheet, type DerivedSheet } from "../rules/sheet";

/** English titles; message codes `step.<id>` (`MESSAGES_EN`) for other languages. */
export const STEP_TITLES: Readonly<Record<Step, string>> = Object.fromEntries(
  STEPS.map((s) => [s, MESSAGES_EN[`step.${s}`]]),
) as Record<Step, string>;

export class BuildError extends Error {
  override name = "BuildError";
  readonly messages: readonly string[];
  /** The same as `messages`, as data to translate: a code, its parameters and the English text. */
  readonly details: readonly Message[];

  constructor(messages: readonly (Message | string)[]) {
    const details = messages.map(toMessage);
    super(texts(details).join("; "));
    this.details = details;
    this.messages = texts(details);
  }
}

export interface BuildResult {
  readonly build: CharacterBuild;
  /** What was changed or reset as a side effect, for the player to read. */
  readonly notes: readonly string[];
  /** The same as `notes`, as data to translate: a code, its parameters and the English text. */
  readonly messages: readonly Message[];
}

/** A setter's result: the build and what it changed or reset. */
function built(build: CharacterBuild, ...notes: (readonly Message[])[]): BuildResult {
  const messages = notes.flat();
  return { build, notes: texts(messages), messages };
}

export interface Evaluation {
  readonly build: CharacterBuild;
  readonly resolution: Resolution;
  readonly report: ValidationReport;
  readonly sheet: DerivedSheet;
}

/** Resolve, validate and compute the sheet in one pass. */
export function evaluate(build: CharacterBuild, catalog: Catalog): Evaluation {
  const resolution = resolve(build, catalog);
  return {
    build,
    resolution,
    report: validateBuild(build, catalog, resolution),
    sheet: computeSheet(build, catalog, resolution),
  };
}

export function stepComplete(ev: Evaluation, step: Step): boolean {
  return issuesForStep(ev.report, step).every((i) => i.severity === "note");
}

export function nextIncompleteStep(ev: Evaluation): Step | null {
  return STEPS.find((s) => !stepComplete(ev, s)) ?? null;
}

// --- setters ------------------------------------------------------------------------------

export function setClass(build: CharacterBuild, catalog: Catalog, classId: string): BuildResult {
  if (!lookup(catalog.classes, classId))
    throw new BuildError([message("builder.unknown_class", { class: classId })]);
  return commit(build, catalog, normalize(updateBuild(build, { class_id: classId }), catalog));
}

export function setSpecies(
  build: CharacterBuild,
  catalog: Catalog,
  speciesId: string,
): BuildResult {
  if (!lookup(catalog.species, speciesId)) {
    throw new BuildError([message("builder.unknown_species", { species: speciesId })]);
  }
  return commit(build, catalog, normalize(updateBuild(build, { species_id: speciesId }), catalog));
}

export function setBackground(
  build: CharacterBuild,
  catalog: Catalog,
  backgroundId: string,
): BuildResult {
  if (!lookup(catalog.backgrounds, backgroundId)) {
    throw new BuildError([message("builder.unknown_background", { background: backgroundId })]);
  }
  const notes: Message[] = [];
  let update: Partial<CharacterBuild> = { background_id: backgroundId };
  if (build.background_id !== backgroundId && definedEntries(build.background_bonus).length) {
    update = { ...update, background_bonus: {} };
    notes.push(message("builder.bonuses_reset_background"));
  }
  const result = normalize(updateBuild(build, update), catalog);
  return commit(build, catalog, built(result.build, notes, result.messages));
}

export function setAbilityMethod(
  build: CharacterBuild,
  catalog: Catalog,
  method: AbilityMethod,
  rolledPool: readonly number[] = [],
): BuildResult {
  if (method === "roll" && rolledPool.length !== 6) {
    throw new BuildError([message("builder.six_rolls")]);
  }
  const update = {
    ability_method: method,
    base_scores: {},
    rolled_pool: method === "roll" ? [...rolledPool] : [],
    background_bonus: {},
  };
  return commit(build, catalog, normalize(updateBuild(build, update), catalog));
}

export function setBaseScores(
  build: CharacterBuild,
  catalog: Catalog,
  scores: AbilityMap,
): BuildResult {
  if (build.ability_method === null) {
    throw new BuildError([message("builder.method_first")]);
  }
  const errors = baseScoreMessages(
    build.ability_method,
    scores,
    catalog.creation,
    build.rolled_pool,
  );
  if (errors.length) throw new BuildError(errors);
  const notes: Message[] = [];
  let update: Partial<CharacterBuild> = { base_scores: { ...scores } };
  if (
    definedEntries(build.background_bonus).length &&
    bonusErrors(build, catalog, build.background_bonus, scores).length
  ) {
    update = { ...update, background_bonus: {} };
    notes.push(message("builder.bonuses_reset_scores"));
  }
  const result = normalize(updateBuild(build, update), catalog);
  return commit(build, catalog, built(result.build, notes, result.messages));
}

export function setBackgroundBonus(
  build: CharacterBuild,
  catalog: Catalog,
  bonus: AbilityMap,
): BuildResult {
  if (build.background_id === null) throw new BuildError([message("builder.background_first")]);
  const errors = bonusErrors(build, catalog, bonus, build.base_scores);
  if (errors.length) throw new BuildError(errors);
  return commit(
    build,
    catalog,
    normalize(updateBuild(build, { background_bonus: { ...bonus } }), catalog),
  );
}

export function setChoice(
  build: CharacterBuild,
  catalog: Catalog,
  key: string,
  values: readonly string[],
): BuildResult {
  const res = resolve(build, catalog);
  const choice = res.choice(key);
  if (!choice) throw new BuildError([message("builder.no_choice", { key })]);
  if (choice.fixed !== null) {
    throw new BuildError([
      message("builder.choice_fixed", { choice: choice.label, source: choice.source.name }),
    ]);
  }
  const errors: Message[] = [];
  if (choice.replaces) {
    const errors = replaceErrorMessages(res, choice, values);
    if (errors.length)
      throw new BuildError(
        errors.map((e) => message("builder.choice_error", { choice: choice.label, error: e })),
      );
    const choices = { ...build.choices, [key]: [...values] };
    return commit(build, catalog, normalize(updateBuild(build, { choices }), catalog));
  }
  const repeats = choice.definition.kind === "ability_increase";
  if (!repeats && new Set(values).size !== values.length) {
    errors.push(message("builder.once_each"));
  }
  const count = res.countOf(choice);
  if (values.length > count) {
    errors.push(message("builder.choose_at_most", { choice: choice.label, count }));
  }
  const views = new Map(res.options(choice).map((v) => [v.id, v]));
  for (const value of values) {
    const view = views.get(value);
    if (!view) errors.push(message("builder.not_option_for", { value, choice: choice.label }));
    else if (view.unavailable_message) {
      errors.push(message("issue.option_why", { name: view.name, why: view.unavailable_message }));
    }
  }
  if (repeats && !errors.length) {
    const before = res.abilityScores(choice.level) as Record<string, number>;
    for (const value of new Set(values)) {
      const n = values.filter((v) => v === value).length;
      if ((before[value] ?? 0) + n > choice.definition.max_score) {
        errors.push(
          message("scores.cap", {
            ability: views.get(value)?.name ?? value,
            cap: choice.definition.max_score,
          }),
        );
      }
    }
  }
  if (errors.length) throw new BuildError(errors);
  const choices = { ...build.choices, [key]: [...values] };
  return commit(build, catalog, normalize(updateBuild(build, { choices }), catalog));
}

// --- levels -------------------------------------------------------------------------------

/** A class you could level up in, with the reason you can't (if any). */
export interface LevelUpOption {
  readonly class_id: string;
  readonly name: string;
  /** Your level in this class after the level-up. */
  readonly class_level: number;
  readonly hit_die: number;
  /** Fixed Hit Points for the level (before your Constitution modifier). */
  readonly fixed_hp: number;
  readonly unavailable: string | null;
  /** `unavailable` as a message (for translation). */
  readonly unavailable_message: Message | null;
}

/** Fixed Hit Points gained per level after 1: half the hit die, plus 1. */
export function fixedHitPoints(hitDie: number): number {
  return Math.floor(hitDie / 2) + 1;
}

/** Every class, with whether the character can take its next level in it. */
export function levelUpOptions(build: CharacterBuild, catalog: Catalog): LevelUpOption[] {
  const res = resolve(build, catalog);
  const current = res.classLevels();
  const next = res.characterLevel + 1;
  const atMax = res.characterLevel >= catalog.creation.max_level;
  return Object.values(catalog.classes).map((cls) => {
    const have = current.get(cls.id) ?? 0;
    let unavailable: Message | null = null;
    if (build.class_id === null) unavailable = message("builder.first_class_at_creation");
    else if (atMax) {
      unavailable = message("builder.already_max_level", { level: catalog.creation.max_level });
    } else if (have === 0) {
      const blockers = multiclassBlockerMessages(res, catalog, [...current.keys(), cls.id], next);
      if (blockers.length) unavailable = message("refusal.all", { reasons: blockers });
    }
    return {
      class_id: cls.id,
      name: cls.name,
      class_level: have + 1,
      hit_die: cls.hit_die,
      fixed_hp: fixedHitPoints(cls.hit_die),
      unavailable: unavailable?.text ?? null,
      unavailable_message: unavailable,
    };
  });
}

/**
 * Gain a level in a class (your current class, or a new one if you meet the multiclass
 * prerequisites). `hp` is the Hit Die roll, or `null` for the fixed value.
 */
export function levelUp(
  build: CharacterBuild,
  catalog: Catalog,
  classId: string,
  hp: number | null = null,
): BuildResult {
  const option = levelUpOptions(build, catalog).find((o) => o.class_id === classId);
  if (!option) throw new BuildError([message("builder.unknown_class", { class: classId })]);
  if (option.unavailable_message)
    throw new BuildError([
      message("builder.class_unavailable", {
        class: option.name,
        why: option.unavailable_message,
      }),
    ]);
  checkRoll(hp, option.hit_die);
  const levels = [...build.levels, { class_id: classId, hp }];
  return commit(build, catalog, normalize(updateBuild(build, { levels }), catalog));
}

/** Change how Hit Points were gained at a level (2+): `null` for fixed, or the Hit Die roll. */
export function setLevelHp(
  build: CharacterBuild,
  catalog: Catalog,
  level: number,
  hp: number | null,
): BuildResult {
  const entry = build.levels[level - 2];
  if (!entry) throw new BuildError([message("builder.no_level", { level })]);
  const cls = lookup(catalog.classes, entry.class_id);
  if (cls) checkRoll(hp, cls.hit_die);
  const levels = build.levels.map((l, i) => (i === level - 2 ? { ...l, hp } : l));
  return commit(build, catalog, built(updateBuild(build, { levels })));
}

/** Undo the last level-up, dropping the choices it made. */
export function removeLastLevel(build: CharacterBuild, catalog: Catalog): BuildResult {
  if (!build.levels.length) throw new BuildError([message("builder.level_1")]);
  const level = characterLevel(build);
  const result = normalize(updateBuild(build, { levels: build.levels.slice(0, -1) }), catalog);
  return commit(
    build,
    catalog,
    built(result.build, [message("builder.level_removed", { level })], result.messages),
  );
}

function checkRoll(hp: number | null, hitDie: number): void {
  if (hp !== null && (!Number.isInteger(hp) || hp < 1 || hp > hitDie)) {
    throw new BuildError([message("builder.hp_roll_range", { die: hitDie, hp })]);
  }
}

/** Whether every choice and check of a level (2+) is done. */
export function levelComplete(ev: Evaluation, level: number): boolean {
  return issuesForLevel(ev.report, level).every((i) => i.severity === "note");
}

/**
 * Change the class a past level (2+) went into. Class features follow the Nth level *in* a class
 * (`class:fighter:3`), so later choices move with them where they still apply; the rest are
 * repaired by `normalize`, and the change is refused if it would leave the character illegal.
 */
export function setLevelClass(
  build: CharacterBuild,
  catalog: Catalog,
  level: number,
  classId: string,
): BuildResult {
  if (level === 1) return setClass(build, catalog, classId);
  const entry = build.levels[level - 2];
  if (!entry) throw new BuildError([message("builder.no_level", { level })]);
  const cls = lookup(catalog.classes, classId);
  if (!cls) throw new BuildError([message("builder.unknown_class", { class: classId })]);
  const notes: Message[] = [];
  let hp = entry.hp;
  if (hp !== null && hp > cls.hit_die) {
    hp = null;
    notes.push(message("builder.hp_roll_reset", { level, die: cls.hit_die }));
  }
  const levels = build.levels.map((l, i) => (i === level - 2 ? { class_id: classId, hp } : l));
  const result = normalize(updateBuild(build, { levels }), catalog);
  return commit(build, catalog, built(result.build, notes, result.messages));
}

// --- override mode: change the past safely -----------------------------------------------

/**
 * Every setter goes through this guard: the change has already been applied and repaired
 * (`normalize` dropped the picks it made illegal), and now the whole build is validated. Any
 * error that wasn't there before is something repair can't fix (a later multiclass level whose
 * prerequisite is no longer met, say), so the change is refused with the validator's own reason
 * and the build stays as it was. No per-case rules: whatever the validator checks, this enforces.
 */
function commit(before: CharacterBuild, catalog: Catalog, result: BuildResult): BuildResult {
  const describe = (i: Issue): Message =>
    i.level > 1 ? message("builder.at_level", { level: i.level, issue: i.detail }) : i.detail;
  const known = new Set(reportErrors(validateBuild(before, catalog)).map((i) => describe(i).text));
  const fresh = reportErrors(validateBuild(result.build, catalog))
    .map(describe)
    .filter((m) => !known.has(m.text));
  if (fresh.length) throw new BuildError(fresh);
  return result;
}

export interface ChangePreview extends BuildResult {
  /** Picks the change would drop (other than the one being edited). */
  readonly removed: readonly { level: number; key: string; label: string; values: string[] }[];
  /** New questions the change creates (e.g. the new subclass's choices). */
  readonly pending: readonly { level: number; message: string; detail: Message }[];
}

/** A sheet number an option would change (`previewOption`). */
export interface StatChange {
  /** `armor_class`, `max_hp`, `initiative`, `speed`, `passive_perception`, or an ability (`str`). */
  readonly stat: string;
  /** `AC`, `HP`, `Initiative`, `Speed`, `Passive Perception`, `Strength`. */
  readonly label: string;
  /** `label` as a message (`stat.*`, `ability.*`), for translation. */
  readonly label_message: Message;
  readonly before: number;
  readonly after: number;
}

/**
 * The sheet numbers picking `value` for choice `choiceKey` would change (AC, HP, Initiative,
 * Speed, Passive Perception, ability scores), compared with the choice left unanswered, as a
 * builder shows next to an option ("AC 16 → 17"). Empty when nothing changes, or until the
 * ability scores are complete. Nothing is validated or committed.
 */
export function previewOption(
  build: CharacterBuild,
  catalog: Catalog,
  choiceKey: string,
  value: string,
): StatChange[] {
  const without = Object.fromEntries(
    Object.entries(build.choices).filter(([k]) => k !== choiceKey),
  );
  const before = computeSheet(updateBuild(build, { choices: without }), catalog);
  const after = computeSheet(
    updateBuild(build, { choices: { ...without, [choiceKey]: [value] } }),
    catalog,
  );
  if (!after.scores_complete) return [];
  const rows: [string, Message, (s: DerivedSheet) => number][] = [
    ["armor_class", message("stat.armor_class"), (s) => s.armor_class.total],
    ["max_hp", message("stat.max_hp"), (s) => s.max_hp?.total ?? 0],
    ["initiative", message("stat.initiative"), (s) => s.initiative.total],
    ["speed", message("stat.speed"), (s) => s.speed.total],
    ["passive_perception", message("stat.passive_perception"), (s) => s.passive_perception],
    ...ABILITIES.map((a): [string, Message, (s: DerivedSheet) => number] => [
      a,
      message(`ability.${a}`),
      (s) => s.scores[a],
    ]),
  ];
  return rows
    .map(([stat, label, of]) => ({
      stat,
      label: label.text,
      label_message: label,
      before: of(before),
      after: of(after),
    }))
    .filter((c) => c.before !== c.after);
}

/**
 * Run a change without committing to it and describe its effect on the rest of the build:
 *
 * ```ts
 * previewChange(build, catalog, (b) => setChoice(b, catalog, "class:fighter:3#subclass", ["x"]))
 * ```
 *
 * Throws `BuildError` if the change is refused. `edited` is the choice key being changed, left
 * out of `removed`.
 */
export function previewChange(
  build: CharacterBuild,
  catalog: Catalog,
  change: (build: CharacterBuild) => BuildResult,
  edited?: string,
): ChangePreview {
  const result = change(build);
  const before = resolve(build, catalog);
  const removed: { level: number; key: string; label: string; values: string[] }[] = [];
  for (const [key, values] of Object.entries(build.choices)) {
    if (key === edited) continue;
    const after = answers(result.build, key);
    const gone = values.filter((v) => !after.includes(v));
    if (!gone.length) continue;
    const choice: ActiveChoice | undefined = before.choice(key);
    removed.push({
      level: choice?.level ?? 1,
      key,
      label: choice?.label ?? key,
      values: choice?.replaces
        ? [values.map((v) => entityName(catalog, v) ?? v).join(" → ")]
        : gone.map((v) => entityName(catalog, v) ?? v),
    });
  }
  const pendingOf = (b: CharacterBuild) =>
    validateBuild(b, catalog).issues.filter((i) => i.severity === "pending");
  const was = new Set(pendingOf(build).map((i) => `${i.level}|${i.message}`));
  const pending = pendingOf(result.build)
    .filter((i) => !was.has(`${i.level}|${i.message}`))
    .map((i) => ({ level: i.level, message: i.message, detail: i.detail }));
  removed.sort((a, b) => a.level - b.level);
  return { ...result, removed, pending };
}

export function setName(build: CharacterBuild, _catalog: Catalog, name: string): BuildResult {
  const trimmed = name.trim();
  if (!trimmed) throw new BuildError([message("builder.empty_name")]);
  return built(updateBuild(build, { name: trimmed }));
}

export function setAlignment(
  build: CharacterBuild,
  _catalog: Catalog,
  alignment: Alignment,
): BuildResult {
  const notes: Message[] = [];
  if (alignment === "LE" || alignment === "NE" || alignment === "CE") {
    notes.push(message("builder.evil_alignment"));
  }
  return built(updateBuild(build, { alignment }), notes);
}

// --- normalization ------------------------------------------------------------------------

/**
 * Drop answers to choices that no longer exist or are no longer legal.
 *
 * Invalid values are removed one at a time, re-resolving in between, so that when two
 * choices conflict only one of them loses the value.
 */
export function normalize(build: CharacterBuild, catalog: Catalog): BuildResult {
  const notes: Message[] = [];
  let current = build;
  for (;;) {
    const res = resolve(current, catalog);
    const active = new Set(res.choices.map((c) => c.key));
    const keys = Object.keys(current.choices);
    if (keys.some((k) => !active.has(k))) {
      const choices = Object.fromEntries(
        Object.entries(current.choices).filter(([k]) => active.has(k)),
      );
      current = updateBuild(current, { choices });
      continue;
    }
    const fix = firstInvalidValue(res);
    if (fix === null) return built(current, notes);
    const [key, index, note] = fix;
    const remaining = index < 0 ? [] : answers(current, key).filter((_, i) => i !== index);
    current = updateBuild(current, { choices: { ...current.choices, [key]: remaining } });
    notes.push(note);
  }
}

/** Find the first illegal answer as [choice key, index in its answer list, note]. */
function firstInvalidValue(res: Resolution): [string, number, Message] | null {
  const repaired = (choice: ActiveChoice, note: Message) =>
    message("builder.repaired", { choice: choice.label, note });
  // Earlier levels first: when two picks conflict, the later one gives way.
  const ordered = [...res.choices].sort((a, b) => a.level - b.level);
  for (const choice of ordered) {
    if (choice.fixed !== null || !Object.hasOwn(res.build.choices, choice.key)) continue;
    if (choice.replaces) {
      const errors = replaceErrorMessages(res, choice);
      const first = errors[0];
      if (first) {
        return [choice.key, -1, repaired(choice, message("builder.removed_why", { why: first }))];
      }
      continue;
    }
    const views = new Map(res.options(choice).map((v) => [v.id, v]));
    const seen = new Set<string>();
    const values = answers(res.build, choice.key);
    if (choice.definition.kind === "ability_increase") {
      const fix = invalidIncrease(
        res,
        choice.key,
        values,
        choice.definition.max_score,
        choice.level,
      );
      if (fix) return [choice.key, fix[0], repaired(choice, fix[1])];
      if (values.length > choice.definition.count) {
        const note = repaired(choice, message("builder.removed_extra_increase"));
        return [choice.key, values.length - 1, note];
      }
      continue;
    }
    for (const [i, value] of values.entries()) {
      const view = views.get(value);
      if (!view && !seen.has(value)) {
        const name = entityName(res.catalog, value);
        const note = name
          ? message("builder.removed_unavailable", { name })
          : message("builder.removed_invalid", { value });
        return [choice.key, i, repaired(choice, note)];
      }
      if (seen.has(value) || !view) {
        return [choice.key, i, repaired(choice, message("builder.removed_invalid", { value }))];
      }
      if (view.unavailable_message) {
        const note = message("builder.removed_because", {
          name: view.name,
          why: view.unavailable_message,
        });
        return [choice.key, i, repaired(choice, note)];
      }
      if (i >= res.countOf(choice)) {
        const note = message("builder.removed_extra", { name: view.name });
        return [choice.key, i, repaired(choice, note)];
      }
      seen.add(value);
    }
  }
  return null;
}

/** The first ability increase that's unknown or goes over the cap, as [index, note]. */
function invalidIncrease(
  res: Resolution,
  _key: string,
  values: readonly string[],
  max: number,
  level: number,
): [number, Message] | null {
  const scores = res.abilityScores(level) as Record<string, number>;
  const running: Record<string, number> = {};
  for (const [i, value] of values.entries()) {
    if (!Object.hasOwn(scores, value)) return [i, message("builder.removed_invalid", { value })];
    running[value] = (running[value] ?? scores[value] ?? 0) + 1;
    if ((running[value] ?? 0) > max) {
      return [i, message("builder.removed_increase", { ability: value.toUpperCase(), max })];
    }
  }
  return null;
}

function bonusErrors(
  build: CharacterBuild,
  catalog: Catalog,
  bonus: AbilityMap,
  base: AbilityMap,
): Message[] {
  const background = lookup(catalog.backgrounds, build.background_id);
  if (!background) return [message("builder.background_first")];
  return backgroundBonusMessages(
    bonus,
    background.ability_scores,
    base,
    catalog.creation.max_score_at_creation,
  );
}
