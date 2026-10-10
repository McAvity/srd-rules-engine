/** Text rendering of the character panel and the full sheet. */

import { type Catalog, catalogItem, lookup } from "../content/catalog";
import { ALIGNMENT_NAMES } from "../models/build";
import {
  ABILITIES,
  ABILITY_NAMES,
  SKILL_ABILITY,
  STEPS,
  type Step,
  skillName,
  titleCase,
} from "../models/content";
import { type ActiveSource, entityName } from "../rules/build-resolution";
import { issuesForLevel, issuesForStep } from "../rules/build-validation";
import { abilityModifier, signed } from "../rules/dice";
import { explainStat } from "../rules/sheet";
import { type Evaluation, STEP_TITLES } from "../services/builder";
import type { Console } from "./console";

export const pad = (value: string | number, width: number) => String(value).padEnd(width);
export const padLeft = (value: string | number, width: number) => String(value).padStart(width);

/** First sentence of `text`, cut at a word boundary with an ellipsis if too long. */
export function shorten(text: string, width = 60): string {
  const first = (text.replace(/\s+/g, " ").split(". ")[0] ?? "").replace(/\.+$/, "");
  if (first.length <= width) return first;
  const cut = first.slice(0, width);
  const space = cut.lastIndexOf(" ");
  return `${space >= 0 ? cut.slice(0, space) : cut}…`;
}

/** Chosen species options that define the character (lineage, ancestry), not size. */
export function speciesOptionSources(ev: Evaluation): ActiveSource[] {
  return ev.resolution.sources.filter(
    (src) => src.key.startsWith("species:") && src.key.includes("=") && !src.key.includes("#size="),
  );
}

export function identityLine(ev: Evaluation, catalog: Catalog): string {
  const b = ev.build;
  const parts: string[] = [];
  const species = lookup(catalog.species, b.species_id);
  const cls = lookup(catalog.classes, b.class_id);
  if (species) {
    const lineage = speciesOptionSources(ev).map((src) => src.name.split(" (")[0]);
    parts.push(`${species.name}${lineage.length ? ` (${lineage.join(", ")})` : ""}`);
  }
  const classes = ev.sheet.classes;
  if (classes.length > 1) parts.push(classes.map((c) => `${c.name} ${c.level}`).join(" / "));
  else if (cls) parts.push(cls.name);
  const who = parts.join(" ") || "New adventurer";
  const bg = lookup(catalog.backgrounds, b.background_id);
  const name = b.name || "(unnamed)";
  return `${name} · Level ${ev.sheet.level} ${who}${bg ? ` · ${bg.name}` : ""}`;
}

export function abilityLine(ev: Evaluation, con: Console, catalog: Catalog): string {
  const cls = lookup(catalog.classes, ev.build.class_id);
  const primaries = new Set(cls?.primary_abilities ?? []);
  return ABILITIES.map((a) => {
    let cell: string;
    if (!ev.sheet.scores_complete && ev.build.base_scores[a] === undefined) {
      cell = `${a.toUpperCase()} --`;
    } else {
      const score = ev.sheet.scores[a];
      cell = `${a.toUpperCase()} ${padLeft(score, 2)} (${signed(abilityModifier(score))})`;
    }
    return primaries.has(a) ? con.style(cell, "bold") : cell;
  }).join("  ");
}

export function renderPanel(ev: Evaluation, con: Console, catalog: Catalog): void {
  const s = ev.sheet;
  con.say(con.style(`╭${"─".repeat(70)}`, "dim"));
  con.say(con.style("│ ", "dim") + con.style(identityLine(ev, catalog), "bold"));
  con.say(con.style("│ ", "dim") + abilityLine(ev, con, catalog));
  let stats: string;
  if (s.scores_complete) {
    const hp = s.max_hp ? `HP ${s.max_hp.total}` : "HP --";
    stats =
      `${hp}   AC ${s.armor_class.total}   Init ${signed(s.initiative.total)}   ` +
      `Speed ${s.speed.total} ft   Prof ${signed(s.proficiency_bonus)}   ` +
      `Passive Perception ${s.passive_perception}`;
  } else {
    stats = "HP, AC and other numbers appear once ability scores are set.";
  }
  con.say(con.style("│ ", "dim") + stats);
  con.say(con.style(`╰${"─".repeat(70)}`, "dim"));
}

