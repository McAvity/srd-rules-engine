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
  /** The limited use (its `uses` key) one application spends, for a rider paid with a resource. */
  readonly uses?: string;
  /** At most one rider of this group per attack (Battle Master maneuvers). */
  readonly exclusive?: string;
  /** The target's saving throw when it's applied, its DC worked out. */
  readonly save?: {
    readonly ability: Ability;
    readonly dc: number;
    readonly conditions: readonly string[];
  };
  /** Paid instead by rolling these dice once per turn per `label` (Relentless). */
  readonly alternative?: { readonly dice: string; readonly label: string };
  /** The feature action (its key) that must have been used this turn. */
  readonly requires_feature?: string;
  /** kenli F-002 T12 (D024): conditions on the hit without a save, up to `max_size` (Charge). */
  readonly conditions?: { readonly names: readonly string[]; readonly max_size?: string };
}

export interface AttackLine {
  readonly name: string;
  /**
   * kenli F-002 T12 (D021/D022): the damage types its damage can be dealt as, the normal one first
   * (an attack's `damage_type`): Lunar Radiance, Exceptional Training. Absent: only its own.
   */
  readonly damage_types?: readonly string[];
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
  /** Only after taking the Attack action this turn (Pole Strike). */
  readonly after_attack_action?: boolean;
  /**
   * Only after an attack with one of these of the character's attack lines (by name) as part of
   * this turn's Attack action: the lines made with a qualifying carried weapon (Pole Strike).
   */
  readonly after_attack_with?: readonly string[];
  readonly once_per_turn: boolean;
  /** Used without its resource under a once-per-turn alternative shared with riders (Relentless). */
  readonly alternative?: { readonly label: string };
  /** Its use also counts as this other action's (its key) this turn, for riders that need it. */
  readonly counts_as?: string;
  /** Used when an attack roll misses (it hits instead), then not until your next turn starts. */
  readonly hit_on_miss?: boolean;
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
  /** The limited use it gives one back of (`bard:bardic-inspiration`), when it does. */
  readonly restores?: string;
  /** With `restores` and a slot: this many × the slot's level are restored (Arcane Ward). */
  readonly restores_per_slot_level?: number;
  /** Temporary Hit Points it gives when used, at this class level (Wild Shape). */
  readonly temp_hp?: number;
  /** kenli F-002 T12 (R14-01): used on a failed roll of these kinds (`useAfterFailedRoll`). */
  readonly after_failed_roll?: {
    readonly kinds: readonly ("check" | "attack")[];
    readonly spend: "on_success";
  };
  /** It takes one of the known forms (`use_feature`'s `form`): the class's choice id. */
  readonly shape?: {
    readonly choice: string;
    readonly class_id: string | null;
    /** The known forms (the choice's picks), each with why it can't be taken now, if so. */
    readonly forms: readonly {
      readonly id: string;
      readonly name: string;
      readonly unavailable: string | null;
    }[];
  };
  /** Paid with a spell slot instead of its uses, or always (`FeatureActionDef.slot_payment`). */
  readonly slot_payment?: "instead" | "required";
  /** The die the user rolls when using it (`1d8`), when it has one; `null`: no column value. */
  readonly roll_die?: string | null;
  /** kenli F-002 T12 (D021): `restores` only when none of it is left (Wild Resurgence). */
  readonly restores_when_empty?: boolean;
  /** kenli F-002 T12 (D021): another limited use it spends one of (`druid:wild-shape`). */
  readonly also_spends?: string;
  /** kenli F-002 T12 (D021): the level of the spell slot it gives back. */
  readonly restores_slot?: number;
  /** kenli F-002 T12 (D022): the action (its key) that must have been used this turn first. */
  readonly after_feature?: string;
  /** kenli F-002 T12 B2a (D040): the toggle (its key) it switches on. */
  readonly activates?: string;
}

/** kenli F-002 T10 (H3): a form choice's picks with the engine's availability now. */
function knownForms(
  res: Resolution,
  choiceId: string,
  classId: string | null,
): { id: string; name: string; unavailable: string | null }[] {
  const choice = res.choices.find(
    (c) => c.definition.id === choiceId && c.source.class_id === classId,
  );
  if (!choice) return [];
  const picks = res.selected(choice);
  return res
    .options(choice)
    .filter((o) => picks.includes(o.id))
    .map((o) => ({ id: o.id, name: o.name, unavailable: o.unavailable }));
}

