/**
 * Rolling by hand: the actor's dice for an attack, a Grapple or Shove, a spell, a feature, a
 * saving throw effect or a legendary action, and what it costs, as data. No target, no turn, no
 * action economy, nothing applied: a pure function over plain inputs (a `Combatant`, and the
 * monster's stat block or the character's build and state when the roll needs them), for any
 * client. The encounter's `roll` action and `/v1/state/roll` spend the costs.
 */

import { type Catalog, lookup } from "../content/catalog";
import type { CharacterBuild } from "../models/build";
import type { RollResult } from "../models/combat";
import type { Ability, MonsterDef, SpellDef } from "../models/content";
import type { DmOptions, RollCost, RollWhat } from "../models/encounter";
import type { Message } from "../models/messages";
import type { OptionReason } from "../models/options";
import type { CharacterState, PlayAction } from "../models/state";
import { castSpell } from "../rules/casting";
import {
  type AttackDice,
  type AttackOptions,
  type Combatant,
  type MonsterSpellLine,
  monsterSpells,
  rollAttack,
  type SaveActionLine,
} from "../rules/combatant";
import { type RolledDamage, rollDamage } from "../rules/damage";
import { roll as rollDiceExpression } from "../rules/dice";
import { message, plainMessage, RuleError } from "../rules/messages";
import { mathRng, type Rng } from "../rules/rng";
import type { SpellLine } from "../rules/sheet";
import { applyAction, computePlaySheet, PlayError, type PlaySheet } from "./play";
import { optionReason } from "./refusals";

/** The dice rolled by hand (`DeclaredResult.rolls`, `ByHandRoll.rolls`). */
export interface DeclaredRolls {
  /** One per attack roll (an attack, each beam or ray of a spell), with its damage. */
  readonly attacks: readonly AttackDice[];
  /** Damage rolled once (a saving throw effect or spell, darts, a smite). */
  readonly damage: RolledDamage | null;
  readonly healing: number | null;
  /**
   * The saving throw it forces: the ability (`null`: the target's choice, Strength or Dexterity
   * for a Grapple or Shove) and the actor's DC. No save is rolled (`check` with `save` rolls one).
   */
  readonly save: { readonly ability: Ability | null; readonly dc: number } | null;
  /** A feature's own die the user rolls (a pack's feature rolling a Bardic Die), when it has one. */
  readonly die?: RollResult | null;
}

export type { RollCost } from "../models/encounter";

/** A roll's cost, and whether it can be paid now (`reason` when it can't). */
export type CheckedCost = RollCost & {
  readonly payable: boolean;
  readonly reason: OptionReason | null;
};

export interface ByHandRoll {
  readonly action: RollWhat["type"];
  /** The attack, spell, feature, saving throw effect or legendary action. */
  readonly name: string;
  /** A spell's slot level (`null` for a cantrip or anything else). */
  readonly slot_level: number | null;
  readonly rolls: DeclaredRolls;
  readonly costs: readonly RollCost[];
  /** Notes on the roll (a spell whose effects are text, a legendary action that's text). */
  readonly messages: readonly Message[];
}

export interface ByHandOptions {
  readonly catalog: Catalog;
  /** The monster's stat block: its spell lines, daily uses and spells cast by legendary actions. */
  readonly monster?: MonsterDef;
  /** The character's build and state: its features, known spells, Cunning and Brutal Strike. */
  readonly character?: { readonly build: CharacterBuild; readonly state: CharacterState };
  readonly rng?: Rng;
}

const fail = (m: Message): never => {
  throw new RuleError(m);
};

const NO_ROLLS: DeclaredRolls = { attacks: [], damage: null, healing: null, save: null };

/** The GM's additions to an attack rolled by hand, as `rollAttack`'s options (`DmOptions`). */
function attackDm(dm: DmOptions | undefined) {
  if (!dm) return {};
  return {
    ...(dm.modes?.length
      ? {
          modes: dm.modes.map((m) => ({
            mode: m.mode,
            reason: m.label,
            message: plainMessage(m.label),
          })),
        }
      : {}),
    ...(dm.mode_override ? { mode_override: dm.mode_override } : {}),
    ...(dm.modifiers?.length ? { modifiers: dm.modifiers } : {}),
    ...(dm.bonus_dice?.length ? { bonus_dice: dm.bonus_dice } : {}),
    ...(dm.damage_modifiers?.length ? { damage_modifiers: dm.damage_modifiers } : {}),
  };
}

