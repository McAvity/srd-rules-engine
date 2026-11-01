/**
 * kenli F-002 T12 B2a: cast-time options paid with a cast (Metamagic), checked the same way by a
 * roll by hand and an encounter cast. Each option's effect is explicit pack data
 * (`CastOption.effect`), never read from its name:
 *
 *   - `distant` — "a range of at least 5 feet … double the spell's range"; Touch → 30 feet; any
 *     other range (Self) can't take it. The range is the one the character casts it with.
 *   - `quickened` — an Action spell cast as a Bonus Action (the turn rules are the encounter's).
 *   - `subtle` — no Verbal, Somatic or Material components "except Material components that are
 *     consumed by the spell" (or that have a cost, which the spell's material text states).
 *   - `heightened` — one target of a spell that forces a save has Disadvantage on saves against it.
 *   - `careful` — up to the Charisma modifier (minimum 1) of the creatures making the spell's save
 *     succeed automatically, no damage where a success halves it.
 *
 * One option per spell unless an option is `combinable` (Empowered Spell) or the sheet's
 * `cast_option_limit` is higher (Sorcery Incarnate while Innate Sorcery is active).
 */

import type { SpellDef } from "../models/content";
import type { Message } from "../models/messages";
import type { PlayAction } from "../models/state";
import type { SaveOverride } from "./casting";
import { message, RuleError } from "./messages";
import type { CastOptionLine } from "./sheet";

/** What a sheet gives the check: its cast options, how many one spell takes, its CHA modifier. */
export interface CastOptionSheet {
  readonly cast_options: readonly CastOptionLine[];
  readonly cast_option_limit: number;
  readonly modifiers: { readonly cha: number };
}

export interface CastOptionPlan {
  readonly picked: readonly CastOptionLine[];
  /** One `use` of each option's cost (Sorcery Points), paid once with the cast. */
  readonly costs: readonly PlayAction[];
  /** Distant Spell: the range for this cast (`60 feet` → `120 feet`; Touch → `30 feet`). */
  readonly range: string | null;
  readonly quickened: boolean;
  /** Subtle Spell: the Material component it still needs (consumed or costly), or `null`. */
  readonly subtle: { readonly still: string | null } | null;
  readonly heightened: boolean;
  readonly careful: boolean;
  readonly messages: readonly Message[];
}

const fail = (m: Message): never => {
  throw new RuleError(m);
};

/** The spell's Material component when it's consumed or has a cost (Subtle Spell keeps it). */
export function costlyMaterial(spell: SpellDef): string | null {
  const m = /\bM \(([^)]*)\)/.exec(spell.components)?.[1] ?? null;
  return m && /consume|\bworth\b|\d[\d,]*\+?\s*GP/i.test(m) ? m : null;
}

/** Check the picked options (sheet keys) against the spell, as the character casts it. */
export function planCastOptions(
  sheet: CastOptionSheet,
  spell: SpellDef,
  keys: readonly string[],
): CastOptionPlan {
  const picked = keys.map(
    (k) =>
      sheet.cast_options.find((o) => o.key === k) ??
      fail(message("refusal.no_cast_option", { key: k })),
  );
  if (new Set(keys).size !== keys.length)
    fail(message("refusal.cast_options_one", { options: picked.map((o) => o.name).join(", ") }));
  const single = picked.filter((o) => !o.combinable);
  if (single.length > sheet.cast_option_limit)
    fail(
      sheet.cast_option_limit === 1
        ? message("refusal.cast_options_one", { options: single.map((o) => o.name).join(", ") })
        : message("refusal.cast_options_limit", {
            options: single.map((o) => o.name).join(", "),
            count: sheet.cast_option_limit,
          }),
    );
  const messages: Message[] = [];
  let range: string | null = null;
  let quickened = false;
  let subtle: CastOptionPlan["subtle"] = null;
  let heightened = false;
  let careful = false;
  const saves = !!(spell.mechanics?.save || spell.mechanics?.follow_up || spell.mechanics?.zone);
  for (const o of picked) {
    if (o.effect === "distant") {
      const feet = /^(\d+) feet/.exec(spell.range)?.[1];
      range = spell.range === "Touch" ? "30 feet" : feet ? `${Number(feet) * 2} feet` : null;
      if (!range || (feet && Number(feet) < 5))
        fail(message("refusal.distant_needs_range", { spell: spell.name }));
      messages.push(message("cast.distant", { range: range as string }));
    } else if (o.effect === "quickened") {
      if (spell.casting_time !== "Action")
        fail(message("refusal.quickened_needs_action", { spell: spell.name }));
      quickened = true;
      messages.push(message("cast.quickened"));
    } else if (o.effect === "subtle") {
      const still = costlyMaterial(spell);
      subtle = { still };
      messages.push(
        message("cast.subtle", {
          spell: spell.name,
          still: still ? message("cast.subtle_still", { material: still }) : "",
        }),
      );
    } else if (o.effect === "heightened" || o.effect === "careful") {
      if (!saves)
        fail(message("refusal.metamagic_needs_save", { option: o.name, spell: spell.name }));
      if (o.effect === "heightened") heightened = true;
      else careful = true;
    }
  }
  const costs: PlayAction[] = picked.map((o) => ({ type: "use", key: o.uses, amount: o.cost }));
  return { picked, costs, range, quickened, subtle, heightened, careful, messages };
}

/**
 * Heightened and Careful on the spell's targets (indexes into them; `self` the caster's, if it
 * is one): exactly one Heightened target; up to CHA modifier (min 1) Careful ones, not the caster.
 */
export function castOptionSaves(
  plan: CastOptionPlan,
  sheet: CastOptionSheet,
  spell: SpellDef,
  targets: readonly { readonly name: string }[],
  choice: { readonly heightened?: number | null; readonly careful?: readonly number[] },
  self: number | null,
): { overrides: SaveOverride[]; messages: Message[] } {
  const overrides: SaveOverride[] = [];
  const messages: Message[] = [];
  const option = (effect: CastOptionLine["effect"]) =>
    plan.picked.find((o) => o.effect === effect)?.name ?? "";
  if (!plan.heightened && choice.heightened !== undefined && choice.heightened !== null)
    fail(message("refusal.heightened_one_target", { option: "Heightened Spell" }));
  if (!plan.careful && choice.careful?.length)
    fail(message("refusal.careful_targets", { option: "Careful Spell", max: 0 }));
  if (plan.heightened) {
    const i = choice.heightened;
    if (i === undefined || i === null || i < 0 || i >= targets.length)
      fail(message("refusal.heightened_one_target", { option: option("heightened") }));
    const t = targets[i as number] as { name: string };
    overrides.push({ target: i as number, disadvantage: message("reason.heightened") });
    messages.push(message("cast.heightened", { target: t.name, spell: spell.name }));
  }
  if (plan.careful) {
    const max = Math.max(1, sheet.modifiers.cha);
    const picked = [...new Set(choice.careful ?? [])];
    if (
      !picked.length ||
      picked.length !== (choice.careful ?? []).length ||
      picked.length > max ||
      picked.some((i) => i < 0 || i >= targets.length || i === self)
    )
      fail(message("refusal.careful_targets", { option: option("careful"), max }));
    for (const i of picked) {
      const at = overrides.find((x) => x.target === i);
      const succeed = message("save.careful");
      if (at) overrides[overrides.indexOf(at)] = { ...at, succeed };
      else overrides.push({ target: i, succeed });
    }
    messages.push(
      message("cast.careful", {
        targets: picked.map((i) => (targets[i] as { name: string }).name).join(", "),
        spell: spell.name,
      }),
    );
  }
  return { overrides, messages };
}