/** The last line per key, in the place of the first (a later definition replaces an earlier one). */
function lastByKey<T extends { readonly key: string }>(lines: readonly T[]): T[] {
  const last = new Map(lines.map((l) => [l.key, l]));
  return lines
    .filter((l, i) => lines.findIndex((x) => x.key === l.key) === i)
    .map((l) => last.get(l.key) as T);
}

/** A Challenge Rating as a number (`1/4` → 0.25). */
export function crValue(cr: string | number): number {
  if (typeof cr === "number") return cr;
  const [n, d] = String(cr).split("/").map(Number);
  return d ? (n ?? 0) / d : (n ?? 0);
}

/** A cast trigger on the sheet (`Grants.cast_triggers`), its keys scoped like resources. */
export interface CastTriggerLine {
  readonly key: string;
  readonly name: string;
  readonly school: string;
  /** The tracked pool it creates or restores (`wizard:arcane-ward`). */
  readonly resource: string;
  readonly create: boolean;
  readonly restore_per_slot_level: number;
}

/** A spell cast without a slot through a limited use (`Grants.free_casts`), on the sheet. */
export interface FreeCastLine {
  /** The limited use spent (`feat:magic-initiate@…#feat:free-cast`). */
  readonly use: string;
  readonly name: string;
  /** The spellcasting feature it's cast with (`SpellcastingLine.source`), or `null`. */
  readonly spellcasting: string | null;
  readonly spells: readonly string[];
  /** kenli F-011: the source instance that grants it (`SpellGrant.key`); read-only provenance. */
  readonly source_key: string;
  /** kenli F-002 T12 (D011): nothing spent (Spell Mastery); `use` then only names it. */
  readonly at_will: boolean;
}

/** A d20 floor on ability checks (`Grants.d20_floors`), with the feature that gives it. */
export interface D20FloorLine {
  readonly min: number;
  readonly label: string;
  readonly skills: readonly string[] | null;
  readonly abilities: readonly Ability[] | null;
  readonly proficient: boolean;
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
  /** What else a use can be spent on (`ResourceDef.spend_for`), when anything. */
  readonly spend_for?: readonly ("d20_advantage" | "impose_disadvantage")[];
  /** A pool whose current value is kept (`ResourceDef.tracked`, Arcane Ward): see the play sheet. */
  readonly tracked?: true;
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
  /** Put away (`ItemInstance.location`): not carried, so not on the sheet's context at all. */
  readonly stored?: boolean;
  /** A custom item (kenli F-011): no rules, so never on the sheet's context either. */
  readonly custom?: boolean;
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
  /** kenli F-002 T10 (H3): the form the character is in (Wild Shape), a `monsters` id. */
  readonly shape?: string | null;
}

/** kenli F-002 T10 (H3): the form a character is in, its numbers for the table. */
export interface ShapeLine {
  readonly monster: string;
  readonly name: string;
  readonly cr: number;
  /** The form's AC (Circle Forms: at least 13 + WIS). */
  readonly armor_class: number;
  readonly speed: string;
  /** The form's own Hit Points, for reference: you keep yours (and the THP the use gave). */
  readonly stat_block_hp: number;
  /** Its attacks, on the sheet's attack lines with this suffix (`Bite (Wolf)`). */
  readonly attacks: readonly string[];
}

/** kenli F-002 T10 (H4): a companion's numbers derived for the character (`Grants.companions`). */
export interface CompanionLine {
  readonly name: string;
  readonly size: string;
  readonly hp: number;
  readonly armor_class: number;
  readonly speed: string;
  /** Its strike, an attack line of the sheet (rolled like the character's). */
  readonly attack: string;
  readonly notes: readonly string[];
}

/** kenli F-002 T10 (R12-03): a cast option on the sheet (Metamagic), its resource key resolved. */
export interface CastOptionLine {
  readonly key: string;
  readonly name: string;
  readonly cost: number;
  /** The limited use it spends (`sorcerer:sorcery-points`). */
  readonly uses: string;
  readonly combinable: boolean;
  readonly effect: "distant" | "quickened" | "subtle" | "heightened" | "careful" | null;
}

