/** Validate a build: illegal choices are errors, missing ones are pending. */

import { type Catalog, lookup, type Table } from "../content/catalog";
import type { CharacterBuild } from "../models/build";
import { ABILITIES, type Step } from "../models/content";
import type { Message } from "../models/messages";
import { backgroundBonusMessages, baseScoreMessages, definedEntries } from "./ability-scores";
import { type ActiveChoice, type Resolution, resolve } from "./build-resolution";
import { message } from "./messages";

export const SEVERITIES = [
  "error", // an illegal choice that must be changed
  "pending", // a choice not made yet
  "note", // informational: something the builder doesn't automate
] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Issue {
  readonly step: Step;
  readonly severity: Severity;
  readonly message: string;
  /** `message` as a message (for translation). */
  readonly detail: Message;
  readonly choice_key: string | null;
  /** The character level the issue belongs to (1 for character creation). */
  readonly level: number;
}

export interface ValidationReport {
  readonly issues: readonly Issue[];
  /** True when nothing is illegal or missing (notes are allowed). */
  readonly is_complete: boolean;
}

function issue(
  step: Step,
  severity: Severity,
  detail: Message,
  choiceKey: string | null = null,
  level = 1,
) {
  return {
    step,
    severity,
    message: detail.text,
    detail,
    choice_key: choiceKey,
    level,
  } satisfies Issue;
}

/** Issues of character creation (level 1) in a step. */

export function issuesForStep(report: ValidationReport, step: Step): Issue[] {
  return report.issues.filter((i) => i.step === step && i.level === 1);
}

/** Issues of a level gained after level 1. */
export function issuesForLevel(report: ValidationReport, level: number): Issue[] {
  return report.issues.filter((i) => i.level === level);
}

export function reportErrors(report: ValidationReport): Issue[] {
  return report.issues.filter((i) => i.severity === "error");
}

export function validateBuild(
  build: CharacterBuild,
  catalog: Catalog,
  res: Resolution = resolve(build, catalog),
): ValidationReport {
  const loaded = new Set(catalog.packs.map((p) => p.id));
  const issues: Issue[] = [
    ...(build.packs ?? [])
      .filter((id) => !loaded.has(id))
      .map((id) => issue("class", "error", message("issue.pack_missing", { pack: id }))),
    ...checkEntity("class", build.class_id, catalog.classes),
    ...checkEntity("species", build.species_id, catalog.species),
    ...checkEntity("background", build.background_id, catalog.backgrounds),
    ...checkAbilities(build, catalog),
  ];
  const missing = (
    [
      ["class", build.class_id],
      ["species", build.species_id],
      ["background", build.background_id],
    ] as const
  )
    .filter(([, value]) => value === null)
    .map(([what]) => what);
  if (missing.length) {
    for (const step of ["equipment", "features", "spells", "proficiencies"] as const) {
      issues.push(issue(step, "pending", message("issue.choose_first", { missing })));
    }
  }
  issues.push(...checkLevels(res, catalog));
  for (const choice of res.choices) {
    if (choice.fixed === null) issues.push(...choiceIssues(res, choice));
  }
  for (const src of res.featSources()) {
    if (src.feat.unsupported) {
      issues.push(
        issue(
          "features",
          "note",
          message("issue.unsupported", { name: src.name, text: src.feat.unsupported }),
          null,
          src.level,
        ),
      );
    }
  }
  if (!build.name.trim()) issues.push(issue("details", "pending", message("issue.choose_name")));
  if (build.alignment === null) {
    issues.push(issue("details", "pending", message("issue.choose_alignment")));
  }
  return { issues, is_complete: issues.every((i) => i.severity === "note") };
}

function checkEntity(
  step: "class" | "species" | "background",
  value: string | null,
  table: Table<unknown>,
): Issue[] {
  if (value === null)
    return [issue(step, "pending", message("issue.choose_entity", { what: step }))];
  if (!lookup(table, value)) {
    return [issue(step, "error", message("issue.unknown_entity", { what: step, id: value }))];
  }
  return [];
}

function checkAbilities(build: CharacterBuild, catalog: Catalog): Issue[] {
  const step = "abilities";
  const rules = catalog.creation;
  if (build.ability_method === null) {
    return [issue(step, "pending", message("issue.choose_method"))];
  }
  const issues = baseScoreMessages(
    build.ability_method,
    build.base_scores,
    rules,
    build.rolled_pool,
  ).map((e) => issue(step, "error", e));
  const missing = ABILITIES.filter((a) => build.base_scores[a] === undefined).map((a) =>
    message(`ability.${a}`),
  );
  if (missing.length) {
    issues.push(issue(step, "pending", message("issue.assign_scores", { missing })));
  }
  const background = lookup(catalog.backgrounds, build.background_id);
  if (!background) {
    issues.push(issue(step, "pending", message("issue.background_for_bonuses")));
  } else if (!definedEntries(build.background_bonus).length) {
    issues.push(
      issue(step, "pending", message("issue.apply_bonuses", { background: background.name })),
    );
  } else {
    for (const e of backgroundBonusMessages(
      build.background_bonus,
      background.ability_scores,
      build.base_scores,
      rules.max_score_at_creation,
    )) {
      issues.push(issue(step, "error", e));
    }
  }
  return issues;
}

