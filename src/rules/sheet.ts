/**
 * Compute the derived character sheet from a (possibly partial) build, at any level.
 *
 * Derived values are never stored; they are recomputed from the build every time. Each
 * headline number keeps its list of contributions so a UI can explain it
 * ("AC 17 = 16 Chain Mail + 1 Defense"). The sheet is plain JSON-serializable data.
 */

import { type Catalog, lookup } from "../content/catalog";
import type { CharacterBuild } from "../models/build";
import {
  ABILITIES,
  ABILITY_NAMES,
  type Ability,
  type AdvantageTarget,
  type ArmorDef,
  type DamageRider,
  type Effect,
  type EffectCondition,
  type EffectOp,
  type EffectTarget,
  type FeatureRule,
  type MagicItemDef,
  type Size,
  SKILL_ABILITY,
  SKILLS,
  type Skill,
  type SpellDamage,
  type WeaponDef,
} from "../models/content";
import { finalScores } from "./ability-scores";
import { type ActiveSource, mergeGrants, type Resolution, resolve } from "./build-resolution";
import { type DamagePart, formatDamage } from "./damage";
import { abilityModifier, proficiencyBonus } from "./dice";
import { isMonkWeapon, isWeaponProficient, parseRange } from "./weapons";

export interface Contribution {
  readonly source: string;
  readonly value: number;
}

/** A number together with where it comes from. */
export interface Stat {
  readonly total: number;
  readonly parts: readonly Contribution[];
}

export interface SkillLine {
  readonly skill: Skill;
  readonly ability: Ability;
  readonly modifier: number;
  readonly proficient_from: string | null;
  /** Proficiency Bonus counted twice. */
  readonly expertise: boolean;
}

export interface SaveLine {
  readonly modifier: number;
  readonly proficient: boolean;
}

/** An optional rider on an attack line (Sneak Attack, Divine Strike): `makeAttack` applies it. */
export interface AttackRider {
  readonly id: string;
  readonly name: string;
  readonly dice: string | null;
  readonly bonus: number;
  /** The damage type, or the types to choose from. */
  readonly type: string | readonly string[];
  readonly once_per_turn: boolean;
  /** Only on the attacker's own turns (Divine Strike). */
  readonly own_turn?: boolean;
  readonly requires: "advantage_or_ally" | "target_damaged" | null;
}

export interface AttackLine {
  readonly name: string;
  readonly kind: "melee" | "ranged";
  /** The ability the attack uses (`null` for a monster's attack, which doesn't say). */
  readonly ability: Ability | null;
  /** A weapon attack (not an Unarmed Strike). */
  readonly weapon: boolean;
  readonly properties: readonly string[];
  /** Extra damage you can add on a hit (automatic riders are already in `damage_parts`). */
  readonly riders: readonly AttackRider[];
  readonly attack_bonus: number;
  /** For display: `1d8+3`, or `1d8+3 (1d10+3 two-handed)` for a Versatile weapon. */
  readonly damage: string;
  readonly damage_type: string;
  /** The damage on a hit, ready to roll (`rollDamage`). */
  readonly damage_parts: readonly DamagePart[];
  /** A Versatile weapon's damage when used with two hands. */
  readonly two_handed_damage_parts: readonly DamagePart[] | null;
  /**
   * A Light weapon's damage for the Light property's extra attack: no positive ability modifier,
   * unless the Two-Weapon Fighting feat adds it back. `null` for other attacks.
   */
  readonly light_extra_damage_parts: readonly DamagePart[] | null;
  /** The Cleave mastery's attack damage: no positive ability modifier. `null` without Cleave. */
  readonly cleave_damage_parts: readonly DamagePart[] | null;
  readonly mastery: string | null;
  readonly notes: readonly string[];
  /** A melee attack's reach in feet (5; 10 with the Reach property); `null` for a ranged one. */
  readonly reach: number | null;
  /** Normal and long range in feet: a ranged or thrown weapon, a monster's ranged attack. */
  readonly range: { readonly normal: number; readonly long: number } | null;
}

/** A feature used in a turn, with its numbers worked out for the character. */
export interface FeatureActionLine {
  readonly key: string;
  readonly name: string;
  readonly economy: "action" | "bonus_action" | "reaction" | "free";
  /** The limited use it spends (`fighter:second-wind`), if any. */
  readonly uses: string | null;
  readonly cost: number;
  readonly pool: boolean;
  readonly target: "self" | "creature" | "other";
  readonly heal: {
    readonly dice: string | null;
    readonly bonus: number;
    readonly pooled: boolean;
  } | null;
  readonly extra_action: boolean;
  readonly also: readonly ("dash" | "disengage" | "dodge")[];
  readonly attacks: { readonly attack: string; readonly count: number } | null;
  readonly after_hit: boolean;
  readonly once_per_turn: boolean;
  readonly save: {
    readonly ability: Ability;
    readonly dc: number;
    readonly conditions: readonly string[];
    readonly rounds: number | null;
    readonly ends_on: readonly ("damage" | "source_incapacitated")[];
    /** Damage on a failed save, at the class level: dice + bonus, of one of `types`. */
    readonly damage: {
      readonly dice: string;
      readonly bonus: number;
      readonly types: readonly string[];
      readonly half: boolean;
    } | null;
    readonly on_success: readonly ("speed_halved" | "advantage_against")[];
  } | null;
  readonly range: number | null;
  readonly many: boolean;
  readonly creature_types: readonly string[];
  readonly removes: readonly string[];
  /** The damage its reaction takes off an attack that hits (Deflect Attacks). */
  readonly reduces_attack_damage: {
    readonly dice: string;
    readonly bonus: number;
    readonly types: readonly string[];
  } | null;
  /** The die it gives (8 for a d8). */
  readonly inspiration_die: number | null;
  readonly halves_attack_damage: boolean;
}

export interface ClassLine {
  readonly class_id: string;
  readonly name: string;
  readonly level: number;
  readonly subclass: string | null;
  readonly hit_die: number;
}

/** A class table column at the character's level in that class (Rages 3, Sneak Attack 2d6). */
export interface ResourceLine {
  readonly class_id: string;
  readonly name: string;
  readonly value: number | string;
}

/** A feature or trait, with where and when it was gained. */
export interface TraitLine {
  readonly name: string;
  readonly text: string;
  readonly source: string;
  /** Character level at which it was gained. */
  readonly level: number;
}

/** A limited-use feature, with its maximum at the character's current level. */
export interface UsesLine {
  /** Stable key: `<class>:<id>` for class features, `<source key>:<id>` otherwise. */
  readonly key: string;
  readonly name: string;
  readonly max: number;
  readonly recharge: "short" | "long";
  readonly short_rest_regain: number | null;
}

/** An item the character carries (play state), resolved against the catalog. */
export interface CarriedItem {
  /** Inventory entry id. */
  readonly id: string;
  readonly name: string;
  /** The mundane weapon, armor or gear this item is (or is a magic version of). */
  readonly base: string | null;
  readonly magic: MagicItemDef | null;
  readonly qty: number;
  readonly equipped: boolean;
  /** Its magic applies: worn or held (or carried, for some), and attuned if it must be. */
  readonly active: boolean;
  readonly attuned: boolean;
  readonly variant: string | null;
}