/** kenli F-002 T12 B2a: a toggle switched on by spending another resource (Sorcery Incarnate). */
export interface ToggleAlternativeLine {
  readonly toggle: string;
  readonly uses: string;
  readonly amount: number;
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
  /** kenli F-002 T08: the attack lines of the held weapons a Reactive Strike can be made with. */
  readonly reactive_strike: readonly string[];
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
  /** Spells you can cast without a slot by spending a use (Magic Initiate). */
  readonly free_casts: readonly FreeCastLine[];
  /** kenli F-002 T12 (D017): uses regained up to `to` when Initiative is rolled (Superior Inspiration). */
  readonly initiative_regain: readonly {
    readonly use: string;
    readonly to: number;
    readonly name: string;
  }[];
  /** kenli F-002 T12 (D017): a slot kept on a matching die roll (Boon of Spell Recall), or `null`. */
  readonly slot_refund: {
    readonly name: string;
    readonly die: string;
    readonly max_level: number;
  } | null;
  /**
   * What casting a spell of a school with a slot can do to a tracked pool (`Grants.cast_triggers`):
   * the caster picks it with that cast (a roll's `triggers`).
   */
  readonly cast_triggers: readonly CastTriggerLine[];
  /** kenli F-002 T10: the form you're in (null outside one), companions, cast options. */
  readonly shape: ShapeLine | null;
  readonly companions: readonly CompanionLine[];
  readonly cast_options: readonly CastOptionLine[];
  /**
   * kenli F-002 T12 B2a: how many cast options (not `combinable`) one spell can take now: 1, or
   * more while a `cast_option_limit` toggle is active (Sorcery Incarnate).
   */
  readonly cast_option_limit: number;
  readonly toggle_alternatives: readonly ToggleAlternativeLine[];
  /** d20 floors on ability checks from features (besides the named rule Reliable Talent). */
  readonly d20_floors: readonly D20FloorLine[];
  /**
   * In play, the armor worn without its training (`Chain Mail`): Disadvantage on Strength and
   * Dexterity D20 Tests and no spellcasting (SRD "Armor Training"); `null` otherwise.
   */
  readonly armor_untrained: string | null;
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
  /**
   * kenli F-011: the source instance's key (`feat:magic-initiate@species:human#versatile`): two
   * features of the same name (a repeatable feat) stay apart. Read-only provenance; casting still
   * names the feature by `source`.
   */
  readonly key: string;
  /** kenli F-011: the source that granted this one (a feat's origin: `Human`, `Sage`), or `""`. */
  readonly granted_by: string;
  /** kenli K-001: the class whose Spellcasting this is (its spells are that class's spells), `null` for a feat. */
  readonly class_id: string | null;
  /** Spell list id; `null` for a fixed set of spells or while it depends on an unanswered choice. */
  readonly list: string | null;
  readonly ability: Ability | null;
  readonly save_dc: number | null;
  readonly attack_bonus: number | null;
  /** How the class's levels count toward spell slots (`full`, `half`, `pact`), if at all. */
  readonly progression: "full" | "half" | "third" | "pact" | null;
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
  /**
   * kenli F-011: every source instance that grants the spell, in resolution order — the line's
   * `source` is the first one's name. Read-only provenance (the same spell from Elf and Sage, two
   * Magic Initiates with the same name); nothing here changes how the spell is cast or paid.
   */
  readonly grants: readonly SpellGrant[];
  /**
   * kenli F-002 T12 (D012): its range with the character's increases (`Grants.spell_ranges`), e.g.
   * `"270 feet"`, and the features that give them; absent when nothing changes the catalog's.
   */
  readonly range?: string;
  readonly range_from?: readonly string[];
}