/**
 * Roll `what` for `combatant` by hand (see the module). Throws a `RuleError` for what can't be
 * rolled (an unknown attack, a feature without the character's sheet); never checks whether a
 * cost can be paid: that's the caller's (`costs`).
 */
/**
 * The spellcasting feature a character's spell is cast with when the caller names none: the one its feature gives
 * (`SpellLine.spellcasting`) when there's exactly one; otherwise `castSpell` picks (the best on whose list it is).
 */
export function spellcastingOf(
  line: Pick<SpellLine, "spellcasting"> | undefined,
): string | undefined {
  return line?.spellcasting.length === 1 ? line.spellcasting[0] : undefined;
}

export function rollByHand(
  combatant: Combatant,
  what: RollWhat,
  options: ByHandOptions,
): ByHandRoll {
  return rollWith(combatant, what, options);
}

/** `rollByHand`, with an encounter's extra checks on Cunning and Brutal Strike (`turn`). */
export function rollWith(
  combatant: Combatant,
  what: RollWhat,
  options: ByHandOptions,
  { turn }: { turn?: boolean } = {},
): ByHandRoll {
  const { catalog, monster, character } = options;
  const rng = options.rng ?? mathRng;
  const name = combatant.name;
  let sheet: PlaySheet | null = null;
  const sheetOf = (): PlaySheet | null => {
    if (!character) return null;
    sheet ??= computePlaySheet(character.build, character.state, catalog);
    return sheet;
  };
  const roll = (
    rolled: Partial<DeclaredRolls>,
    rest: Partial<Omit<ByHandRoll, "rolls" | "action">> & { name: string },
  ): ByHandRoll => ({
    action: what.type,
    slot_level: null,
    costs: [],
    messages: [],
    ...rest,
    rolls: { ...NO_ROLLS, ...rolled },
  });
  /** A monster's daily uses of an action, by its name. */
  const daily = (key: string, perDay: number | null | undefined, used: string): RollCost[] =>
    perDay == null ? [] : [{ type: "daily", key, per_day: perDay, name: used }];
  const dailyOf = (action: string): RollCost[] => {
    if (!monster) return [];
    const all = [...monster.actions, ...monster.bonus_actions, ...monster.reactions];
    return daily(action, all.find((a) => a.name === action)?.per_day, action);
  };
  const attackDice = (attack: string, extra: AttackOptions = {}): AttackDice =>
    rollAttack(combatant, attack, { rng, ...extra });
  const saveRoll = (line: SaveActionLine, as: string): ByHandRoll =>
    roll(
      {
        save: { ability: line.ability, dc: line.dc },
        damage: line.damage_parts.length ? rollDamage(line.damage_parts, { rng }) : null,
      },
      { name: as },
    );
  /** A spell's dice (`castSpell` by hand); a monster's slots aren't counted, its Concentration is. */
  const spellRoll = (
    spell: SpellDef,
    as: string,
    cast: {
      slot_level?: number;
      pact?: boolean;
      spellcasting?: string;
      mode?: "normal" | "advantage" | "disadvantage";
      damage_type?: NonNullable<Extract<RollWhat, { type: "cast" }>["damage_type"]>;
      dm?: DmOptions;
    },
    costs: readonly RollCost[] = [],
    /** Without a slot: a free cast's use spent instead, or a ritual (nothing instead). */
    instead?: { use: string; message: Message } | { ritual: Message },
  ): ByHandRoll => {
    const { dm, ...rest } = cast;
    const r = castSpell(combatant, spell, [], {
      ...rest,
      rng,
      by_hand: true,
      ...(dm ? { dm } : {}),
      ...(dm?.damage_bonus_dice?.length ? { extra_damage: dm.damage_bonus_dice } : {}),
      ...(dm?.damage_modifiers?.length ? { damage_modifiers: dm.damage_modifiers } : {}),
    });
    const noSlot = (a: PlayAction) =>
      !instead || (a.type !== "spend_slot" && a.type !== "spend_pact_slot");
    const paid = r.caster_actions
      .filter((a) => (!monster || character || a.type === "set_concentration") && noSlot(a))
      .map((a): RollCost => ({ type: "play", action: a }));
    const use: RollCost[] =
      instead && "use" in instead
        ? [{ type: "play", action: { type: "use", key: instead.use } }]
        : [];
    const note = instead ? ["use" in instead ? instead.message : instead.ritual] : [];
    return roll(r.by_hand ?? {}, {
      name: as,
      slot_level: r.slot_level,
      costs: [...costs, ...use, ...paid],
      messages: [...r.messages, ...note],
    });
  };
  const spellOf = (id: string): SpellDef =>
    lookup(catalog.spells, id) ?? fail(message("refusal.unknown_spell", { spell: id }));

  switch (what.type) {
    case "attack": {
      const s = sheetOf();
      const strikes = strikeDice(
        combatant,
        what.attack,
        what,
        s && character ? { sheet: s, state: character.state } : null,
        { turn },
      );
      const dm = attackDm(what.dm);
      const dice = attackDice(what.attack, {
        mode: what.mode,
        two_handed: what.two_handed,
        riders: what.riders,
        light_extra: what.light_extra,
        cleave: what.cleave,
        ...strikes,
        ...dm,
        extra_damage: [
          ...strikes.extra_damage,
          ...(what.dm?.damage_bonus_dice ?? []).map((d) => ({
            dice: d.dice,
            type: d.type,
            label: d.label,
          })),
        ],
      });
      return roll({ attacks: [dice] }, { name: what.attack, costs: dailyOf(what.attack) });
    }
    case "unarmed": {
      // "the DC equals 8 plus your Strength modifier and Proficiency Bonus"; the target picks
      // Strength or Dexterity.
      const dc = 8 + combatant.modifiers.str + combatant.proficiency_bonus;
      // What the save decides is the table's: the text says what it is (SRD "Unarmed Strike").
      return roll(
        { save: { ability: what.save ?? null, dc } },
        { name: what.option, messages: [message(`unarmed.${what.option}`, { dc })] },
      );
    }
    case "cast": {
      const spell = spellOf(what.spell);
      const s = sheetOf();
      const known = s?.spells.find((x) => x.id === spell.id);
      if (s && !known) {
        fail(message("refusal.cant_cast", { name, spell: spell.name }));
      }
      if (monster && !character) {
        if (what.payment && what.payment.type !== "slot") {
          fail(message("refusal.payment_not_accepted", { feature: spell.name }));
        }
        const line = monsterCastLine(monster, name, spell, what.via);
        if (what.spellcasting !== undefined && what.spellcasting !== line.action) {
          fail(message("rule.no_spellcasting", { name, source: what.spellcasting }));
        }
        const fixed = spell.level === 0 ? undefined : (line.level ?? spell.level);
        if (what.slot_level !== undefined && what.slot_level !== fixed) {
          fail(message("refusal.fixed_level", { name, spell: spell.name, level: fixed ?? 0 }));
        }
        const costs = [
          ...daily(line.action, line.action_per_day, line.action),
          ...daily(`${line.action}#${line.spell}`, line.per_day, spell.name),
          ...(line.recharge ? [{ type: "recharge" as const, name: line.action }] : []),
        ];
        const cast = { slot_level: fixed, spellcasting: line.action, mode: what.mode, dm: what.dm };
        return spellRoll(spell, spell.name, { ...cast, damage_type: what.damage_type }, costs);
      }
      const payment = what.payment ?? { type: "slot" as const };
      const common = { mode: what.mode, damage_type: what.damage_type, dm: what.dm };
      if (payment.type === "free") {
        // A free cast: at the spell's level, with the spellcasting feature that gives it.
        const entry =
          known?.free.find((f) => f.use === payment.use) ??
          fail(message("refusal.free_cast_not_for_spell", { use: payment.use, spell: spell.name }));
        if ((what.slot_level !== undefined && what.slot_level !== spell.level) || what.pact) {
          fail(
            message("refusal.free_cast_base_level", {
              spell: spell.name,
              use: entry.name,
              level: spell.level,
            }),
          );
        }
        if (what.spellcasting !== undefined && what.spellcasting !== entry.spellcasting) {
          fail(
            message("refusal.free_cast_source", {
              spell: spell.name,
              use: entry.name,
              spellcasting: entry.spellcasting ?? "",
            }),
          );
        }
        const free = message("cast.free", { spell: spell.name, use: entry.name });
        return spellRoll(
          spell,
          spell.name,
          { ...common, slot_level: spell.level, spellcasting: entry.spellcasting ?? undefined },
          [],
          { use: entry.use, message: free },
        );
      }
      if (payment.type === "ritual") {
        // SRD "Rituals": a prepared spell with the Ritual tag, no slot, 10 minutes longer.
        if (!spell.ritual || spell.level === 0)
          fail(message("refusal.not_ritual", { spell: spell.name }));
        if (what.slot_level !== undefined || what.pact) {
          fail(message("refusal.ritual_no_slot", { spell: spell.name }));
        }
        return spellRoll(
          spell,
          spell.name,
          {
            ...common,
            slot_level: spell.level,
            spellcasting: what.spellcasting ?? spellcastingOf(known),
          },
          [],
          { ritual: message("cast.ritual", { spell: spell.name }) },
        );
      }
      return spellRoll(spell, spell.name, {
        ...common,
        slot_level: what.slot_level,
        pact: what.pact,
        spellcasting: what.spellcasting ?? spellcastingOf(known),
      });
    }
    case "feature": {
      const s = sheetOf() ?? fail(message("refusal.no_class_features", { name }));
      const f =
        s.actions.find((a) => a.key === what.feature || a.name === what.feature) ??
        fail(message("refusal.no_feature", { name, feature: what.feature }));
      if (f.halves_attack_damage || f.reduces_attack_damage) {
        fail(message("refusal.offered_when_attack_hits", { feature: f.name, name }));
      }
      const types = f.save?.damage?.types ?? [];
      const damageType =
        f.save?.damage &&
        (what.damage_type ??
          (types.length === 1
            ? types[0]
            : fail(message("refusal.choose_damage_type", { feature: f.name, types }))));
      if (damageType && !types.includes(damageType)) {
        fail(message("refusal.damage_types", { feature: f.name, types }));
      }
      // Its healing (a pool's amount as given) and a save's damage rolled, the save's DC shown.
      const healing = !f.heal
        ? null
        : f.heal.pooled
          ? (what.amount ?? null)
          : rollDamage([{ dice: f.heal.dice, bonus: f.heal.bonus, type: "healing" }], { rng })
              .total;
      const damage =
        f.save?.damage && damageType
          ? rollDamage(
              [{ dice: f.save.damage.dice, bonus: f.save.damage.bonus, type: damageType }],
              { rng },
            )
          : null;
      const save = f.save ? { ability: f.save.ability, dc: f.save.dc } : null;
      const use: PlayAction = {
        type: "use_feature",
        key: f.key,
        ...(what.amount !== undefined ? { amount: what.amount } : {}),
        manual: true,
        ...(what.payment ? { payment: what.payment } : {}),
      };
      // Its own die, rolled last; what it does is the table's.
      const die = f.roll_die ? rollDiceExpression(f.roll_die, rng) : undefined;
      return roll(
        { healing, damage, save, ...(f.roll_die !== undefined ? { die: die ?? null } : {}) },
        {
          name: f.name,
          costs: [{ type: "play", action: use }],
          messages:
            f.roll_die !== undefined ? [message("feature.manual_effect", { feature: f.name })] : [],
        },
      );
    }
    case "save_action": {
      const line =
        combatant.save_actions.find((a) => a.name === what.ability) ??
        fail(
          message("rule.no_saving_throw_action", {
            name,
            action: what.ability,
            known: combatant.save_actions.map((a) => a.name).join(", "),
          }),
        );
      const recharge: RollCost[] = line.recharge ? [{ type: "recharge", name: what.ability }] : [];
      return { ...saveRoll(line, line.name), costs: [...dailyOf(what.ability), ...recharge] };
    }
    case "legendary": {
      const line =
        combatant.legendary_actions.find((a) => a.name === what.action) ??
        fail(
          message("refusal.no_legendary_action", {
            name,
            action: what.action,
            known: combatant.legendary_actions.map((a) => a.name),
          }),
        );
      const attackable = (attack: string) => combatant.attacks.some((a) => a.name === attack);
      const attackWith = (attack: string) =>
        roll({ attacks: [attackDice(attack, { mode: what.mode })] }, { name: line.name });
      if (line.attacks.length) {
        const attack =
          what.attack ??
          (line.attacks.length === 1
            ? (line.attacks[0] as string)
            : fail(message("refusal.choose_attack", { action: line.name, attacks: line.attacks })));
        if (!line.attacks.includes(attack)) {
          fail(
            message("refusal.one_attack_of", { action: line.name, attacks: line.attacks, attack }),
          );
        }
        if (!attackable(attack)) fail(message("refusal.no_attack_roll_resolve", { attack }));
        return attackWith(attack);
      }
      if (line.uses && attackable(line.uses)) return attackWith(line.uses);
      const used = line.uses ? combatant.save_actions.find((a) => a.name === line.uses) : undefined;
      if (used) return saveRoll(used, line.name);
      // "uses Spellcasting to cast Fear": the spell, at its listed level, through this action.
      const cast = monster
        ? monsterSpells(monster).find(
            (x) => x.section === "legendary_actions" && x.action === line.name,
          )
        : undefined;
      if (cast) {
        const spell = spellOf(cast.spell);
        const slot_level = spell.level === 0 ? undefined : (cast.level ?? spell.level);
        return spellRoll(spell, line.name, {
          slot_level,
          mode: what.mode,
          spellcasting: line.name,
        });
      }
      if (line.save) return saveRoll(line.save, line.name);
      return roll(
        {},
        {
          name: line.name,
          messages: [message("legendary.text_only", { action: line.name })],
        },
      );
    }
  }
}