/** What play state changes on the sheet: carried items, conditions, Exhaustion. */
/** A feature switched on in play (Rage). */
export interface ToggleLine {
  readonly key: string;
  readonly name: string;
  /** The limited use spent to switch it on (`barbarian:rage`). */
  readonly uses: string | null;
  readonly active: boolean;
  /** Why it can't be active now (`wearing_heavy_armor`), if so. */
  readonly blocked: string | null;
  readonly ends_on: readonly string[];
  readonly no_spells: boolean;
  /** In an encounter: ends at the end of a turn it wasn't extended in (Rage). */
  readonly extends_each_turn: boolean;
  /** In an encounter, it ends at the start of your next turn (Reckless Attack). */
  readonly ends_at_turn_start: boolean;
  /** In an encounter, it lasts at most this many rounds. */
  readonly rounds: number | null;
}

export interface PlayContext {
  readonly items: readonly CarriedItem[];
  /** Keys of the toggles switched on (`barbarian:rage`). */
  readonly active?: ReadonlySet<string>;
  /** Active condition ids, including implied ones (Unconscious → Prone, Incapacitated). */
  readonly conditions: ReadonlySet<string>;
  readonly exhaustion: number;
}

export interface DerivedSheet {
  /** Total character level. */
  readonly level: number;
  readonly classes: readonly ClassLine[];
  readonly scores: Readonly<Record<Ability, number>>;
  readonly modifiers: Readonly<Record<Ability, number>>;
  readonly scores_complete: boolean;
  readonly proficiency_bonus: number;
  readonly max_hp: Stat | null;
  /** Hit Dice pools: die size → count, e.g. `{ "10": 3, "8": 2 }`. */
  readonly hit_dice: Readonly<Record<string, number>>;
  readonly armor_class: Stat;
  readonly armor_worn: string | null;
  readonly initiative: Stat;
  readonly speed: Stat;
  readonly size: Size | null;
  readonly darkvision: number;
  readonly saving_throws: Readonly<Record<Ability, SaveLine>>;
  /** Ability check bonuses without a skill (the modifier, `checks` effects, Exhaustion). */
  readonly ability_checks: Readonly<Record<Ability, number>>;
  readonly skills: readonly SkillLine[];
  readonly passive_perception: number;
  /** Attacks you make when you take the Attack action (Extra Attack and its upgrades). */
  readonly attacks_per_action: number;
  /** The lowest d20 roll that's a Critical Hit (20, or 19 for a Champion). */
  readonly critical_hit_on: number;
  readonly attacks: readonly AttackLine[];
  /** Tool id → source of the proficiency. */
  readonly tools: Readonly<Record<string, string>>;
  /** Language id → source. */
  readonly languages: Readonly<Record<string, string>>;
  readonly resistances: readonly string[];
  /** Advantage on saving throws or checks (`save.str`), with where it comes from. */
  /**
   * `class_id` (kenli K-001): the class whose feature grants it, or `null` (feats, species, items). A class-granted
   * `attack.spell` Advantage applies only to that class's spells (Innate Sorcery: "Sorcerer spells").
   */
  readonly advantages: readonly {
    readonly target: AdvantageTarget;
    readonly source: string;
    readonly class_id: string | null;
  }[];
  /** Features used in turns (Second Wind, Action Surge), keyed like toggles (`fighter:second-wind`). */
  readonly actions: readonly FeatureActionLine[];
  /** Rules in code switched on by features (`evasion`, `reliable_talent`, `potent_cantrip`). */
  readonly rules: readonly FeatureRule[];
  /** Ability modifiers added to some spells' damage, with the modifier now (`bonus`). */
  readonly spell_damage: readonly (SpellDamage & { readonly bonus: number })[];
  /** Features you can switch on in play. */
  readonly toggles: readonly ToggleLine[];
  /** Ids of every cantrip you know (a shortcut into `spells`). */
  readonly cantrips: readonly string[];
  readonly spellcasting: readonly SpellcastingLine[];
  /** Spell slots per spell level from the Spellcasting feature(s): `[4, 3, 2]`. */
  readonly spell_slots: readonly number[];
  /** Warlock Pact Magic slots, recovered on a Short Rest. */
  readonly pact_magic: { readonly slots: number; readonly slot_level: number } | null;
  /** Cantrips and prepared spells: what you can cast. */
  readonly spells: readonly SpellLine[];
  /** Spells in your spellbook (Wizard), prepared or not. */
  readonly spellbook: readonly string[];
  readonly resources: readonly ResourceLine[];
  /** Limited uses (Rage, Second Wind…) and how they recharge. */
  readonly limited_uses: readonly UsesLine[];
  readonly armor_training: readonly string[];
  readonly weapon_proficiencies: readonly string[];
  readonly feats: readonly string[];
  /** Chosen class feature options (Eldritch Invocations, Metamagic). */
  readonly features: readonly string[];
  readonly traits: readonly TraitLine[];
  readonly weapon_masteries: readonly string[];
  /** Item id → quantity. */
  readonly equipment: Readonly<Record<string, number>>;
  readonly gp: number;
  readonly warnings: readonly string[];
}

export function stat(parts: Contribution[]): Stat {
  return { total: parts.reduce((sum, p) => sum + p.value, 0), parts };
}

/** `16 Chain Mail + 1 Defense`. */
export function explainStat(s: Stat): string {
  return s.parts
    .map((p, i) =>
      i === 0
        ? `${p.value} ${p.source}`
        : `${p.value >= 0 ? "+" : "-"} ${Math.abs(p.value)} ${p.source}`,
    )
    .join(" ");
}

type ResolvedEffect = [op: EffectOp, value: number, source: string, from: ActiveSource];

/** Template for the sources that stand in for active magic items. */
const itemSource: ActiveSource = {
  key: "",
  name: "",
  grants: {} as ActiveSource["grants"],
  params: {},
  feat: null,
  feature: null,
  description: "",
  granted_by: "",
  level: 1,
  class_id: null,
};
type Conditions = ReadonlyMap<EffectCondition, boolean>;

export interface SpellcastingLine {
  /** The feature's source, e.g. `Wizard` or `Magic Initiate`. */
  readonly source: string;
  /** kenli K-001: the class whose Spellcasting this is (its spells are that class's spells), `null` for a feat. */
  readonly class_id: string | null;
  /** Spell list id; `null` for a fixed set of spells or while it depends on an unanswered choice. */
  readonly list: string | null;
  readonly ability: Ability | null;
  readonly save_dc: number | null;
  readonly attack_bonus: number | null;
  /** How the class's levels count toward spell slots (`full`, `half`, `pact`), if at all. */
  readonly progression: "full" | "half" | "pact" | null;
}

export interface SpellLine {
  readonly id: string;
  readonly name: string;
  readonly level: number;
  readonly source: string;
  /** Granted by a feature (Favored Enemy, Druidic…); doesn't count against prepared spells. */
  readonly always_prepared: boolean;
  /**
   * The spellcasting features (`SpellcastingLine.source`) the spell is cast with: the one of each feature that gives it
   * (a class or subclass feature: its class's Spellcasting; a feat with its own: that one). Usually one; empty when no
   * spellcasting feature applies; more than one only when the same spell is given twice (a validation error). Pass it
   * as `spellcasting` to cast through it.
   */
  readonly spellcasting: readonly string[];
}