/** kenli F-011: one source instance granting a spell (see `SpellLine.grants`). */
export interface SpellGrant {
  /** The granting source's key (stable, unique in the build). */
  readonly key: string;
  /** Its name, as `SpellLine.source` shows it. */
  readonly source: string;
  /** The source that granted the granting source (a feat's origin), or `""`. */
  readonly granted_by: string;
  /** The spellcasting feature it's cast with through this grant (`SpellcastingLine.source`), or `null`. */
  readonly spellcasting: string | null;
  /** That spellcasting feature's instance (`SpellcastingLine.key`), or `null`. */
  readonly spellcasting_key: string | null;
  readonly always_prepared: boolean;
  /**
   * kenli F-002 T12 (D026): this grant casts it only through its free cast (`FreeCast.line`), not
   * with a slot. Absent: an ordinary grant.
   */
  readonly free_only?: boolean;
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
  const armorUntrained =
    play && ac.armor && !training.includes(ac.armor.category) ? ac.armor.name : null;
  if (armorUntrained) {
    warnings.push(
      `You aren't trained with ${armorUntrained}: Disadvantage on Str and Dex tests and attacks, and no spellcasting.`,
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
    for (const [op, value, source] of effects("hp_max")) {
      if (op === "add") parts.push({ source, value });
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
    meleeWeaponBonus: effects("attack.melee_weapon"),
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
  // The weapons carried, with the name of the attack line each makes (an equipped one first).
  const carriedWeapons = (
    play
      ? [...play.items]
          .sort((a, b) => Number(b.equipped) - Number(a.equipped))
          .map((i) => ({ name: i.name, id: i.base }))
      : Object.keys(equipment).map((id) => ({ name: lookup(catalog.weapons, id)?.name, id }))
  ).flatMap(({ name, id }) => {
    const weapon = lookup(catalog.weapons, id);
    return weapon ? [{ name: name ?? weapon.name, weapon }] : [];
  });
  // Held (equipped) weapons, with their attack lines' names (Reactive Strike: "while holding").
  const heldWeapons = (
    play
      ? play.items.filter((i) => i.equipped).map((i) => ({ name: i.name, id: i.base }))
      : Object.keys(equipment).map((id) => ({ name: lookup(catalog.weapons, id)?.name, id }))
  ).flatMap(({ name, id }) => {
    const weapon = lookup(catalog.weapons, id);
    return weapon ? [{ name: name ?? weapon.name, weapon }] : [];
  });
  // Weapon strikes (Pole Strike): one line per strike, from the first carried weapon that
  // qualifies, its damage die and type replaced.
  for (const strike of res.sources.flatMap((src) => src.grants.weapon_strikes ?? [])) {
    const weapon = carriedWeapons.find((x) => weaponQualifies(x.weapon, strike))?.weapon;
    if (!weapon) continue;
    const base = attackLine(weapon, attackContext);
    const parts = base.damage_parts.map((p, i) =>
      i === 0 ? { ...p, dice: strike.die, type: strike.damage_type } : p,
    );
    attacks.push({
      ...base,
      name: strike.name,
      damage: formatDamage(parts),
      damage_type: strike.damage_type,
      damage_parts: parts,
      two_handed_damage_parts: null,
      light_extra_damage_parts: null,
      cleave_damage_parts: null,
      notes: [...base.notes, `with ${weapon.name}`],
    });
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
      const resolved = resolveRider(def, src, catalog, classLevels);
      const scope = usesScope(src);
      const rider = resolved && {
        ...resolved,
        ...(def.uses ? { uses: `${scope}:${def.uses}` } : {}),
        ...(def.requires_feature ? { requires_feature: `${scope}:${def.requires_feature}` } : {}),
        ...(def.save
          ? {
              save: {
                ability: def.save.ability,
                dc: 8 + pb + abilityModifier(scores[def.save.dc_ability]),
                conditions: def.save.conditions,
              },
            }
          : {}),
      };
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
  const uses = limitedUses(res, catalog, mod, pb, classLevels);
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

  // kenli F-002 T10 (H4): fixed attack lines (a companion's strike with your spell attack).
  const spellAttackOf = (src: ActiveSource): number =>
    magic.spellcasting.find((l) => l.class_id === classScope(src) && l.attack_bonus !== null)
      ?.attack_bonus ?? pb;
  for (const src of res.sources) {
    for (const f of src.grants.attack_lines ?? []) {
      const damage: DamagePart[] = [
        {
          dice: f.damage.dice,
          bonus: f.damage.bonus + (f.damage.ability ? mod[f.damage.ability] : 0),
          type: f.damage.type,
        },
      ];
      attacks.push({
        name: f.name,
        kind: f.kind,
        ability: null,
        weapon: false,
        properties: [],
        riders: [],
        attack_bonus: f.to_hit === "spell" ? spellAttackOf(src) : f.to_hit,
        damage: formatDamage(damage),
        damage_type: f.damage.type,
        damage_parts: damage,
        two_handed_damage_parts: null,
        light_extra_damage_parts: null,
        cleave_damage_parts: null,
        mastery: null,
        notes: f.notes,
        reach: f.kind === "melee" ? f.reach : null,
        range: null,
      });
    }
  }
  const companions: CompanionLine[] = res.sources.flatMap((src) => {
    const lvl = src.class_id ? (classLevels.get(src.class_id) ?? 0) : level;
    return (src.grants.companions ?? []).map((c) => ({
      name: c.name,
      size: c.size,
      hp: c.hp.base + c.hp.per_class_level * lvl,
      armor_class: c.ac.base + (c.ac.ability ? mod[c.ac.ability] : 0),
      speed: c.speed,
      attack: c.attack,
      notes: c.notes,
    }));
  });
  const cast_options: CastOptionLine[] = res.sources.flatMap((src) =>
    (src.grants.cast_options ?? []).map((o) => ({
      key: `${usesScope(src)}:${o.id}`,
      name: o.name,
      cost: o.cost,
      uses: `${o.resource_class}:${o.resource}`,
      combinable: o.combinable,
      effect: o.effect,
    })),
  );
  const cast_option_limit = Math.max(
    1,
    ...res.sources.flatMap((src) => {
      const l = src.grants.cast_option_limit;
      return l && play?.active?.has(`${usesScope(src)}:${l.while_active}`) ? [l.count] : [];
    }),
  );
  const toggle_alternatives: ToggleAlternativeLine[] = res.sources.flatMap((src) =>
    (src.grants.toggle_alternatives ?? []).map((t) => ({
      toggle: `${usesScope(src)}:${t.toggle}`,
      uses: `${t.resource_class}:${t.resource}`,
      amount: t.amount,
    })),
  );
  // kenli F-002 T10 (H3): in a form, its attacks are lines of the sheet and its AC is yours.
  let shape: ShapeLine | null = null;
  let acParts = ac.parts;
  const beast = play?.shape ? lookup(catalog.monsters, play.shape) : undefined;
  if (beast) {
    const floor = res.sources.flatMap((s) => (s.grants.shape_ac ? [s.grants.shape_ac] : []));
    const beastAc = beast.armor_class;
    const acNow = Math.max(beastAc, ...floor.map((f) => f.base + mod[f.ability]));
    const names: string[] = [];
    for (const action of [...beast.actions, ...beast.bonus_actions]) {
      const a = action.attack;
      if (!a?.damage.length) continue;
      const damage: DamagePart[] = a.damage.map((d) =>
        d.dice === null
          ? { dice: null, bonus: d.average, type: d.type }
          : { dice: d.dice, bonus: d.bonus, type: d.type },
      );
      const name = `${action.name} (${beast.name})`;
      names.push(name);
      attacks.push({
        name,
        kind: a.kind === "ranged" ? "ranged" : "melee",
        ability: null,
        weapon: false,
        properties: [],
        riders: [],
        attack_bonus: a.bonus,
        damage: formatDamage(damage),
        damage_type: damage[0]?.type ?? "",
        damage_parts: damage,
        two_handed_damage_parts: null,
        light_extra_damage_parts: null,
        cleave_damage_parts: null,
        mastery: null,
        notes: [`${beast.name} form`],
        reach: a.kind === "ranged" ? null : (a.reach ?? 5),
        range: parseRange(a.range),
      });
    }
    const speed = Object.entries(beast.speed)
      .filter(([, v]) => typeof v === "number")
      .map(([k, v]) => `${k} ${v} ft.`)
      .join(", ");
    shape = {
      monster: beast.id,
      name: beast.name,
      cr: crValue(beast.cr),
      armor_class: acNow,
      speed,
      stat_block_hp: typeof beast.hit_points === "number" ? beast.hit_points : 0,
      attacks: names,
    };
    acParts = [{ source: `${beast.name} form`, value: acNow }];
  }

  // kenli F-002 T12 (D021/D022): riders and damage types of a form's attacks and a companion's
  // strike (`applies_to.lines`, `attack_damage_types`); Increased Toughness while in a form.
  const shapeNames = new Set(shape?.attacks ?? []);
  const companionNames = new Set(
    res.sources.flatMap((src) => (src.grants.companions ?? []).map((c) => c.attack)),
  );
  const typeChoices = res.sources.flatMap((src) => src.grants.attack_damage_types ?? []);
  for (const [i, a] of attacks.entries()) {
    const kind = shapeNames.has(a.name)
      ? ("shape" as const)
      : companionNames.has(a.name)
        ? ("companion" as const)
        : undefined;
    if (!kind) continue;
    const extra = [
      ...new Set(typeChoices.filter((t) => t.lines === kind).flatMap((t) => t.types)),
    ].filter((t) => t !== a.damage_type);
    const line = withRiders(a, resolvedRiders, kind);
    attacks[i] = extra.length ? { ...line, damage_types: [a.damage_type, ...extra] } : line;
  }
  if (shape) {
    for (const src of res.sources)
      for (const g of src.grants.shape_saves ?? []) {
        const line = savingThrows[g.save];
        (savingThrows as Record<Ability, SaveLine>)[g.save] = {
          ...line,
          modifier: line.modifier + mod[g.ability],
        };
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
    armor_class: stat(acParts),
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
    // kenli F-002 T08: the explicit `reactive_strike` rule (never a trait's name): its weapons.
    reactive_strike: [...res.sources, ...itemSources].some((src) =>
      src.grants.rules.includes("reactive_strike"),
    )
      ? heldWeapons.filter((x) => weaponQualifies(x.weapon, REACTIVE_STRIKE)).map((x) => x.name)
      : [],
    // A later action with the same key replaces an earlier one (kenli F-002 T10: Bestial Fury's
    // command with two strikes at Ranger 11), as riders do.
    actions: lastByKey(
      res.sources.flatMap((src) =>
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
          const rollDie = (roll: NonNullable<typeof a.roll>): string | null => {
            if ("dice" in roll) return roll.dice;
            const sides = /(\d+)$/.exec(String(column(roll.progression)))?.[1];
            return sides ? `1d${sides}` : null;
          };
          const qualifying = a.after_attack_with;
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
            ...(a.after_attack_action ? { after_attack_action: true } : {}),
            ...(qualifying
              ? {
                  after_attack_with: carriedWeapons
                    .filter((x) => weaponQualifies(x.weapon, qualifying))
                    .map((x) => x.name),
                }
              : {}),
            once_per_turn: a.once_per_turn,
            ...(a.alternative ? { alternative: { label: a.alternative.label } } : {}),
            ...(a.counts_as ? { counts_as: `${scope}:${a.counts_as}` } : {}),
            ...(a.hit_on_miss ? { hit_on_miss: true } : {}),
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
            ...(a.restores ? { restores: `${scope}:${a.restores}` } : {}),
            ...(a.restores_per_slot_level
              ? { restores_per_slot_level: a.restores_per_slot_level }
              : {}),
            ...(a.temp_hp ? { temp_hp: a.temp_hp.per_class_level * classLevel } : {}),
            ...(a.after_failed_roll ? { after_failed_roll: a.after_failed_roll } : {}),
            ...(a.shape
              ? {
                  shape: {
                    choice: a.shape.choice,
                    class_id: src.class_id,
                    forms: knownForms(res, a.shape.choice, src.class_id),
                  },
                }
              : {}),
            ...(a.slot_payment ? { slot_payment: a.slot_payment } : {}),
            ...(a.roll ? { roll_die: rollDie(a.roll) } : {}),
            ...(a.restores_when_empty ? { restores_when_empty: true } : {}),
            ...(a.also_spends ? { also_spends: `${scope}:${a.also_spends}` } : {}),
            ...(a.restores_slot ? { restores_slot: a.restores_slot } : {}),
            ...(a.after_feature ? { after_feature: `${scope}:${a.after_feature}` } : {}),
            ...(a.activates ? { activates: `${scope}:${a.activates}` } : {}),
          };
        }),
      ),
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
    limited_uses: uses,
    initiative_regain: res.sources.flatMap((src) =>
      (src.grants.initiative_regain ?? []).map((r) => ({
        use: `${usesScope(src)}:${r.uses}`,
        to: r.to,
        name: src.name,
      })),
    ),
    slot_refund: res.sources.find((src) => src.grants.slot_refund)?.grants.slot_refund ?? null,
    free_casts: magic.free_casts.map((f) => ({
      ...f,
      name:
        uses.find((u) => u.key === f.use)?.name ??
        (f.at_will ? (res.sources.find((x) => x.key === f.source_key)?.name ?? f.use) : f.use),
    })),
    shape,
    companions,
    cast_options,
    cast_option_limit,
    toggle_alternatives,
    cast_triggers: res.sources.flatMap((src) =>
      (src.grants.cast_triggers ?? []).map((t) => ({
        key: `${usesScope(src)}:${t.id}`,
        name: t.name,
        school: t.school,
        resource: `${usesScope(src)}:${t.resource}`,
        create: t.create,
        restore_per_slot_level: t.restore_per_slot_level,
      })),
    ),
    d20_floors: res.sources.flatMap((src) =>
      (src.grants.d20_floors ?? []).map((f) => ({
        min: f.min,
        label: f.label ?? src.name,
        skills: f.skills ?? null,
        abilities: f.abilities ?? null,
        proficient: f.proficient ?? false,
      })),
    ),
    armor_untrained: armorUntrained,
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
      if (r.max.plus_ability) max += mod[r.max.plus_ability];
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
            ...(r.spend_for?.length ? { spend_for: r.spend_for } : {}),
            ...(r.tracked ? { tracked: true } : {}),
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
  free_casts: Omit<FreeCastLine, "name">[];
} {
  const spellcasting: SpellcastingLine[] = [];
  let casterLevel = 0;
  let pact: DerivedSheet["pact_magic"] = null;
  // XPHB Multiclass Spellcaster: a third-caster's levels are rounded down when it shares slots with
  // another spellcasting class, and up (its own table) when it is the only one.
  const slotClasses = new Set(
    res.sources
      .filter(
        (s) => s.grants.spellcasting?.progression && s.grants.spellcasting.progression !== "pact",
      )
      .map((s) => s.class_id),
  );
  for (const src of res.sources) {
    const sc = src.grants.spellcasting;
    if (!sc) continue;
    const ability = res.resolveRef(src, sc.ability) as Ability | null;
    const classId = classScope(src);
    spellcasting.push({
      source: src.name,
      key: src.key,
      granted_by: src.granted_by,
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
    else if (sc.progression === "third")
      casterLevel += slotClasses.size > 1 ? Math.floor(classLevel / 3) : Math.ceil(classLevel / 3);
    else if (sc.progression === "pact") {
      const row = sc.pact_slots[classLevel - 1];
      if (row) pact = { slots: row.count, slot_level: row.level };
    }
  }
  const slots =
    casterLevel > 0 ? [...(catalog.creation.spell_slots[Math.min(casterLevel, 20) - 1] ?? [])] : [];

  // The spellcasting feature a source's spells are cast with: its own, else its class's (a subclass or a class level
  // feature); a feat, species, background or item without its own has none.
  const castLine = (src: (typeof res.sources)[number]): SpellcastingLine | null => {
    if (src.grants.spellcasting) return spellcasting.find((l) => l.key === src.key) ?? null;
    const classId = classScope(src);
    return classId === null ? null : (spellcasting.find((l) => l.class_id === classId) ?? null);
  };
  const castWith = (src: (typeof res.sources)[number]): string | null => {
    if (src.grants.spellcasting) return src.name;
    return castLine(src)?.source ?? null;
  };
  const spells = new Map<string, SpellLine>();
  const add = (id: string, src: (typeof res.sources)[number], always: boolean) => {
    const spell = lookup(catalog.spells, id);
    if (!spell) return;
    const line = castWith(src);
    const grant: SpellGrant = {
      key: src.key,
      source: src.name,
      granted_by: src.granted_by,
      spellcasting: line,
      spellcasting_key: castLine(src)?.key ?? null,
      always_prepared: always,
    };
    const known = spells.get(id);
    if (!known) {
      spells.set(id, {
        id,
        name: spell.name,
        level: spell.level,
        source: src.name,
        always_prepared: always,
        spellcasting: line === null ? [] : [line],
        grants: [grant],
      });
      return;
    }
    const grants = known.grants.some((g) => g.key === grant.key)
      ? known.grants
      : [...known.grants, grant];
    const casting =
      line !== null && !known.spellcasting.includes(line)
        ? [...known.spellcasting, line]
        : known.spellcasting;
    if (grants !== known.grants || casting !== known.spellcasting)
      spells.set(id, { ...known, spellcasting: casting, grants });
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
  // kenli F-002 T12 (D026): a free cast with `line` puts its named spells on the sheet from its
  // source, cast only through it (no slot line: `free_only`).
  for (const src of res.sources)
    for (const f of src.grants.free_casts ?? [])
      if (f.line)
        for (const id of f.spells ?? []) {
          const before = spells.get(id);
          add(id, src, true);
          const now = spells.get(id);
          if (now && now !== before)
            spells.set(id, {
              ...now,
              grants: now.grants.map((g) => (g.key === src.key ? { ...g, free_only: true } : g)),
            });
        }
  // kenli F-002 T12 (D012): range increases, stated on the line (the catalog's own range unchanged).
  const ranges = res.sources.flatMap((src) =>
    (src.grants.spell_ranges ?? []).map((r) => {
      const ref = r.spell;
      let only: readonly string[] | null = null;
      if (ref?.startsWith("$")) {
        const choice = res.choices.find(
          (c) => c.source.key === src.key && c.definition.id === ref.slice(1),
        );
        only = choice ? res.contributed(choice) : [];
      } else if (ref) only = [ref];
      const per = r.per_class_level;
      const feet = (r.feet ?? 0) + (per ? per.feet * (classLevels.get(per.class) ?? 0) : 0);
      return { name: r.name, only, feet, attack: r.attack_roll === true, min: r.min_feet ?? 0 };
    }),
  );
  if (ranges.length)
    for (const [id, line] of spells) {
      const def = lookup(catalog.spells, id);
      const base = def ? /^(\d+) feet$/.exec(def.range.trim()) : null;
      if (!def || !base) continue;
      const feet = Number(base[1]);
      const hits = ranges.filter(
        (r) =>
          r.feet > 0 &&
          feet >= r.min &&
          (r.only === null || r.only.includes(id)) &&
          (!r.attack || (def.mechanics?.attack ?? null) !== null),
      );
      if (hits.length)
        spells.set(id, {
          ...line,
          range: `${feet + hits.reduce((a, r) => a + r.feet, 0)} feet`,
          range_from: hits.map((r) => r.name),
        });
    }
  const sorted = [...spells.values()].sort((a, b) => a.level - b.level);
  // Free casts: the spells named, or picked in the source's own choice, with the source's line.
  const free_casts = res.sources.flatMap((src) =>
    (src.grants.free_casts ?? []).map((f) => {
      const choice = f.choice
        ? res.choices.find((c) => c.source.key === src.key && c.definition.id === f.choice)
        : undefined;
      return {
        // kenli F-002 T12 (D011): an at-will cast spends nothing; its key names the source.
        use: f.uses !== undefined ? `${usesScope(src)}:${f.uses}` : `${src.key}#at-will`,
        at_will: f.at_will === true,
        spellcasting: castWith(src),
        spells: [...(f.spells ?? []), ...(choice ? res.contributed(choice) : [])],
        source_key: src.key,
      };
    }),
  );
  return { spellcasting, slots, pact, spells: sorted, spellbook, free_casts };
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
  /** Effects on attack rolls with a Melee weapon only (`attack.melee_weapon`). */
  meleeWeaponBonus: readonly ResolvedEffect[];
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
  if (w.kind !== "ranged") bonus += ctx.meleeWeaponBonus.reduce((sum, [, v]) => sum + v, 0);
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

/** A weapon one of these ids, or with all of these properties (when some are given). */
/**
 * kenli F-002 T08: the `reactive_strike` rule's weapons (Polearm Master's Reactive Strike: "a
 * Quarterstaff, a Spear, or a weapon that has the Heavy and Reach properties").
 */
const REACTIVE_STRIKE = { weapons: ["quarterstaff", "spear"], properties: ["heavy", "reach"] };

function weaponQualifies(
  w: WeaponDef,
  q: { readonly weapons: readonly string[]; readonly properties: readonly string[] },
): boolean {
  return (
    q.weapons.includes(w.id) ||
    (q.properties.length > 0 && q.properties.every((p) => w.properties.includes(p)))
  );
}

/** A rider with its damage worked out for its source's class level. */
interface ResolvedRider {
  readonly def: DamageRider;
  readonly source: string;
  readonly dice: string | null;
  readonly bonus: number;
  /** The `uses` key a paid rider spends (its source's scope, as for a feature action). */
  readonly uses?: string;
  readonly save?: AttackRider["save"];
  readonly requires_feature?: string;
}

function resolveRider(
  def: DamageRider,
  src: ActiveSource,
  catalog: Catalog,
  classLevels: ReadonlyMap<string, number>,
): ResolvedRider | null {
  let value: string | number | undefined;
  if (typeof def.damage === "string") {
    value = def.damage;
    // kenli F-002 T12 (D022): other dice from a class level (the highest reached).
    const lvl = src.class_id ? (classLevels.get(src.class_id) ?? 0) : 0;
    for (const x of [...(def.scaling ?? [])].sort((p, q) => p.level - q.level))
      if (lvl >= x.level) value = x.dice;
  } else {
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

function riderApplies(
  rider: DamageRider,
  line: AttackLine,
  lineKind?: "shape" | "companion",
): boolean {
  const to = rider.applies_to;
  if (to.lines !== lineKind) return false;
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
function withRiders(
  line: AttackLine,
  riders: readonly ResolvedRider[],
  lineKind?: "shape" | "companion",
): AttackLine {
  let parts = [...line.damage_parts];
  let twoHanded = line.two_handed_damage_parts ? [...line.two_handed_damage_parts] : null;
  let lightExtra = line.light_extra_damage_parts ? [...line.light_extra_damage_parts] : null;
  let cleave = line.cleave_damage_parts ? [...line.cleave_damage_parts] : null;
  const notes = [...line.notes];
  const optional: AttackRider[] = [];
  for (const r of riders) {
    if (!riderApplies(r.def, line, lineKind)) continue;
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
        ...(r.uses ? { uses: r.uses } : {}),
        ...(r.def.exclusive ? { exclusive: r.def.exclusive } : {}),
        ...(r.save ? { save: r.save } : {}),
        ...(r.def.alternative ? { alternative: r.def.alternative } : {}),
        ...(r.requires_feature ? { requires_feature: r.requires_feature } : {}),
        ...(r.def.conditions ? { conditions: r.def.conditions } : {}),
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