/**
 * The action of a monster's stat block that casts `spell` (`via` when several do; legendary
 * actions cast through `legendary`). Throws a `RuleError` when none or several do, or for a spell
 * that takes longer than an action (a monster casts with the Magic action).
 */
export function monsterCastLine(
  monster: MonsterDef,
  name: string,
  spell: SpellDef,
  via: string | undefined,
): MonsterSpellLine {
  const lines = monsterSpells(monster).filter(
    (x) =>
      x.spell === spell.id &&
      x.section !== "legendary_actions" &&
      (via === undefined || x.action === via),
  );
  if (!lines.length) {
    fail(
      message("refusal.cant_cast_via", {
        name,
        spell: spell.name,
        via: via ?? "",
        given: via !== undefined,
      }),
    );
  }
  if (lines.length > 1) {
    fail(
      message("refusal.give_via", { name, spell: spell.name, actions: lines.map((x) => x.action) }),
    );
  }
  if (!/^(Action|Bonus Action|Reaction)\b/.test(spell.casting_time)) {
    fail(
      message("refusal.takes_monster_casts_magic", {
        spell: spell.name,
        casting_time: spell.casting_time,
      }),
    );
  }
  return lines[0] as MonsterSpellLine;
}

/** The dice Cunning Strike and Brutal Strike change on an attack (`AttackOptions`). */
export interface StrikeDice {
  forgo: { rider: string; dice: number }[];
  extra_damage: { dice: string; type: string }[];
  forgo_advantage: boolean;
}