export function computeSheet(
  build: CharacterBuild,
  catalog: Catalog,
  res: Resolution = resolve(build, catalog),
  play?: PlayContext,
): DerivedSheet {
  const level = res.characterLevel;
  const pb = proficiencyBonus(level);
  const known = finalScores(build.base_scores, build.background_bonus);
  const scores = { ...res.abilityScores() };
  // Active magic items act as extra sources (Ring of Protection, Gauntlets of Ogre Power…),
  // and so do active toggles (Rage).
  const toggleDefs = res.sources.flatMap((src) =>
    src.grants.toggles.map((toggle) => ({ key: `${usesScope(src)}:${toggle.id}`, toggle, src })),
  );
  const itemSources: ActiveSource[] = [
    ...(play?.items ?? [])
      .filter((i) => i.active && i.magic)
      .map((i) => {
        const magic = i.magic as MagicItemDef;
        const variant = magic.variants.find((v) => v.id === i.variant);
        const grants = variant ? mergeGrants(magic.grants, variant.grants) : magic.grants;
        return { ...itemSource, key: `item:${i.id}`, name: i.name, grants, level };
      }),
    ...toggleDefs
      .filter((t) => play?.active?.has(t.key))
      .map((t) => ({
        ...t.src,
        key: `toggle:${t.key}`,
        name: t.toggle.name,
        grants: t.toggle.grants,
      })),
  ];
  for (const src of itemSources) {
    for (const e of src.grants.effects) {
      const ability = /^score\.(\w+)$/.exec(e.target)?.[1] as Ability | undefined;
      if (ability && typeof e.value === "number" && (e.op === "max" || e.op === "set")) {
        scores[ability] = e.op === "set" ? e.value : Math.max(scores[ability], e.value);
      }
    }
  }
  const mod = mapAbilities((a) => abilityModifier(scores[a]));
  const classLevels = res.classLevels();
  const warnings: string[] = [];

  // Equipment: what the character carries in play, or else the starting equipment (fixed item
  // grants plus chosen packages).
  const equipment: Record<string, number> = {};
  if (play) {
    for (const i of play.items) {
      const id = i.magic?.id ?? i.base ?? i.id;
      equipment[id] = (equipment[id] ?? 0) + i.qty;
    }
  } else {
    for (const src of res.sources) {
      for (const grant of src.grants.items) {
        equipment[grant.item] = (equipment[grant.item] ?? 0) + grant.qty;
      }
    }
  }
  const gp = res.sources.reduce((sum, src) => sum + src.grants.gp, 0);
  const training = res.granted("armor_training");

  const effectsFor = (target: EffectTarget, conditions: Conditions): ResolvedEffect[] => {
    const out: ResolvedEffect[] = [];
    const all = [
      ...res.effects(),
      ...itemSources.flatMap((s) => s.grants.effects.map((e): [Effect, ActiveSource] => [e, s])),
    ];
    for (const [effect, source] of all) {
      if (effect.target !== target) continue;
      if (effect.when !== null && !conditions.get(effect.when)) continue;
      let value: number;
      if (effect.value === "prof") value = pb;
      else if (effect.value === "half_prof") value = Math.floor(pb / 2);
      else if (typeof effect.value === "string") value = mod[effect.value];
      else value = effect.value;
      if (effect.min !== null) value = Math.max(value, effect.min);
      out.push([effect.op, value, source.name, source]);
    }
    return out;
  };

  // Armor Class: the best of every legal way to compute it (see `bestArmorClass`).
  const ac = bestArmorClass(equipment, training, res, catalog, mod, effectsFor, play);
  if (play && ac.armor && !training.includes(ac.armor.category)) {
    warnings.push(
      `You aren't trained with ${ac.armor.name}: Disadvantage on Str and Dex tests and attacks, and no spellcasting.`,
    );
  }
  const { armor, shield } = ac;
  const conditions = armorConditions(armor, shield);
  const effects = (target: EffectTarget) => effectsFor(target, conditions);
  const sum = (list: ResolvedEffect[]) =>
    list.reduce((total, [op, v]) => total + (op === "add" ? v : 0), 0);
  // Exhaustion: every D20 Test is reduced by 2 per level (SRD Rules Glossary).
  const exhaustion = play?.exhaustion ?? 0;
  const d20Penalty = -2 * exhaustion;
  const checks = sum(effects("checks"));

  // Classes
  const classes: ClassLine[] = [...classLevels].flatMap(([id, lvl]) => {
    const cls = lookup(catalog.classes, id);
    if (!cls) return [];
    const sub = res.subclassOf(id);
    return [
      {
        class_id: id,
        name: cls.name,
        level: lvl,
        subclass: sub?.name ?? null,
        hit_die: cls.hit_die,
      },
    ];
  });
  const hitDice: Record<string, number> = {};
  for (const c of classes) hitDice[c.hit_die] = (hitDice[c.hit_die] ?? 0) + c.level;

  // Hit points: max die at level 1, then the fixed value or the roll for each level, plus Con
  // for every level (at least 1 HP per level).
  let maxHp: Stat | null = null;
  const first = res.levels[0];
  const firstClass = first ? lookup(catalog.classes, first.class_id) : undefined;
  if (first && firstClass) {
    const parts: Contribution[] = [
      { source: `${firstClass.name} d${firstClass.hit_die}`, value: firstClass.hit_die },
    ];
    const groups = new Map<string, { value: number; levels: number }>();
    let minimumBump = 0;
    for (const l of res.levels.slice(1)) {
      const cls = lookup(catalog.classes, l.class_id);
      if (!cls) continue;
      const gained = l.hp ?? Math.floor(cls.hit_die / 2) + 1;
      const label = `${cls.name} ×LEVELS ${l.hp === null ? "fixed" : "rolled"}`;
      const g = groups.get(label) ?? { value: 0, levels: 0 };
      groups.set(label, { value: g.value + gained, levels: g.levels + 1 });
      if (gained + mod.con < 1) minimumBump += 1 - (gained + mod.con);
    }
    for (const [label, g] of groups) {
      parts.push({ source: label.replace("×LEVELS", `×${g.levels}`), value: g.value });
    }
    parts.push({ source: level > 1 ? `Con ×${level}` : "Con", value: mod.con * level });
    if (first && firstClass.hit_die + mod.con < 1)
      minimumBump += 1 - (firstClass.hit_die + mod.con);
    if (minimumBump) parts.push({ source: "minimum 1 HP per level", value: minimumBump });
    for (const [op, value, source] of effects("hp_per_level")) {
      if (op === "add") parts.push({ source, value: value * level });
    }
    for (const [op, value, source, from] of effects("hp_per_class_level")) {
      const classLevel = from.class_id ? (classLevels.get(from.class_id) ?? 0) : 0;
      if (op === "add") parts.push({ source, value: value * classLevel });
    }
    maxHp = stat(parts);
  }

  // Initiative
  const initiative = stat([
    { source: "Dex", value: mod.dex },
    ...effects("initiative")
      .filter(([op]) => op === "add")
      .map(([, value, source]) => ({ source, value })),
    ...effects("checks").map(([, value, source]) => ({ source, value })),
    ...(exhaustion ? [{ source: `Exhaustion ${exhaustion}`, value: d20Penalty }] : []),
  ]);

  // Speed: base from `set`, raised by `max`, then flat adjustments.
  let speedValue = 30;
  let speedSource = "default";
  for (const [op, value, source] of effects("speed")) {
    if (op === "set" || (op === "max" && value > speedValue)) {
      speedValue = value;
      speedSource = source;
    }
  }
  const speedParts: Contribution[] = [{ source: speedSource, value: speedValue }];
  for (const [op, value, source] of effects("speed")) {
    if (op === "add") speedParts.push({ source, value });
  }
  if (armor?.strength && scores.str < armor.strength) {
    speedParts.push({ source: `${armor.name} (Str < ${armor.strength})`, value: -10 });
    warnings.push(
      `${armor.name} needs Strength ${armor.strength}: your Speed drops by 10 ft ` +
        `(Strength is ${scores.str}).`,
    );
  }
  if (armor?.stealth_disadvantage) {
    warnings.push(`${armor.name} gives Disadvantage on Dexterity (Stealth) checks.`);
  }
  if (exhaustion) speedParts.push({ source: `Exhaustion ${exhaustion}`, value: -5 * exhaustion });
  const stopped = [...(play?.conditions ?? [])]
    .map((id) => lookup(catalog.conditions, id))
    .find((c) => c?.speed_zero);
  const speedSoFar = speedParts.reduce((total, p) => total + p.value, 0);
  if (stopped) speedParts.push({ source: `${stopped.name} (Speed 0)`, value: -speedSoFar });
  else if (speedSoFar < 0) speedParts.push({ source: "minimum 0", value: -speedSoFar });

  const darkvision = Math.max(0, ...effects("darkvision").map(([, v]) => v));

  // Saves and skills
  const saveProfs = res.savingThrows();
  const allSaves = sum(effects("saves"));
  const savingThrows = mapAbilities((a) => ({
    modifier:
      mod[a] + (saveProfs.has(a) ? pb : 0) + allSaves + sum(effects(`save.${a}`)) + d20Penalty,
    proficient: saveProfs.has(a),
  }));
  const ownedSkills = res.skills();
  const expertise = res.expertise();
  const unproficientBonus = sum(effects("skill.unproficient"));
  const skills: SkillLine[] = SKILLS.map((skill) => {
    const ability = SKILL_ABILITY[skill];
    const proficient = ownedSkills.has(skill);
    const expert = proficient && expertise.has(skill);
    const bonus =
      sum(effects(`skill.${skill}`)) + (proficient ? 0 : unproficientBonus) + checks + d20Penalty;
    return {
      skill,
      ability,
      modifier: mod[ability] + (proficient ? pb : 0) + (expert ? pb : 0) + bonus,
      proficient_from: ownedSkills.get(skill) ?? null,
      expertise: expert,
    };
  });
  const perception = skills.find((line) => line.skill === "perception") as SkillLine;

  // Attacks
  const masteries = res.weaponMasteries();
  const weaponProfs = res.granted("weapon_proficiencies");
  const martialArtsDie = Math.max(0, ...effects("martial_arts.die").map(([, v]) => v));
  // Extra Attack from several classes doesn't stack: take the best.
  const attacksPerAction = Math.max(1, ...effects("attacks").map(([, v]) => v));
  const criticalHitOn = Math.min(20, ...effects("attack.critical").map(([, v]) => v));
  const attackContext: AttackContext = {
    catalog,
    scores,
    pb,
    weaponProfs,
    masteries,
    rangedBonus: effects("attack.ranged"),
    weaponBonus: effects("attack.weapon"),
    featIds: new Set(res.featSources().map((s) => s.feat.id)),
    // Martial Arts works only while you aren't wearing armor or wielding a Shield.
    martialArtsDie: armor === null && shield === null ? martialArtsDie : 0,
  };
  if (martialArtsDie && attackContext.martialArtsDie === 0) {
    warnings.push("Martial Arts doesn't work while you wear armor or wield a Shield.");
  }
  const attacks: AttackLine[] = [unarmedStrike(attackContext)];
  if (play) {
    // Every weapon carried (you wield it to attack); a magic weapon adds its bonus if you're
    // attuned to it when it needs Attunement.
    for (const item of play.items) {
      const weapon = lookup(catalog.weapons, item.base);
      if (!weapon) continue;
      const works = item.magic && (!item.magic.attunement || item.attuned);
      const bonus = works && item.magic ? item.magic.bonus : { attack: 0, damage: 0 };
      attacks.push(
        attackLine(weapon, attackContext, {
          name: item.name,
          attack: bonus.attack,
          damage: bonus.damage,
        }),
      );
    }
  } else {
    for (const itemId of Object.keys(equipment)) {
      const weapon = lookup(catalog.weapons, itemId);
      if (weapon) attacks.push(attackLine(weapon, attackContext));
    }
  }
  // Damage riders (Rage Damage, Sneak Attack, Divine Strike): the latest of each id wins.
  const riders = new Map<string, { rider: ResolvedRider; level: number }>();
  const activeToggles = new Set(
    toggleDefs.filter((t) => play?.active?.has(t.key)).map((t) => t.toggle.id),
  );
  for (const src of [...res.sources, ...itemSources]) {
    for (const def of src.grants.damage_riders) {
      // Frenzy: only while Rage and Reckless Attack are both active.
      if (!def.while_active.every((id) => activeToggles.has(id))) continue;
      const rider = resolveRider(def, src, catalog, classLevels);
      const previous = riders.get(def.id);
      if (rider && (!previous || src.level >= previous.level)) {
        riders.set(def.id, { rider, level: src.level });
      }
    }
  }
  const resolvedRiders = [...riders.values()].map((r) => r.rider);
  for (const [i, a] of attacks.entries()) attacks[i] = withRiders(a, resolvedRiders);
  if (d20Penalty) {
    for (const [i, a] of attacks.entries()) {
      attacks[i] = {
        ...a,
        attack_bonus: a.attack_bonus + d20Penalty,
        notes: [...a.notes, `Exhaustion ${d20Penalty}`],
      };
    }
  }

  // Spells
  const spellAttackBonus =
    (play?.items ?? []).reduce(
      (total, i) => total + (i.active && i.magic ? i.magic.bonus.spell_attack : 0),
      0,
    ) + d20Penalty;
  // Spell save DC bonuses (Innate Sorcery while active). kenli K-001: a bonus granted by a class feature applies
  // only to that class's Spellcasting ("the spell save DC of your Sorcerer spells"); other sources apply to all.
  const saveBonuses = effects("spell.save_dc").filter(([op]) => op === "add");
  const spellSaveBonus = (classId: string | null): number =>
    saveBonuses.reduce((total, [, value, , src]) => {
      const scope = classScope(src);
      return total + (scope === null || scope === classId ? value : 0);
    }, 0);
  const magic = spellcastingSummary(
    res,
    catalog,
    mod,
    pb,
    classLevels,
    spellAttackBonus,
    spellSaveBonus,
  );

  /** The spell save DC of a class's Spellcasting (Channel Divinity's DC). */
  const casting = res.sources.filter((src) => src.grants.spellcasting);
  const spellDc = (classId: string | null): number =>
    magic.spellcasting[casting.findIndex((src) => src.class_id === classId)]?.save_dc ?? 8 + pb;

  // Class table columns (Rages, Sneak Attack…) at the character's level in each class.
  const resources: ResourceLine[] = [];
  for (const c of classes) {
    const cls = lookup(catalog.classes, c.class_id);
    for (const [name, values] of Object.entries(cls?.progression ?? {})) {
      const value = values[c.level - 1];
      if (value !== undefined && value !== "—" && value !== 0) {
        resources.push({ class_id: c.class_id, name, value });
      }
    }
  }

  let size: Size | null = null;
  for (const src of res.sources) size = src.grants.size ?? size;

  const traits: TraitLine[] = res.sources
    .filter((src) => src.feat === null && src.key !== "creation")
    .flatMap((src) => src.grants.traits.map((t) => ({ ...t, source: src.name, level: src.level })));

  return {
    level,
    classes,
    scores,
    modifiers: mod,
    scores_complete: Object.keys(known).length === ABILITIES.length,
    proficiency_bonus: pb,
    max_hp: maxHp,
    hit_dice: hitDice,
    armor_class: stat(ac.parts),
    armor_worn: armor ? armor.name : null,
    initiative,
    speed: stat(speedParts),
    size,
    darkvision,
    saving_throws: savingThrows,
    ability_checks: mapAbilities((a) => mod[a] + checks + d20Penalty),
    skills,
    passive_perception: 10 + perception.modifier,
    attacks_per_action: attacksPerAction,
    critical_hit_on: criticalHitOn,
    attacks,
    tools: Object.fromEntries(res.tools()),
    languages: Object.fromEntries(res.languages()),
    resistances: [
      ...new Set([
        ...res.granted("resistances"),
        ...itemSources.flatMap((s) => s.grants.resistances),
      ]),
    ],
    advantages: [...res.sources, ...itemSources].flatMap((src) =>
      src.grants.advantages.flatMap((grant) => {
        // Danger Sense: "unless you have the Incapacitated condition".
        if (typeof grant === "string")
          return [{ target: grant, source: src.name, class_id: classScope(src) }];
        if (grant.unless.some((c) => play?.conditions.has(c))) return [];
        return [{ target: grant.target, source: src.name, class_id: classScope(src) }];
      }),
    ),
    rules: [...new Set([...res.sources, ...itemSources].flatMap((src) => src.grants.rules))],
    actions: res.sources.flatMap((src) =>
      src.grants.actions.map((a): FeatureActionLine => {
        const scope = usesScope(src);
        const classLevel = src.class_id ? (classLevels.get(src.class_id) ?? 0) : level;
        const column = (name: string) =>
          lookup(catalog.classes, src.class_id ?? "")?.progression[name]?.[classLevel - 1];
        /** Dice at this class level: the last `scaling` step reached. */
        const scaled = (dice: string, steps: readonly { level: number; dice: string }[]) =>
          steps.filter((x) => x.level <= classLevel).at(-1)?.dice ?? dice;
        const heal = a.heal && {
          dice: a.heal.dice === null ? null : scaled(a.heal.dice, a.heal.scaling),
          bonus:
            a.heal.bonus === "class_level"
              ? classLevel
              : typeof a.heal.bonus === "number"
                ? a.heal.bonus
                : mod[a.heal.bonus],
          pooled: a.heal.pooled,
        };
        const die = a.inspiration
          ? /(\d+)$/.exec(String(column(a.inspiration.progression)))?.[1]
          : null;
        return {
          key: `${scope}:${a.id}`,
          name: a.name,
          economy: a.economy,
          uses: a.uses === null ? null : `${scope}:${a.uses}`,
          cost: a.cost,
          pool: a.pool,
          target: a.target,
          heal,
          extra_action: a.extra_action,
          also: a.also,
          attacks: a.attacks,
          after_hit: a.after_hit,
          once_per_turn: a.once_per_turn,
          save: a.save && {
            ability: a.save.ability,
            dc:
              a.save.dc_ability === "spell"
                ? spellDc(src.class_id)
                : 8 + mod[a.save.dc_ability] + pb,
            conditions: a.save.conditions,
            rounds: a.save.rounds,
            ends_on: a.save.ends_on,
            damage: a.save.damage && {
              dice: scaled(a.save.damage.dice, a.save.damage.scaling),
              bonus:
                typeof a.save.damage.bonus === "number"
                  ? a.save.damage.bonus
                  : mod[a.save.damage.bonus],
              types: a.save.damage.types,
              half: a.save.damage.half,
            },
            on_success: a.save.on_success,
          },
          range: a.range,
          many: a.many,
          creature_types: a.creature_types,
          removes: a.removes,
          reduces_attack_damage: a.reduces_attack_damage && {
            dice: a.reduces_attack_damage.dice,
            bonus:
              a.reduces_attack_damage.abilities.reduce((t, ab) => t + mod[ab], 0) +
              (a.reduces_attack_damage.class_level ? classLevel : 0),
            types: a.reduces_attack_damage.types,
          },
          inspiration_die: die ? Number(die) : null,
          halves_attack_damage: a.halves_attack_damage,
        };
      }),
    ),
    spell_damage: [...res.sources, ...itemSources].flatMap((src) =>
      src.grants.spell_damage.map((d) => ({
        ...d,
        bonus: mod[d.ability],
        // `$cantrip`: the spell picked in the source's choice (Agonizing Blast).
        spell: d.spell === null ? null : (res.resolveRef(src, d.spell) ?? d.spell),
      })),
    ),
    toggles: toggleDefs.map(({ key, toggle, src }) => {
      const armorBlock = toggle.blocked_when.find((c) => conditions.get(c));
      const conditionBlock = toggle.ends_on.find((c) => play?.conditions.has(c));
      return {
        key,
        name: toggle.name,
        uses: toggle.uses === null ? null : `${usesScope(src)}:${toggle.uses}`,
        active: play?.active?.has(key) ?? false,
        blocked: armorBlock ?? conditionBlock ?? null,
        ends_on: toggle.ends_on,
        no_spells: toggle.no_spells,
        extends_each_turn: toggle.extends_each_turn,
        ends_at_turn_start: toggle.ends_at_turn_start,
        rounds: toggle.rounds,
      };
    }),
    cantrips: magic.spells.filter((s) => s.level === 0).map((s) => s.id),
    spellcasting: magic.spellcasting,
    spell_slots: magic.slots,
    pact_magic: magic.pact,
    spells: magic.spells,
    spellbook: magic.spellbook,
    resources,
    limited_uses: limitedUses(res, catalog, mod, pb, classLevels),
    armor_training: training,
    weapon_proficiencies: weaponProfs,
    feats: res.featSources().map((s) => s.name),
    features: res.featureSources().map((s) => s.name),
    traits,
    weapon_masteries: masteries,
    equipment,
    gp,
    warnings,
  };
}

