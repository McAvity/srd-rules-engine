/**
 * kenli F-013 T02: what a catalog item would mean for a character today, read-only. For each
 * requested record (a table and an id, optionally the base and kind of a magic item) it reports
 * proficiency or training, Weapon Mastery separately, the restrictions of using it (each as a
 * coded message, checked by the engine or left to the table), the magic item's allowed bases and
 * which of them the character is proficient with, and the listed price exactly as `buy` charges
 * it. The answer is plain JSON; nothing is bought, added, equipped or changed.
 *
 * Everything comes from the current play sheet (`computePlaySheet`: today's choices, level,
 * active items) and the same helpers the sheet and the actions use (`isWeaponProficient`,
 * `allowedBases`, `attunementBlocker`, `listedPrice`), never from a level plan.
 */

import { type Catalog, lookup } from "../content/catalog";
import type { CharacterBuild } from "../models/build";
import type { ArmorDef, MagicItemDef, WeaponDef } from "../models/content";
import type { Message } from "../models/messages";
import { type CharacterState, MAX_ATTUNED } from "../models/state";
import { resolve } from "../rules/build-resolution";
import { message } from "../rules/messages";
import { isWeaponProficient } from "../rules/weapons";
import {
  allowedBases,
  attunementBlocker,
  carriedItems,
  computePlaySheet,
  listedPrice,
  magicItemName,
  mundaneName,
  type PlaySheet,
} from "./play";

/** The catalog tables an assessment can read. */
export const ITEM_TABLES = ["weapons", "armor", "tools", "gear", "magic_items"] as const;
export type ItemTable = (typeof ITEM_TABLES)[number];

/** One record to assess: a catalog item, and for a magic item its base and kind (variant). */
export interface ItemAssessmentRequest {
  readonly table: ItemTable;
  readonly item: string;
  /** A magic item's base (`longsword` for Weapon, +1); omitted when it has a single one. */
  readonly base?: string | null;
  /** A magic item's kind (`fire` for Ring of Resistance). */
  readonly variant?: string | null;
}

/**
 * `yes` / `no`: the character has (or lacks) the proficiency or training using it needs;
 * `not_applicable`: none applies (ordinary gear, ammunition, a ring); `unknown`: nothing to judge
 * (an unknown id, an invalid base); `choose_base`: a magic item made from one of several items
 * (see `bases`).
 */
export type ItemProficiencyStatus = "yes" | "no" | "not_applicable" | "unknown" | "choose_base";

/** What kind of thing it is: a magic item takes its base's kind, else `gear`. */
export type ItemKind = "weapon" | "armor" | "shield" | "tool" | "gear";

export interface ItemProficiency {
  readonly status: ItemProficiencyStatus;
  readonly reason: Message;
  /**
   * What covers it when `yes`: the weapon proficiency entry (`simple`, `martial:light`,
   * `longsword`), the armor category or `shield`, or the tool proficiency's source.
   */
  readonly via: string | null;
  /** The Proficiency Bonus it adds when `yes` (weapon attack rolls, tool checks); else `null`. */
  readonly bonus: number | null;
}

export interface ItemMastery {
  /** `yes`: the character can use this weapon's mastery property now; `no`: they can't. */
  readonly status: ItemProficiencyStatus;
  /** The weapon's mastery property (`sap`) and its name, for a weapon. */
  readonly property: string | null;
  readonly name: string | null;
  readonly reason: Message;
}

export type ItemRestrictionCode =
  | "weapon_not_proficient"
  | "heavy_weapon"
  | "two_handed_with_shield"
  | "armor_untrained"
  | "armor_strength"
  | "armor_stealth"
  | "shield_untrained"
  | "tool_not_proficient"
  | "tool_activity"
  | "attunement_required"
  | "attunement_not_allowed"
  | "attunement_manual"
  | "attunement_limit";

/**
 * Something that happens if the character uses the item (not for owning it).
 * `effect`: `no_proficiency_bonus` (no PB with it), `penalty` (a concrete drawback),
 * `requirement` (attunement), `note` (how it works). `evaluation`: `checked` by the engine for
 * this character, or `manual` (only the text says it: the table judges).
 */
export interface ItemRestriction {
  readonly code: ItemRestrictionCode;
  readonly effect: "no_proficiency_bonus" | "penalty" | "requirement" | "note";
  readonly evaluation: "checked" | "manual";
  readonly message: Message;
}