export function stepSummary(ev: Evaluation, step: Step, catalog: Catalog): string {
  const b = ev.build;
  const res = ev.resolution;
  if (step === "class") return lookup(catalog.classes, b.class_id)?.name ?? "";
  if (step === "background") return lookup(catalog.backgrounds, b.background_id)?.name ?? "";
  if (step === "abilities") {
    if (!b.ability_method) return "";
    const method = b.ability_method.replaceAll("_", " ");
    const applied = Object.keys(b.background_bonus).length ? ", bonuses applied" : "";
    return `${method}${applied}`;
  }
  if (step === "details") {
    return [b.name, b.alignment ? ALIGNMENT_NAMES[b.alignment] : ""].filter(Boolean).join(", ");
  }
  if (step === "spells") {
    const s = ev.sheet;
    const parts = [
      [s.spells.filter((x) => x.level === 0).length, "cantrip"],
      [s.spells.filter((x) => x.level > 0).length, "prepared"],
      [s.spellbook.length, "in spellbook"],
    ] as const;
    return parts
      .filter(([n]) => n > 0)
      .map(([n, what]) =>
        what === "cantrip" ? `${n} cantrip${n === 1 ? "" : "s"}` : `${n} ${what}`,
      )
      .join(", ");
  }
  const names: string[] = [];
  if (step === "species") {
    const species = lookup(catalog.species, b.species_id);
    if (species) names.push(species.name);
  }
  for (const choice of res.choicesForStep(step)) {
    const views = new Map(res.options(choice).map((v) => [v.id, v.name]));
    names.push(...res.selected(choice).map((v) => views.get(v) ?? v));
  }
  return names.join(", ");
}

export function renderMenu(ev: Evaluation, con: Console, catalog: Catalog): void {
  STEPS.forEach((step, i) => {
    const issues = issuesForStep(ev.report, step);
    const errors = issues.filter((x) => x.severity === "error");
    const pending = issues.filter((x) => x.severity === "pending");
    const [mark, style] = errors.length
      ? (["✘", "red"] as const)
      : pending.length
        ? (["•", "yellow"] as const)
        : (["✔", "green"] as const);
    const summary = stepSummary(ev, step, catalog);
    const extra = pending.length && summary ? ` — ${pending.length} to do` : "";
    con.say(
      ` ${padLeft(i + 1, 2)}. ${con.style(mark, style)} ${pad(STEP_TITLES[step], 22)} ` +
        con.style(summary + extra, "dim"),
    );
  });
  for (const l of ev.resolution.levels.slice(1)) {
    const issues = issuesForLevel(ev.report, l.level);
    const [mark, style] = issues.some((x) => x.severity === "error")
      ? (["✘", "red"] as const)
      : issues.some((x) => x.severity === "pending")
        ? (["•", "yellow"] as const)
        : (["✔", "green"] as const);
    const title = `Level ${l.level}: ${lookup(catalog.classes, l.class_id)?.name ?? l.class_id} ${l.class_level}`;
    con.say(
      ` L${pad(l.level, 2)} ${con.style(mark, style)} ${pad(title, 22)} ` +
        con.style(levelSummary(ev, l.level), "dim"),
    );
  }
  con.say(` ${padLeft(STEPS.length + 1, 2)}.   Review & save`);
}

/** Feature names gained at a character level (2+). */
export function levelSummary(ev: Evaluation, level: number): string {
  const names = ev.resolution.sources
    .filter((s) => s.level === level && s.feat === null)
    .flatMap((s) => s.grants.traits.map((t) => t.name));
  const picks = ev.resolution.choicesForLevel(level).flatMap((c) => {
    const catalog = ev.resolution.catalog;
    const picks = ev.resolution.selected(c).map((v) => entityName(catalog, v) ?? v);
    if (c.replaces) return picks.length === 2 ? [picks.join(" → ")] : [];
    return picks;
  });
  return [...new Set([...names, ...picks])].join(", ");
}