/** Conditions that effects can depend on (`when`), given what the character wears. */
function armorConditions(armor: ArmorDef | null, shield: ArmorDef | null): Conditions {
  const when: Record<EffectCondition, boolean> = {
    wearing_armor: armor !== null,
    wielding_shield: shield !== null,
    wearing_heavy_armor: armor?.category === "heavy",
    not_wearing_heavy_armor: armor?.category !== "heavy",
    unarmored: armor === null && shield === null,
  };
  return new Map(Object.entries(when) as [EffectCondition, boolean][]);
}

function mapAbilities<T>(fn: (a: Ability) => T): Record<Ability, T> {
  return Object.fromEntries(ABILITIES.map((a) => [a, fn(a)])) as Record<Ability, T>;
}

const ABBREVIATIONS: Record<Ability, string> = {
  str: "Str",
  dex: "Dex",
  con: "Con",
  int: "Int",
  wis: "Wis",
  cha: "Cha",
};

interface ArmorClassOption {
  parts: Contribution[];
  armor: ArmorDef | null;
  shield: ArmorDef | null;
}

/**
 * Assume the character uses the best legal configuration: each armor they own and are trained
 * in, or no armor (plain 10 + Dex, or an alternative such as Unarmored Defense), with or without
 * a Shield. Effects that depend on it (`when: wearing_armor`) are included in the comparison.
 * Ties go to the earlier option, so you aren't put in armor that doesn't help.
 */