/** A problem with the request itself (the same messages `add_item` refuses with). */
export interface ItemRequestIssue {
  readonly code:
    | "unknown_item"
    | "choose_base"
    | "invalid_base"
    | "base_not_used"
    | "choose_variant"
    | "invalid_variant"
    | "variant_not_used";
  readonly message: Message;
}

/** One base a magic item can be made from, assessed for this character. */
export interface ItemBaseOption {
  readonly id: string;
  readonly name: string;
  readonly proficiency: ItemProficiencyStatus;
  readonly mastery: ItemProficiencyStatus;
}

export interface ItemBases {
  /** Every allowed base (`magicItemBases`), in catalog order. */
  readonly allowed: readonly ItemBaseOption[];
  /** The allowed bases the character is proficient or trained with (`proficiency: "yes"`). */
  readonly proficient: readonly string[];
  readonly any_proficient: boolean;
}

export interface ItemAssessment {
  /** `table:item`, then `@base` and `#variant` when requested: stable for the same request. */
  readonly key: string;
  readonly table: ItemTable;
  readonly item: string;
  /** The base assessed (the requested one, or the only one); `null` if none or not chosen. */
  readonly base: string | null;
  readonly variant: string | null;
  /** Whether `item` is in `table`. */
  readonly found: boolean;
  /** The name as the inventory would show it (`Longsword, +1`); `null` for an unknown id. */
  readonly name: string | null;
  readonly kind: ItemKind | null;
  readonly magic: boolean;
  /** A magic item's category (`weapon`, `ring`, `wondrous`…). */
  readonly magic_category: string | null;
  readonly proficiency: ItemProficiency;
  readonly mastery: ItemMastery;
  readonly restrictions: readonly ItemRestriction[];
  readonly issues: readonly ItemRequestIssue[];
  /** A magic item made from other items: its bases; `null` otherwise. */
  readonly bases: ItemBases | null;
  /** A magic item's kinds to choose from (Ring of Resistance); empty otherwise. */
  readonly variants: readonly { readonly id: string; readonly name: string }[];
  readonly requires_attunement: boolean;
  /** Copper for one catalog bundle, as `buy` charges it (`listedPrice`); `null`: no listed price. */
  readonly price_cp: number | null;
  /** How many one purchase gives (Arrows: 20). */
  readonly bundle: number;
}

interface Context {
  readonly catalog: Catalog;
  readonly sheet: PlaySheet;
  readonly res: ReturnType<typeof resolve>;
  /** The Shield the character holds now (equipped, carried), if any. */
  readonly heldShield: string | null;
  readonly attuned: number;
}

/**
 * Assess catalog items for a character as of their current state: one answer per request, in
 * order. An unknown id or table gives `found: false` and `unknown`, never an error. Reads only:
 * the build, state and catalog are unchanged, and the answer is JSON-serializable.
 */
export function assessInventoryItems(
  build: CharacterBuild,
  state: CharacterState,
  catalog: Catalog,
  requests: readonly ItemAssessmentRequest[],
): ItemAssessment[] {
  const sheet = computePlaySheet(build, state, catalog);
  const held = carriedItems(state, catalog).find(
    (i) =>
      i.equipped && !i.stored && !i.custom && lookup(catalog.armor, i.base)?.category === "shield",
  );
  const ctx: Context = {
    catalog,
    sheet,
    // As the `attune` action judges it.
    res: resolve(build, catalog),
    heldShield: held?.name ?? null,
    attuned: state.inventory.filter((i) => i.attuned).length,
  };
  return requests.map((request) => assessOne(ctx, request));
}