export function renderSheet(ev: Evaluation, con: Console, catalog: Catalog): void {
  const s = ev.sheet;
  const res = ev.resolution;
  con.title("Character Sheet");
  con.say(con.style(identityLine(ev, catalog), "bold"));
  if (ev.build.alignment) con.say(`Alignment: ${ALIGNMENT_NAMES[ev.build.alignment]}`);
  const size = s.size ? titleCase(s.size) : "--";
  const senses = s.darkvision ? `Darkvision ${s.darkvision} ft` : "no Darkvision";
  con.say(`Size ${size} · Speed ${s.speed.total} ft · ${senses}`);

  con.say();
  con.say(con.style("Ability         Score  Mod   Save", "bold"));
  for (const a of ABILITIES) {
    const save = s.saving_throws[a];
    const mark = save.proficient ? "●" : "○";
    con.say(
      `  ${pad(ABILITY_NAMES[a], 13)} ${padLeft(s.scores[a], 5)}  ${padLeft(signed(s.modifiers[a]), 3)}   ` +
        `${mark} ${signed(save.modifier)}`,
    );
  }

  con.say();
  con.say(con.style("Combat", "bold"));
  if (s.max_hp) {
    con.say(`  Hit Points  ${padLeft(s.max_hp.total, 3)}   = ${explainStat(s.max_hp)}`);
    const dice = Object.entries(s.hit_dice)
      .sort(([a], [b]) => Number(b) - Number(a))
      .map(([die, n]) => `${n}d${die}`);
    con.say(`  Hit Dice    ${dice.join(" + ")}`);
  }
  con.say(`  Armor Class ${padLeft(s.armor_class.total, 3)}   = ${explainStat(s.armor_class)}`);
  con.say(
    `  Initiative  ${padLeft(signed(s.initiative.total), 3)}   = ${explainStat(s.initiative)}`,
  );
  con.say(`  Speed       ${padLeft(s.speed.total, 3)}   = ${explainStat(s.speed)}`);
  con.say(`  Proficiency ${padLeft(signed(s.proficiency_bonus), 3)}`);
  if (s.attacks_per_action > 1) con.say(`  Attack action: ${s.attacks_per_action} attacks`);
  if (s.critical_hit_on < 20) con.say(`  Critical Hits on ${s.critical_hit_on}–20`);
  if (s.resources.length) {
    con.say(`  ${s.resources.map((r) => `${r.name} ${r.value}`).join(" · ")}`);
  }
  if (s.resistances.length) {
    con.say(`  Resistances: ${s.resistances.map(titleCase).join(", ")}`);
  }

  con.say();
  con.say(con.style("Attacks", "bold"));
  for (const atk of s.attacks) {
    const mastery = atk.mastery ? ` · Mastery: ${atk.mastery}` : "";
    const notes = atk.notes.length ? ` · ${atk.notes.join("; ")}` : "";
    con.say(
      `  ${pad(atk.name, 16)} ${padLeft(signed(atk.attack_bonus), 3)} to hit  ` +
        `${atk.damage} ${atk.damage_type}${mastery}${notes}`,
    );
  }

  con.say();
  con.say(con.style("Skills  (● proficient, ◆ expertise)", "bold"));
  for (const line of s.skills) {
    const mark = line.expertise ? "◆" : line.proficient_from ? "●" : "○";
    const src = line.proficient_from ? `  (${line.proficient_from})` : "";
    con.say(
      `  ${mark} ${pad(skillName(line.skill), 16)} ${padLeft(signed(line.modifier), 3)}` +
        `  ${SKILL_ABILITY[line.skill].toUpperCase()}${con.style(src, "dim")}`,
    );
  }
  con.say(`  Passive Perception ${s.passive_perception}`);

  con.say();
  con.say(con.style("Proficiencies & Training", "bold"));
  con.say(`  Armor:     ${s.armor_training.map(titleCase).join(", ") || "none"}`);
  con.say(`  Weapons:   ${s.weapon_proficiencies.map(titleCase).join(", ") || "none"}`);
  const tools = Object.keys(s.tools).map((t) => lookup(catalog.tools, t)?.name ?? t);
  con.say(`  Tools:     ${tools.join(", ") || "none"}`);
  const langs = Object.keys(s.languages)
    .map((x) => lookup(catalog.languages, x)?.name)
    .filter(Boolean);
  con.say(`  Languages: ${langs.join(", ")}`);
  const masteries = s.weapon_masteries.map((w) => lookup(catalog.weapons, w)?.name).filter(Boolean);
  if (masteries.length) con.say(`  Weapon Mastery: ${masteries.join(", ")}`);

  con.say();
  con.say(con.style("Feats", "bold"));
  for (const src of res.featSources()) {
    con.say(`  ${src.name}: ${con.style(src.feat.description, "dim")}`);
    for (const choice of res.choices) {
      if (choice.source === src && choice.definition.kind !== "skill_or_tool") {
        const picked = res.selected(choice);
        const views = new Map(res.options(choice).map((v) => [v.id, v.name]));
        if (picked.length) {
          con.say(`    ${choice.label}: ${picked.map((p) => views.get(p) ?? p).join(", ")}`);
        }
      }
    }
  }

  if (s.spellcasting.length || s.spells.length) {
    con.say();
    con.say(con.style("Spellcasting", "bold"));
    for (const sc of s.spellcasting) {
      const ability = sc.ability ? ABILITY_NAMES[sc.ability] : "ability not chosen";
      const numbers =
        sc.save_dc !== null
          ? ` · save DC ${sc.save_dc} · attack ${signed(sc.attack_bonus ?? 0)}`
          : "";
      con.say(`  ${sc.source}: ${ability}${numbers}`);
    }
    if (s.spell_slots.length) {
      const slots = s.spell_slots.map((n, i) => `${n} × level ${i + 1}`).join(", ");
      con.say(`  Spell slots: ${slots}`);
    }
    if (s.pact_magic) {
      con.say(
        `  Pact Magic: ${s.pact_magic.slots} × level ${s.pact_magic.slot_level} (back on a Short Rest)`,
      );
    }
    for (const level of [...new Set(s.spells.map((x) => x.level))]) {
      const names = s.spells
        .filter((x) => x.level === level)
        .map(
          (x) => `${x.name}${x.always_prepared ? "*" : ""}${con.style(` (${x.source})`, "dim")}`,
        );
      con.say(`  ${level === 0 ? "Cantrips" : `Level ${level}`}: ${names.join(", ")}`);
    }
    if (s.spellbook.length) {
      const names = s.spellbook.map((id) => lookup(catalog.spells, id)?.name ?? id);
      con.say(`  Spellbook: ${names.join(", ")}`);
    }
    if (s.spells.some((x) => x.always_prepared)) con.info("* always prepared");
  }

  con.say();
  con.say(con.style("Traits & Features", "bold"));
  for (const trait of s.traits) {
    const where = trait.level > 1 ? ` (${trait.source}, level ${trait.level})` : "";
    const text = trait.level > 1 ? shorten(trait.text.replace(/[_*]/g, ""), 110) : trait.text;
    con.say(`  ${trait.name}${where}: ${con.style(text, "dim")}`);
  }
  if (s.features.length) con.say(`  Chosen options: ${s.features.join(", ")}`);
  for (const src of speciesOptionSources(ev)) {
    const desc = src.description ? `: ${con.style(src.description, "dim")}` : "";
    con.say(`  ${src.name}${desc}`);
  }

  con.say();
  con.say(con.style("Equipment", "bold"));
  for (const [itemId, qty] of Object.entries(s.equipment)) {
    const name = catalogItem(catalog, itemId).name;
    con.say(qty > 1 ? `  ${qty} × ${name}` : `  ${name}`);
  }
  con.say(`  ${s.gp} GP`);
  if (s.armor_worn) con.info(`(Assumes you wear your ${s.armor_worn}.)`);

  if (s.warnings.length) {
    con.say();
    for (const w of s.warnings) con.warn(w);
  }
}