function bestArmorClass(
  equipment: Record<string, number>,
  training: readonly string[],
  res: Resolution,
  catalog: Catalog,
  mod: Record<Ability, number>,
  effectsFor: (target: EffectTarget, conditions: Conditions) => ResolvedEffect[],
  play?: PlayContext,
): ArmorClassOption {
  if (play) return wornArmorClass(res, catalog, mod, effectsFor, play);
  const owned = Object.keys(equipment)
    .map((id) => lookup(catalog.armor, id))
    .filter((a): a is ArmorDef => a !== undefined);
  const shieldItem = training.includes("shield")
    ? (owned.find((a) => a.category === "shield") ?? null)
    : null;

  const bodies: { parts: Contribution[]; armor: ArmorDef | null; shieldAllowed: boolean }[] = [
    {
      parts: [
        { source: "base (unarmored)", value: 10 },
        { source: "Dex", value: mod.dex },
      ],
      armor: null,
      shieldAllowed: true,
    },
  ];
  for (const src of res.sources) {
    for (const calc of src.grants.ac_calculations) {
      bodies.push({
        parts: [
          { source: calc.name, value: calc.base },
          ...calc.abilities.map((a) => ({ source: ABBREVIATIONS[a], value: mod[a] })),
        ],
        armor: null,
        shieldAllowed: calc.shield,
      });
    }
  }
  for (const armor of owned) {
    if (armor.category === "shield" || !training.includes(armor.category)) continue;
    const parts: Contribution[] = [{ source: armor.name, value: armor.base_ac }];
    if (armor.dex_cap !== 0) {
      const dex = armor.dex_cap === null ? mod.dex : Math.min(mod.dex, armor.dex_cap);
      const cap = armor.dex_cap === null ? "" : ` (max ${armor.dex_cap})`;
      parts.push({ source: `Dex${cap}`, value: dex });
    }
    bodies.push({ parts, armor, shieldAllowed: true });
  }

  let best: ArmorClassOption | null = null;
  let bestTotal = Number.NEGATIVE_INFINITY;
  for (const body of bodies) {
    for (const shield of body.shieldAllowed && shieldItem ? [null, shieldItem] : [null]) {
      const conditions = armorConditions(body.armor, shield);
      const parts = [...body.parts];
      if (shield) parts.push({ source: shield.name, value: shield.base_ac });
      for (const [op, value, source] of effectsFor("ac", conditions)) {
        if (op === "add") parts.push({ source, value });
      }
      const total = parts.reduce((sum, p) => sum + p.value, 0);
      if (total > bestTotal) {
        best = { parts, armor: body.armor, shield };
        bestTotal = total;
      }
    }
  }
  return best as ArmorClassOption;
}