function assessOne(ctx: Context, request: ItemAssessmentRequest): ItemAssessment {
  const { catalog } = ctx;
  const table = request.table;
  const requestedBase = request.base ?? null;
  const requestedVariant = request.variant ?? null;
  const key =
    `${table}:${request.item}` +
    (requestedBase ? `@${requestedBase}` : "") +
    (requestedVariant ? `#${requestedVariant}` : "");
  const known = (ITEM_TABLES as readonly string[]).includes(table)
    ? lookup(catalog[table] as Record<string, { name: string }>, request.item)
    : undefined;
  const price = known ? listedPrice(catalog, request.item) : null;
  const common = {
    key,
    table,
    item: request.item,
    price_cp: price?.cp ?? null,
    bundle: price?.bundle ?? 1,
  };
  if (!known) {
    const why = message("refusal.unknown_item", { item: request.item });
    return {
      ...common,
      base: requestedBase,
      variant: requestedVariant,
      found: false,
      name: null,
      kind: null,
      magic: false,
      magic_category: null,
      proficiency: { status: "unknown", reason: why, via: null, bonus: null },
      mastery: { status: "unknown", property: null, name: null, reason: why },
      restrictions: [],
      issues: [{ code: "unknown_item", message: why }],
      bases: null,
      variants: [],
      requires_attunement: false,
    };
  }

  const issues: ItemRequestIssue[] = [];
  const magic =
    table === "magic_items" ? (lookup(catalog.magic_items, request.item) ?? null) : null;
  if (!magic) {
    if (requestedBase)
      issues.push({
        code: "base_not_used",
        message: message("item.base_not_used", { item: known.name, base: requestedBase }),
      });
    if (requestedVariant)
      issues.push({
        code: "variant_not_used",
        message: message("item.variant_not_used", { item: known.name, variant: requestedVariant }),
      });
    const one = assessMundane(ctx, request.item);
    return {
      ...common,
      base: null,
      variant: null,
      found: true,
      name: known.name,
      kind: one.kind,
      magic: false,
      magic_category: null,
      proficiency: one.proficiency,
      mastery: one.mastery,
      restrictions: one.restrictions,
      issues,
      bases: null,
      variants: [],
      requires_attunement: false,
    };
  }

  // A magic item: its kind (variant), then its base, as `add_item` picks them.
  // An invalid kind stays as requested (with its issue); without kinds there's none.
  const variant = magic.variants.length ? requestedVariant : null;
  if (magic.variants.length) {
    if (!magic.variants.some((v) => v.id === variant)) {
      issues.push({
        code: requestedVariant ? "invalid_variant" : "choose_variant",
        message: message("refusal.item_choose_variant", {
          item: magic.name,
          variants: magic.variants.map((v) => v.id),
        }),
      });
    }
  } else if (requestedVariant) {
    issues.push({
      code: "variant_not_used",
      message: message("item.variant_not_used", { item: magic.name, variant: requestedVariant }),
    });
  }

  let bases: ItemBases | null = null;
  let base: string | null = null;
  /** The base the name is made from: a valid one only ("Weapon, +1", not "Chain Mail, +1"). */
  let named: string | null = null;
  let assessed: Assessed;
  if (magic.base) {
    const allowed = allowedBases(catalog, magic);
    const options = allowed.map((id): ItemBaseOption => {
      const a = assessMundane(ctx, id);
      return {
        id,
        name: mundaneName(catalog, id) ?? id,
        proficiency: a.proficiency.status,
        mastery: a.mastery.status,
      };
    });
    const proficient = options.filter((o) => o.proficiency === "yes").map((o) => o.id);
    bases = { allowed: options, proficient, any_proficient: proficient.length > 0 };
    base = requestedBase ?? (allowed.length === 1 ? (allowed[0] as string) : null);
    if (base === null) {
      const why = message("item.choose_base", {
        item: magic.name,
        kind: magic.base.kind,
        count: allowed.length,
        proficient: proficient.length,
      });
      issues.push({
        code: "choose_base",
        message: message("refusal.say_which_base", { item: magic.name, kind: magic.base.kind }),
      });
      assessed = {
        kind: baseKind(magic),
        proficiency: { status: "choose_base", reason: why, via: null, bonus: null },
        mastery: { status: "choose_base", property: null, name: null, reason: why },
        restrictions: [],
      };
    } else if (!allowed.includes(base)) {
      const why = message("refusal.item_cant_be", {
        item: magic.name,
        base: mundaneName(catalog, base) ?? base,
      });
      issues.push({ code: "invalid_base", message: why });
      assessed = {
        kind: baseKind(magic),
        proficiency: { status: "unknown", reason: why, via: null, bonus: null },
        mastery: { status: "unknown", property: null, name: null, reason: why },
        restrictions: [],
      };
    } else {
      named = base;
      assessed = assessMundane(ctx, base, magic);
    }
  } else {
    if (requestedBase)
      issues.push({
        code: "base_not_used",
        message: message("item.base_not_used", { item: magic.name, base: requestedBase }),
      });
    const name = magicItemName(catalog, magic, null, variant);
    const none = message("item.no_proficiency_needed", { item: name });
    assessed = {
      kind: "gear",
      proficiency: { status: "not_applicable", reason: none, via: null, bonus: null },
      mastery: {
        status: "not_applicable",
        property: null,
        name: null,
        reason: message("item.mastery_not_applicable", { item: name }),
      },
      restrictions: [],
    };
  }
  return {
    ...common,
    base,
    variant,
    found: true,
    name: magicItemName(catalog, magic, named, variant),
    kind: assessed.kind,
    magic: true,
    magic_category: magic.category,
    proficiency: assessed.proficiency,
    mastery: assessed.mastery,
    restrictions: [...assessed.restrictions, ...attunement(ctx, magic)],
    issues,
    bases,
    variants: magic.variants.map((v) => ({ id: v.id, name: v.name })),
    requires_attunement: magic.attunement,
  };
}