/** Level-ups: known classes, Hit Die rolls in range, multiclass prerequisites, level cap. */
function checkLevels(res: Resolution, catalog: Catalog): Issue[] {
  const issues: Issue[] = [];
  const rules = catalog.creation;
  if (res.characterLevel > rules.max_level) {
    issues.push(
      issue(
        "class",
        "error",
        message("issue.max_level", { level: rules.max_level }),
        null,
        res.characterLevel,
      ),
    );
  }
  const taken: string[] = [];
  for (const l of res.levels) {
    const cls = lookup(catalog.classes, l.class_id);
    if (l.level === 1) {
      taken.push(l.class_id);
      continue;
    }
    if (!cls) {
      const unknown = message("issue.unknown_entity", { what: "class", id: l.class_id });
      issues.push(issue("class", "error", unknown, null, l.level));
      continue;
    }
    if (l.hp !== null && l.hp > cls.hit_die) {
      issues.push(
        issue(
          "class",
          "error",
          message("issue.hp_roll_too_high", { hp: l.hp, die: cls.hit_die }),
          null,
          l.level,
        ),
      );
    }
    if (l.class_level === 1) {
      const unmet = multiclassBlockerMessages(res, catalog, [...taken, l.class_id], l.level);
      if (unmet.length) {
        issues.push(
          issue(
            "class",
            "error",
            message("issue.multiclass", { class: cls.name, unmet }),
            null,
            l.level,
          ),
        );
      }
      taken.push(l.class_id);
    }
  }
  return issues;
}

/**
 * Why a character with these classes can't take a new class at `level`, as messages: every class
 * needs a score of at least 13 (by default) in its primary ability (any of them, or all of them
 * for classes such as the Monk).
 */
export function multiclassBlockerMessages(
  res: Resolution,
  catalog: Catalog,
  classIds: readonly string[],
  level: number,
): Message[] {
  const min = catalog.creation.multiclass_min_score;
  const scores = res.abilityScores(level);
  const out: Message[] = [];
  for (const id of new Set(classIds)) {
    const cls = lookup(catalog.classes, id);
    if (!cls) continue;
    const meets = (a: (typeof cls.primary_abilities)[number]) => scores[a] >= min;
    const ok =
      cls.primary_mode === "all"
        ? cls.primary_abilities.every(meets)
        : cls.primary_abilities.some(meets);
    if (!ok) {
      out.push(
        message("issue.multiclass_needs", {
          class: cls.name,
          all: cls.primary_mode === "all",
          abilities: cls.primary_abilities.map((a) => message(`ability.${a}`)),
          min,
        }),
      );
    }
  }
  return out;
}

/** Problems with a replacement's `[old, new]` answer, as messages (empty: no replacement). */
export function replaceErrorMessages(
  res: Resolution,
  choice: ActiveChoice,
  picked: readonly string[] = res.selected(choice),
): Message[] {
  if (!picked.length) return [];
  if (picked.length !== 2) return [message("issue.replace_pair")];
  const [oldId, newId] = picked as [string, string];
  const errors: Message[] = [];
  const old = res.replaceOld(choice).find((o) => o.id === oldId);
  if (!old) errors.push(message("issue.replace_missing", { id: oldId }));
  else if (old.unavailable_message) {
    errors.push(message("issue.replace_blocked", { name: old.name, why: old.unavailable_message }));
  }
  const replacement = res.replaceNew(choice, oldId).find((o) => o.id === newId);
  if (!replacement) {
    errors.push(message("issue.replace_invalid", { id: newId, old: old?.name ?? oldId }));
  } else if (replacement.unavailable_message) {
    errors.push(
      message("issue.option_why", { name: replacement.name, why: replacement.unavailable_message }),
    );
  }
  return errors;
}

export function choiceIssues(res: Resolution, choice: ActiveChoice): Issue[] {
  const { step, key, label, level } = choice;
  if (choice.replaces) {
    return replaceErrorMessages(res, choice).map((e) =>
      issue(step, "error", message("issue.choice", { choice: label, issue: e }), key, level),
    );
  }
  const { kind } = choice.definition;
  const count = res.countOf(choice);
  const selected = res.selected(choice);
  const views = new Map(res.options(choice).map((v) => [v.id, v]));
  const issues: Issue[] = [];
  const add = (severity: Severity, detail: Message) =>
    issues.push(
      issue(step, severity, message("issue.choice", { choice: label, issue: detail }), key, level),
    );
  const counts = new Map<string, number>();
  for (const value of selected) counts.set(value, (counts.get(value) ?? 0) + 1);
  if (kind === "ability_increase") {
    // The same ability can be picked more than once (+2 = picked twice), up to the cap.
    const before = res.abilityScores(level);
    for (const [value, n] of counts) {
      const ability = value as keyof typeof before;
      if (Object.hasOwn(before, ability) && before[ability] + n > choice.definition.max_score) {
        add(
          "error",
          message("scores.cap", {
            ability: message(`ability.${ability}`),
            cap: choice.definition.max_score,
          }),
        );
      }
    }
  } else {
    for (const [value, n] of counts) {
      if (n > 1) add("error", message("issue.chosen_twice", { value }));
    }
  }
  for (const value of counts.keys()) {
    const view = views.get(value);
    if (!view) add("error", message("issue.not_an_option", { value }));
    else if (view.unavailable_message && kind !== "ability_increase") {
      add(
        "error",
        message("issue.option_unavailable", { name: view.name, why: view.unavailable_message }),
      );
    }
  }
  const required = res.required(choice);
  if (selected.length < required) {
    add("pending", message("issue.choose_more", { count: required - selected.length }));
  } else if (selected.length > count) add("error", message("issue.choose_only", { count }));
  return issues;
}