/**
 * In play, AC comes from what the character actually wears: the equipped armor (or no armor,
 * with the best unarmored calculation) and the equipped Shield, plus magic bonuses.
 */
function wornArmorClass(
  res: Resolution,
  catalog: Catalog,
  mod: Record<Ability, number>,
  effectsFor: (target: EffectTarget, conditions: Conditions) => ResolvedEffect[],
  play: PlayContext,
): ArmorClassOption {
  const worn = (category: (c: string) => boolean) => {
    const item = play.items.find((i) => {
      const a = lookup(catalog.armor, i.base);
      return i.equipped && a && category(a.category);
    });
    if (!item) return null;
    let def = lookup(catalog.armor, item.base) as ArmorDef;
    if (item.magic?.ignores_armor_penalties)
      def = { ...def, strength: null, stealth_disadvantage: false };
    const bonus = item.magic && item.active ? item.magic.bonus.ac : 0;
    return { def: { ...def, name: item.name }, bonus };
  };
  const body = worn((c) => c !== "shield");
  const shield = worn((c) => c === "shield");
  const options: { parts: Contribution[]; ok: boolean }[] = [];
  if (body) {
    const parts: Contribution[] = [{ source: body.def.name, value: body.def.base_ac + body.bonus }];
    if (body.def.dex_cap !== 0) {
      const dex = body.def.dex_cap === null ? mod.dex : Math.min(mod.dex, body.def.dex_cap);
      parts.push({
        source: `Dex${body.def.dex_cap === null ? "" : ` (max ${body.def.dex_cap})`}`,
        value: dex,
      });
    }
    options.push({ parts, ok: true });
  } else {
    options.push({
      parts: [
        { source: "base (unarmored)", value: 10 },
        { source: "Dex", value: mod.dex },
      ],
      ok: true,
    });
    for (const src of res.sources) {
      for (const calc of src.grants.ac_calculations) {
        options.push({
          parts: [
            { source: calc.name, value: calc.base },
            ...calc.abilities.map((a) => ({ source: ABBREVIATIONS[a], value: mod[a] })),
          ],
          ok: calc.shield || !shield,
        });
      }
    }
  }
  const conditions = armorConditions(body?.def ?? null, shield?.def ?? null);
  let best: ArmorClassOption | null = null;
  let bestTotal = Number.NEGATIVE_INFINITY;
  for (const option of options.filter((o) => o.ok)) {
    const parts = [...option.parts];
    if (shield) parts.push({ source: shield.def.name, value: shield.def.base_ac + shield.bonus });
    for (const [op, value, source] of effectsFor("ac", conditions)) {
      if (op === "add") parts.push({ source, value });
    }
    const total = parts.reduce((sum, p) => sum + p.value, 0);
    if (total > bestTotal) {
      best = { parts, armor: body?.def ?? null, shield: shield?.def ?? null };
      bestTotal = total;
    }
  }
  return best as ArmorClassOption;
}

/** Limited-use features with their maximum now; a later definition of the same key wins. */
/** Resources and toggles of a class are keyed by the class (`barbarian:rage`), others by source. */
function usesScope(src: ActiveSource): string {
  return src.feat === null && src.feature === null && src.class_id ? src.class_id : src.key;
}

function limitedUses(
  res: Resolution,
  catalog: Catalog,
  mod: Record<Ability, number>,
  pb: number,
  classLevels: ReadonlyMap<string, number>,
): UsesLine[] {
  const byKey = new Map<string, { line: UsesLine; level: number }>();
  for (const src of res.sources) {
    for (const r of src.grants.resources) {
      const key = `${usesScope(src)}:${r.id}`;
      const classLevel = src.class_id ? (classLevels.get(src.class_id) ?? 0) : 0;
      let max = 0;
      if (r.max.value !== null) max = r.max.value;
      else if (r.max.progression !== null) {
        const cls = lookup(catalog.classes, src.class_id);
        const value = cls?.progression[r.max.progression]?.[classLevel - 1];
        max = typeof value === "number" ? value : 0;
      } else if (r.max.ability !== null) max = mod[r.max.ability];
      else if (r.max.proficiency) max = pb;
      else if (r.max.per_class_level !== null) max = r.max.per_class_level * classLevel;
      max = Math.max(max, r.max.min);
      const previous = byKey.get(key);
      if (!previous || src.level >= previous.level) {
        byKey.set(key, {
          line: {
            key,
            name: r.name,
            max,
            recharge: r.recharge,
            short_rest_regain: r.short_rest_regain,
          },
          level: src.level,
        });
      }
    }
  }
  return [...byKey.values()].map((v) => v.line);
}