function baseKind(magic: MagicItemDef): ItemKind {
  const kind = magic.base?.kind;
  return kind === "weapon" || kind === "armor" || kind === "shield" ? kind : "gear";
}

interface Assessed {
  kind: ItemKind;
  proficiency: ItemProficiency;
  mastery: ItemMastery;
  restrictions: ItemRestriction[];
}

/** A mundane item (or a magic item's base, with the magic item's own changes). */
function assessMundane(ctx: Context, id: string, magic: MagicItemDef | null = null): Assessed {
  const { catalog } = ctx;
  const name = magic ? magicItemName(catalog, magic, id, null) : (mundaneName(catalog, id) ?? id);
  const weapon = lookup(catalog.weapons, id);
  if (weapon) return assessWeapon(ctx, weapon, name);
  const armor = lookup(catalog.armor, id);
  if (armor) return assessArmor(ctx, armor, name, magic);
  const tool = lookup(catalog.tools, id);
  if (tool) return assessTool(ctx, id, name);
  return {
    kind: "gear",
    proficiency: {
      status: "not_applicable",
      reason: message("item.no_proficiency_needed", { item: name }),
      via: null,
      bonus: null,
    },
    mastery: {
      status: "not_applicable",
      property: null,
      name: null,
      reason: message("item.mastery_not_applicable", { item: name }),
    },
    restrictions: [],
  };
}

function assessWeapon(ctx: Context, weapon: WeaponDef, name: string): Assessed {
  const { sheet, catalog } = ctx;
  const profs = sheet.weapon_proficiencies;
  const proficient = isWeaponProficient(weapon, profs);
  const via = proficient ? (profs.find((p) => isWeaponProficient(weapon, [p])) ?? null) : null;
  const pb = sheet.proficiency_bonus;
  const restrictions: ItemRestriction[] = [];
  if (!proficient) {
    restrictions.push({
      code: "weapon_not_proficient",
      effect: "no_proficiency_bonus",
      evaluation: "checked",
      message: message("item.restriction.weapon_not_proficient", { item: name }),
    });
  }
  // Heavy: as the sheet's attack line (Strength for a melee weapon, Dexterity for a ranged one).
  if (weapon.properties.includes("heavy")) {
    const ability = weapon.kind === "melee" ? "str" : "dex";
    const score = sheet.scores[ability];
    if (score < 13) {
      restrictions.push({
        code: "heavy_weapon",
        effect: "penalty",
        evaluation: "checked",
        message: message("item.restriction.heavy_weapon", {
          item: name,
          ability: message(`ability.${ability}`),
          score,
        }),
      });
    }
  }
  if (weapon.properties.includes("two-handed") && ctx.heldShield) {
    restrictions.push({
      code: "two_handed_with_shield",
      effect: "penalty",
      evaluation: "checked",
      message: message("item.restriction.two_handed_with_shield", {
        item: name,
        shield: ctx.heldShield,
      }),
    });
  }
  const masteryName = lookup(catalog.masteries, weapon.mastery)?.name ?? weapon.mastery;
  const mastered = sheet.weapon_masteries.includes(weapon.id);
  return {
    kind: "weapon",
    proficiency: {
      status: proficient ? "yes" : "no",
      reason: proficient
        ? message("item.proficient_weapon", { item: name, via: via ?? "", bonus: pb })
        : message("item.not_proficient_weapon", { item: name }),
      via,
      bonus: proficient ? pb : null,
    },
    mastery: {
      status: mastered ? "yes" : "no",
      property: weapon.mastery,
      name: masteryName,
      reason: mastered
        ? message("item.mastery_yes", { item: name, mastery: masteryName })
        : message("item.mastery_no", { item: name, mastery: masteryName }),
    },
    restrictions,
  };
}