/**
 * Check a character's Cunning Strike and Brutal Strike effects on an attack and work out what
 * they change (SRD Rogue "Cunning Strike", Barbarian "Brutal Strike"); throws a `RuleError` when
 * they can't be used. `turn: false` (an encounter's attack off its own turn) refuses Brutal Strike;
 * by hand the turn isn't checked.
 */
export function strikeDice(
  attacker: Combatant,
  attackName: string,
  options: {
    readonly riders?: readonly { rider: string }[];
    readonly cunning?: readonly string[];
    readonly brutal?: readonly string[];
  },
  character: { readonly sheet: PlaySheet; readonly state: CharacterState } | null,
  { turn }: { turn?: boolean } = {},
): StrikeDice {
  const cunning = options.cunning ?? [];
  const brutal = options.brutal ?? [];
  const out: StrikeDice = { forgo: [], extra_damage: [], forgo_advantage: false };
  if (!cunning.length && !brutal.length) return out;
  const name = attacker.name;
  if (!character) return fail(message("refusal.no_class_features", { name }));
  const { sheet, state } = character;
  const levelIn = (id: string) => sheet.classes.find((x) => x.class_id === id)?.level ?? 0;
  if (new Set(cunning).size < cunning.length || new Set(brutal).size < brutal.length) {
    fail(message("refusal.each_effect_used_once"));
  }
  if (cunning.length) {
    if (!sheet.rules.includes("cunning_strike"))
      fail(message("refusal.doesnt_cunning_strike", { name }));
    const most = sheet.rules.includes("improved_cunning_strike") ? 2 : 1;
    if (cunning.length > most) fail(message("refusal.cunning_strike_count", { name, most }));
    if (
      !(options.riders ?? []).some((r) => r.rider === "sneak-attack" || r.rider === "Sneak Attack")
    ) {
      fail(message("refusal.cunning_strike_used_when"));
    }
    if (cunning.includes("poison") && !state.inventory.some((i) => i.item === "poisoners-kit")) {
      fail(message("refusal.cunning_strike_poison_needs", { name }));
    }
    out.forgo.push({ rider: "sneak-attack", dice: cunning.length });
  }
  if (brutal.length) {
    if (!sheet.rules.includes("brutal_strike"))
      fail(message("refusal.doesnt_brutal_strike", { name }));
    const reckless = sheet.toggles.some((x) => x.active && x.key.endsWith(":reckless-attack"));
    if (!reckless) fail(message("refusal.brutal_strike_needs_reckless"));
    if (turn === false) fail(message("refusal.brutal_strike_used_your"));
    const line = attacker.attacks.find((a) => a.name === attackName);
    if (line?.ability !== "str") fail(message("refusal.brutal_strike_strength_based"));
    const improved = sheet.rules.includes("improved_brutal_strike");
    if (!improved && brutal.some((x) => x === "staggering" || x === "sundering")) {
      fail(message("refusal.staggering_blow_sundering_blow"));
    }
    const most = levelIn("barbarian") >= 17 ? 2 : 1;
    if (brutal.length > most) fail(message("refusal.brutal_strike_count", { name, most }));
    out.forgo_advantage = true;
    out.extra_damage.push({ dice: levelIn("barbarian") >= 17 ? "2d10" : "1d10", type: "weapon" });
  }
  return out;
}