/**
 * kenli K-001: the class a source belongs to for "your <Class> spells" effects: a class or subclass feature (and a
 * toggle it grants) has its class; a feat (even one taken at a class level), species, background or item has none.
 */
function classScope(src: {
  readonly feat: unknown;
  readonly class_id: string | null;
  readonly key?: string;
}): string | null {
  if (src.feat || src.key?.startsWith("item:")) return null;
  return src.class_id ?? null;
}

function spellcastingSummary(
  res: Resolution,
  catalog: Catalog,
  mod: Record<Ability, number>,
  pb: number,
  classLevels: ReadonlyMap<string, number>,
  spellAttackBonus = 0,
  spellSaveBonus: (classId: string | null) => number = () => 0,
): {
  spellcasting: SpellcastingLine[];
  slots: number[];
  pact: DerivedSheet["pact_magic"];
  spells: SpellLine[];
  spellbook: string[];
} {
  const spellcasting: SpellcastingLine[] = [];
  let casterLevel = 0;
  let pact: DerivedSheet["pact_magic"] = null;
  for (const src of res.sources) {
    const sc = src.grants.spellcasting;
    if (!sc) continue;
    const ability = res.resolveRef(src, sc.ability) as Ability | null;
    const classId = classScope(src);
    spellcasting.push({
      source: src.name,
      class_id: classId,
      list: sc.list === null ? null : res.resolveRef(src, sc.list),
      ability,
      save_dc: ability ? 8 + pb + mod[ability] + spellSaveBonus(classId) : null,
      attack_bonus: ability ? pb + mod[ability] + spellAttackBonus : null,
      progression: sc.progression,
    });
    const classLevel = src.class_id ? (classLevels.get(src.class_id) ?? 0) : 0;
    if (sc.progression === "full") casterLevel += classLevel;
    else if (sc.progression === "half") casterLevel += Math.ceil(classLevel / 2);
    else if (sc.progression === "pact") {
      const row = sc.pact_slots[classLevel - 1];
      if (row) pact = { slots: row.count, slot_level: row.level };
    }
  }
  const slots =
    casterLevel > 0 ? [...(catalog.creation.spell_slots[Math.min(casterLevel, 20) - 1] ?? [])] : [];

  // The spellcasting feature a source's spells are cast with: its own, else its class's (a subclass or a class level
  // feature); a feat, species, background or item without its own has none.
  const castWith = (src: (typeof res.sources)[number]): string | null => {
    if (src.grants.spellcasting) return src.name;
    const classId = classScope(src);
    return classId === null
      ? null
      : (spellcasting.find((l) => l.class_id === classId)?.source ?? null);
  };
  const spells = new Map<string, SpellLine>();
  const add = (id: string, src: (typeof res.sources)[number], always: boolean) => {
    const spell = lookup(catalog.spells, id);
    if (!spell) return;
    const line = castWith(src);
    const known = spells.get(id);
    if (!known) {
      spells.set(id, {
        id,
        name: spell.name,
        level: spell.level,
        source: src.name,
        always_prepared: always,
        spellcasting: line === null ? [] : [line],
      });
    } else if (line !== null && !known.spellcasting.includes(line)) {
      spells.set(id, { ...known, spellcasting: [...known.spellcasting, line] });
    }
  };
  for (const src of res.sources) {
    for (const id of src.grants.cantrips) add(id, src, false);
    for (const id of src.grants.spells) add(id, src, true);
  }
  const spellbook: string[] = [];
  for (const choice of res.choices) {
    if (choice.definition.kind !== "spell" || choice.definition.known_only) continue;
    // A choice that others prepare from (a spellbook) isn't itself prepared.
    const tag = choice.definition.tag;
    const isPool = tag !== null && res.choices.some((c) => c.definition.subset_of === tag);
    for (const id of res.contributed(choice)) {
      if (isPool) spellbook.push(id);
      else add(id, choice.source, choice.definition.always_prepared);
    }
  }
  const sorted = [...spells.values()].sort((a, b) => a.level - b.level);
  return { spellcasting, slots, pact, spells: sorted, spellbook };
}

interface AttackContext {
  catalog: Catalog;
  scores: Record<Ability, number>;
  pb: number;
  weaponProfs: readonly string[];
  masteries: readonly string[];
  rangedBonus: readonly ResolvedEffect[];
  /** Bonuses to every weapon attack roll (Sacred Weapon). */
  weaponBonus: readonly ResolvedEffect[];
  featIds: ReadonlySet<string>;
  /** Martial Arts die size (6 = d6) while it applies, else 0. */
  martialArtsDie: number;
}

function unarmedStrike(ctx: AttackContext): AttackLine {
  const strMod = abilityModifier(ctx.scores.str);
  const dexMod = abilityModifier(ctx.scores.dex);
  const line = (bonus: number, parts: DamagePart[], notes: string[]): AttackLine => ({
    name: "Unarmed Strike",
    kind: "melee",
    // Martial Arts uses Dexterity when it's higher.
    ability: ctx.martialArtsDie && dexMod > strMod ? "dex" : "str",
    weapon: false,
    properties: [],
    riders: [],
    attack_bonus: bonus,
    damage: formatDamage(parts),
    damage_type: "bludgeoning",
    damage_parts: parts,
    two_handed_damage_parts: null,
    light_extra_damage_parts: null,
    cleave_damage_parts: null,
    mastery: null,
    notes,
    reach: 5,
    range: null,
  });
  if (!ctx.martialArtsDie) {
    // 1 + Strength modifier, never below 0.
    const parts = [{ dice: null, bonus: Math.max(0, 1 + strMod), type: "bludgeoning" }];
    return line(strMod + ctx.pb, parts, []);
  }
  const abilityMod = Math.max(strMod, dexMod);
  const parts = [{ dice: `1d${ctx.martialArtsDie}`, bonus: abilityMod, type: "bludgeoning" }];
  return line(abilityMod + ctx.pb, parts, [
    "Martial Arts",
    "Bonus Action: one extra Unarmed Strike",
  ]);
}