function assessArmor(
  ctx: Context,
  armor: ArmorDef,
  name: string,
  magic: MagicItemDef | null,
): Assessed {
  const { sheet } = ctx;
  const shield = armor.category === "shield";
  const trained = sheet.armor_training.includes(armor.category);
  const restrictions: ItemRestriction[] = [];
  if (shield && !trained) {
    restrictions.push({
      code: "shield_untrained",
      effect: "penalty",
      evaluation: "checked",
      message: message("item.restriction.shield_untrained", { item: name }),
    });
  }
  if (!shield && !trained) {
    restrictions.push({
      code: "armor_untrained",
      effect: "penalty",
      evaluation: "checked",
      message: message("item.restriction.armor_untrained", { item: name }),
    });
  }
  // Mithral: no Strength requirement or Stealth Disadvantage (as the worn armor on the sheet).
  const penalties = !magic?.ignores_armor_penalties;
  if (penalties && armor.strength && sheet.scores.str < armor.strength) {
    restrictions.push({
      code: "armor_strength",
      effect: "penalty",
      evaluation: "checked",
      message: message("item.restriction.armor_strength", {
        item: name,
        strength: armor.strength,
        score: sheet.scores.str,
      }),
    });
  }
  if (penalties && armor.stealth_disadvantage) {
    restrictions.push({
      code: "armor_stealth",
      effect: "penalty",
      evaluation: "checked",
      message: message("item.restriction.armor_stealth", { item: name }),
    });
  }
  const reason = shield
    ? message(trained ? "item.trained_shield" : "item.untrained_shield", { item: name })
    : message(trained ? "item.trained_armor" : "item.untrained_armor", {
        item: name,
        category: armor.category,
      });
  return {
    kind: shield ? "shield" : "armor",
    proficiency: {
      status: trained ? "yes" : "no",
      reason,
      via: trained ? armor.category : null,
      bonus: null,
    },
    mastery: {
      status: "not_applicable",
      property: null,
      name: null,
      reason: message("item.mastery_not_applicable", { item: name }),
    },
    restrictions,
  };
}

function assessTool(ctx: Context, id: string, name: string): Assessed {
  const { sheet } = ctx;
  const source = sheet.tools[id] ?? null;
  const pb = sheet.proficiency_bonus;
  const restrictions: ItemRestriction[] = [];
  if (source === null) {
    restrictions.push({
      code: "tool_not_proficient",
      effect: "no_proficiency_bonus",
      evaluation: "checked",
      message: message("item.restriction.tool_not_proficient", { item: name }),
    });
  }
  // The ability and DC depend on what you do with it; the content doesn't list the activities.
  restrictions.push({
    code: "tool_activity",
    effect: "note",
    evaluation: "manual",
    message: message("item.restriction.tool_activity", { item: name }),
  });
  return {
    kind: "tool",
    proficiency: {
      status: source !== null ? "yes" : "no",
      reason:
        source !== null
          ? message("item.proficient_tool", { item: name, via: source, bonus: pb })
          : message("item.not_proficient_tool", { item: name }),
      via: source,
      bonus: source !== null ? pb : null,
    },
    mastery: {
      status: "not_applicable",
      property: null,
      name: null,
      reason: message("item.mastery_not_applicable", { item: name }),
    },
    restrictions,
  };
}

/** Attunement as the `attune` action judges it, plus what only the text says. */
function attunement(ctx: Context, magic: MagicItemDef): ItemRestriction[] {
  if (!magic.attunement) return [];
  const out: ItemRestriction[] = [
    {
      code: "attunement_required",
      effect: "requirement",
      evaluation: "checked",
      message: message("item.restriction.attunement_required", { item: magic.name }),
    },
  ];
  const blocker = attunementBlocker(ctx.res, magic);
  if (blocker) {
    out.push({
      code: "attunement_not_allowed",
      effect: "requirement",
      evaluation: "checked",
      message: message("item.restriction.attunement_not_allowed", {
        item: magic.name,
        reason: blocker,
      }),
    });
  } else if (
    magic.attunement_by &&
    !magic.attunement_classes.length &&
    !magic.attunement_spellcaster
  ) {
    out.push({
      code: "attunement_manual",
      effect: "requirement",
      evaluation: "manual",
      message: message("item.restriction.attunement_manual", {
        item: magic.name,
        by: magic.attunement_by,
      }),
    });
  }
  if (ctx.attuned >= MAX_ATTUNED) {
    out.push({
      code: "attunement_limit",
      effect: "requirement",
      evaluation: "checked",
      message: message("item.restriction.attunement_limit", {
        count: ctx.attuned,
        max: MAX_ATTUNED,
      }),
    });
  }
  return out;
}