/**
 * Whether each cost can be paid now, paid in order (a slot and the Concentration it starts): a
 * character's play actions are tried on its state (`character`), a monster's daily uses and
 * Recharge against its counters. Nothing is spent.
 */
export function checkCosts(
  costs: readonly RollCost[],
  {
    catalog,
    name,
    character,
    daily_used = {},
    expended = [],
  }: {
    readonly catalog: Catalog;
    /** Who pays (for the reasons' messages). */
    readonly name: string;
    readonly character?: { readonly build: CharacterBuild; readonly state: CharacterState };
    readonly daily_used?: Readonly<Record<string, number>>;
    readonly expended?: readonly string[];
  },
): CheckedCost[] {
  let state = character?.state;
  const used = { ...daily_used };
  const spent = new Set(expended);
  const paid = (cost: RollCost): CheckedCost => ({ ...cost, payable: true, reason: null });
  const unpaid = (cost: RollCost, m: Message): CheckedCost => ({
    ...cost,
    payable: false,
    reason: optionReason(m),
  });
  return costs.map((cost) => {
    if (cost.type === "play") {
      if (!character || !state) return paid(cost); // a monster's Concentration
      try {
        state = applyAction(character.build, state, catalog, cost.action).state;
        return paid(cost);
      } catch (error) {
        if (!(error instanceof PlayError)) throw error;
        const reason = error.details[0] ?? message("refusal.no_uses", { feature: name });
        return unpaid(cost, message("refusal.character", { name, reason }));
      }
    }
    if (cost.type === "daily") {
      const n = used[cost.key] ?? 0;
      if (n >= cost.per_day) {
        return unpaid(
          cost,
          message("refusal.used_today", { name, what: cost.name, count: cost.per_day }),
        );
      }
      used[cost.key] = n + 1;
      return paid(cost);
    }
    if (spent.has(cost.name)) {
      return unpaid(cost, message("refusal.hasnt_recharged_2", { name, action: cost.name }));
    }
    spent.add(cost.name);
    return paid(cost);
  });
}