function attackLine(
  w: WeaponDef,
  ctx: AttackContext,
  magic: { name: string; attack: number; damage: number } = { name: w.name, attack: 0, damage: 0 },
): AttackLine {
  const strMod = abilityModifier(ctx.scores.str);
  const dexMod = abilityModifier(ctx.scores.dex);
  const martialArts = ctx.martialArtsDie > 0 && isMonkWeapon(w);
  // Finesse (and Martial Arts): the better of Strength and Dexterity.
  let ability: Ability;
  if (w.properties.includes("finesse") || martialArts) ability = dexMod > strMod ? "dex" : "str";
  else ability = w.kind === "ranged" ? "dex" : "str";
  const abilityMod = ability === "dex" ? dexMod : strMod;
  const proficient = isWeaponProficient(w, ctx.weaponProfs);
  let bonus = abilityMod + (proficient ? ctx.pb : 0);
  const notes: string[] = [];
  if (w.kind === "ranged") bonus += ctx.rangedBonus.reduce((sum, [, v]) => sum + v, 0);
  bonus += ctx.weaponBonus.reduce((sum, [, v]) => sum + v, 0);
  if (!proficient) notes.push("not proficient");
  if (w.properties.includes("heavy")) {
    const needed: Ability = w.kind === "melee" ? "str" : "dex";
    if (ctx.scores[needed] < 13) notes.push(`Disadvantage (Heavy, ${ABILITY_NAMES[needed]} < 13)`);
  }
  if (w.range) notes.push(`range ${w.range}`);
  const twoHandedMelee =
    w.kind === "melee" &&
    (w.properties.includes("two-handed") || w.properties.includes("versatile"));
  if (ctx.featIds.has("great-weapon-fighting") && twoHandedMelee) {
    notes.push("GWF: treat 1-2 on damage dice as 3 (two hands)");
  }
  let die = w.damage;
  if (martialArts) {
    notes.push("Martial Arts");
    const sides = Number(/^1d(\d+)$/.exec(w.damage)?.[1] ?? 0);
    if (sides < ctx.martialArtsDie) die = `1d${ctx.martialArtsDie}`;
  }
  // A fixed amount (Blowgun: 1) gets no ability modifier (SRD "Damage Rolls").
  const part = (dice: string): DamagePart =>
    /^\d+$/.test(dice)
      ? { dice: null, bonus: Number(dice) + magic.damage, type: w.damage_type }
      : { dice, bonus: abilityMod + magic.damage, type: w.damage_type };
  const parts = [part(die)];
  const twoHanded = w.versatile_damage ? [part(w.versatile_damage)] : null;
  // The Light property's extra attack: "you don't add your ability modifier to the extra
  // attack's damage unless that modifier is negative" (Two-Weapon Fighting: you do).
  const keepModifier = abilityMod < 0 || ctx.featIds.has("two-weapon-fighting");
  const withoutModifier = (keep: boolean) =>
    parts.map((p) => (keep || p.dice === null ? p : { ...p, bonus: p.bonus - abilityMod }));
  const lightExtra = w.properties.includes("light") ? withoutModifier(keepModifier) : null;
  let damage = formatDamage(parts);
  if (twoHanded) damage += ` (${formatDamage(twoHanded)} two-handed)`;
  const mastery = ctx.masteries.includes(w.id)
    ? (lookup(ctx.catalog.masteries, w.mastery)?.name ?? null)
    : null;
  // Cleave: "don't add your ability modifier to that damage unless that modifier is negative".
  const cleave =
    mastery !== null && w.mastery === "cleave" ? withoutModifier(abilityMod < 0) : null;
  return {
    name: magic.name,
    kind: w.kind,
    ability,
    weapon: true,
    properties: w.properties,
    riders: [],
    attack_bonus: bonus + magic.attack,
    damage,
    damage_type: w.damage_type,
    damage_parts: parts,
    two_handed_damage_parts: twoHanded,
    light_extra_damage_parts: lightExtra,
    cleave_damage_parts: cleave,
    mastery,
    notes,
    // Reach adds 5 feet; a thrown or ranged weapon has a range ("20/60").
    reach: w.kind === "melee" ? (w.properties.includes("reach") ? 10 : 5) : null,
    range: parseRange(w.range),
  };
}

/** A rider with its damage worked out for its source's class level. */
interface ResolvedRider {
  readonly def: DamageRider;
  readonly source: string;
  readonly dice: string | null;
  readonly bonus: number;
}

function resolveRider(
  def: DamageRider,
  src: ActiveSource,
  catalog: Catalog,
  classLevels: ReadonlyMap<string, number>,
): ResolvedRider | null {
  let value: string | number | undefined;
  if (typeof def.damage === "string") value = def.damage;
  else {
    const cls = lookup(catalog.classes, src.class_id);
    const classLevel = src.class_id ? (classLevels.get(src.class_id) ?? 0) : 0;
    value = cls?.progression[def.damage.progression]?.[classLevel - 1];
  }
  // "{progression, die}": that many dice ("+2" Rage Damage → 2d6).
  if (typeof def.damage !== "string" && def.damage.die && value !== undefined) {
    const count = typeof value === "number" ? value : Number(value);
    return count > 0
      ? { def, source: src.name, dice: `${count}d${def.damage.die}`, bonus: 0 }
      : null;
  }
  if (typeof value === "number") return { def, source: src.name, dice: null, bonus: value };
  if (value === undefined) return null;
  if (/^\d+d\d+$/.test(value)) return { def, source: src.name, dice: value, bonus: 0 };
  if (/^[+-]?\d+$/.test(value)) return { def, source: src.name, dice: null, bonus: Number(value) };
  return null;
}

function riderApplies(rider: DamageRider, line: AttackLine): boolean {
  const to = rider.applies_to;
  if (to.ability !== null && line.ability !== to.ability) return false;
  if (to.weapon && !line.weapon) return false;
  if (to.any_of.length && !to.any_of.some((x) => x === line.kind || line.properties.includes(x))) {
    return false;
  }
  return true;
}

/**
 * Add riders to the attack lines they apply to: automatic ones (Rage Damage) become a damage part
 * of the weapon's type; the others are listed for `makeAttack`.
 */
function withRiders(line: AttackLine, riders: readonly ResolvedRider[]): AttackLine {
  let parts = [...line.damage_parts];
  let twoHanded = line.two_handed_damage_parts ? [...line.two_handed_damage_parts] : null;
  let lightExtra = line.light_extra_damage_parts ? [...line.light_extra_damage_parts] : null;
  let cleave = line.cleave_damage_parts ? [...line.cleave_damage_parts] : null;
  const notes = [...line.notes];
  const optional: AttackRider[] = [];
  for (const r of riders) {
    if (!riderApplies(r.def, line)) continue;
    const type = r.def.type === "weapon" ? line.damage_type : r.def.type;
    if (r.def.automatic && typeof type === "string") {
      const part = { dice: r.dice, bonus: r.bonus, type };
      parts = [...parts, part];
      if (twoHanded) twoHanded = [...twoHanded, part];
      if (lightExtra) lightExtra = [...lightExtra, part];
      if (cleave) cleave = [...cleave, part];
      notes.push(`${r.def.name} ${formatDamage([part]).replace(/^(\d)/, "+$1")}`);
    } else {
      optional.push({
        id: r.def.id,
        name: r.def.name,
        dice: r.dice,
        bonus: r.bonus,
        type,
        once_per_turn: r.def.once_per_turn,
        own_turn: r.def.own_turn,
        requires: r.def.requires,
      });
    }
  }
  let damage = formatDamage(parts);
  if (twoHanded) damage += ` (${formatDamage(twoHanded)} two-handed)`;
  return {
    ...line,
    damage,
    damage_parts: parts,
    two_handed_damage_parts: twoHanded,
    light_extra_damage_parts: lightExtra,
    cleave_damage_parts: cleave,
    riders: optional,
    notes,
  };
}
