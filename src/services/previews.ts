/**
 * Previews for a map UI, before anything is sent: the squares a combatant can move to, what a
 * move would do on the way (zones, Opportunity Attacks), and what an area would cover. They use
 * the encounter's own planning (`planMove`, `placeArea`), so they match what the move or the
 * cast would do; legality comes from `checkAction`.
 */

import { lookup } from "../content/catalog";
import type { SpellArea } from "../models/content";
import type { Encounter, EncounterCombatant, Zone } from "../models/encounter";
import type { Message } from "../models/messages";
import type { AreaPreview, MovePreview, Reachable } from "../models/previews";
import { type AreaPlacement, type GridPoint, inArea } from "../rules/areas";
import { monsterSpells } from "../rules/combatant";
import { reachable } from "../rules/grid";
import { message, texts } from "../rules/messages";
import {
  alliesOf,
  catalogOf,
  type EncounterContext,
  EncounterError,
  encounterCombatant,
  explorationBudget,
  feetApart,
  meleeReach,
  monsterDef,
  outOfFight,
  placeArea,
  planMove,
  spaceOf,
  spaceTakenBy,
  speedOf,
  spellRangeFeet,
  terrainOf,
  turnsFor,
  zoneArea,
} from "./encounter";
import { checkAction } from "./options";
import { refusalCode } from "./refusals";

function combatantIn(e: Encounter, id: string): EncounterCombatant {
  return (
    e.combatants.find((x) => x.id === id) ??
    (() => {
      throw new EncounterError([message("refusal.no_combatant_encounter", { id })]);
    })()
  );
}

const movementLeft = (e: Encounter, ctx: EncounterContext, c: EncounterCombatant) =>
  Math.max(0, speedOf(ctx, c, e) + c.extra_movement - c.moved);

/**
 * The squares combatant `id` can end a move on now, with the movement left (none without a
 * position): walls, blocked squares, Difficult Terrain and other creatures as `move` sees them.
 */
export function reachableSquares(
  encounter: Encounter,
  id: string,
  ctx: EncounterContext,
): Reachable {
  const c = combatantIn(encounter, id);
  const movement = movementLeft(encounter, ctx, c);
  if (!c.position || c.defeated) return { id, movement, squares: [] };
  const found = reachable(terrainOf(encounter, ctx, c), c.position, {
    size: spaceOf(ctx, c),
    maxCost: movement,
  });
  const squares = [...found.values()]
    .filter(({ point }) => !spaceTakenBy(encounter, ctx, c, point))
    .map(({ point, cost }) => ({ x: point.x, y: point.y, cost }))
    .sort((a, b) => a.cost - b.cost || a.y - b.y || a.x - b.x);
  return { id, movement, squares };
}

/**
 * What a move `to` a square or along a `path` would do: whether the engine would take it, the
 * squares and their cost, the zones the mover (or creatures its Emanation reaches) would get
 * into, the feet it would move in zones that deal damage for moving, and the enemies whose reach
 * it would leave. Saves aren't rolled: the preview doesn't know whether a zone would stop it.
 */
export function previewMove(
  encounter: Encounter,
  move: { id: string; to?: GridPoint; path?: readonly GridPoint[] },
  ctx: EncounterContext,
): MovePreview {
  const e = encounter;
  const c = combatantIn(e, move.id);
  const check = checkAction(
    e,
    {
      type: "move",
      id: c.id,
      ...(move.to ? { to: move.to } : {}),
      ...(move.path ? { path: [...move.path] } : {}),
    },
    ctx,
  );
  // Outside a fight there's no limit: the turns of Speed it takes instead.
  const exploring = e.round === 0;
  const speed = speedOf(ctx, c, e);
  const left = exploring ? speed : movementLeft(e, ctx, c);
  const empty: MovePreview = {
    ...check,
    path: [],
    cost: 0,
    movement_left: left,
    zones: [],
    opportunity_attacks: [],
    turns: exploring ? 0 : null,
  };
  if (!c.position || (!move.to && !move.path)) return empty;
  let planned: { path: GridPoint[]; steps: number[] };
  try {
    planned = exploring
      ? planMove(e, ctx, c, move, { left: explorationBudget(c.position, move) })
      : planMove(e, ctx, c, move);
  } catch (error) {
    if (error instanceof EncounterError) return empty;
    throw error;
  }
  const cost = planned.steps.reduce((a, b) => a + b, 0);
  // Walk it: the encounter as it would be at each step (an Emanation moves with its caster).
  const at = (p: GridPoint): Encounter => ({
    ...e,
    combatants: e.combatants.map((x) => (x.id === c.id ? { ...x, position: { ...p } } : x)),
  });
  const occupants = (state: Encounter, z: Zone): Set<string> => {
    const squares = zoneArea(state, ctx, z);
    if (!squares) return new Set();
    return new Set(
      state.combatants
        .filter(
          (x) =>
            x.position &&
            !outOfFight(ctx, x) &&
            !z.unaffected.includes(x.id) &&
            !(z.area.shape === "emanation" && !z.point && x.id === z.by) &&
            inArea(squares, { position: x.position, size: spaceOf(ctx, x) }),
        )
        .map((x) => x.id),
    );
  };
  const zones: MovePreview["zones"] = [];
  const movedIn = new Map<string, { z: Zone; steps: number; at: GridPoint }>();
  const enemies = e.combatants.filter(
    (x) => x.id !== c.id && !x.defeated && x.position && !alliesOf(e, x.id, c) && !x.used.reaction,
  );
  const reach = new Map(enemies.map((x) => [x.id, meleeReach(ctx, e, x)]));
  const inReach = (state: Encounter, x: EncounterCombatant) => {
    const r = reach.get(x.id) ?? null;
    const me = state.combatants.find((y) => y.id === c.id) as EncounterCombatant;
    const d = feetApart(ctx, me, x);
    return r !== null && d !== null && d <= r;
  };
  let state = e;
  let before = new Map(e.zones.map((z) => [z.id, occupants(state, z)]));
  const wasIn = new Map(enemies.map((x) => [x.id, inReach(state, x)]));
  const leftReach: string[] = [];
  for (const square of planned.path) {
    state = at(square);
    for (const z of e.zones) {
      const now = occupants(state, z);
      if (z.triggers.includes("enter")) {
        for (const id of now) {
          if (!before.get(z.id)?.has(id)) {
            zones.push({
              zone: z.id,
              label: z.label,
              creature: id,
              at: square,
              kind: "enters",
              feet: null,
            });
          }
        }
      }
      if (z.triggers.includes("move") && now.has(c.id)) {
        const m = movedIn.get(z.id) ?? { z, steps: 0, at: square };
        movedIn.set(z.id, { ...m, steps: m.steps + 1 });
      }
    }
    before = new Map(e.zones.map((z) => [z.id, occupants(state, z)]));
    for (const x of enemies) {
      const now = inReach(state, x);
      if (wasIn.get(x.id) && !now && !leftReach.includes(x.id)) leftReach.push(x.id);
      wasIn.set(x.id, now);
    }
  }
  for (const { z, steps, at: first } of movedIn.values()) {
    zones.push({
      zone: z.id,
      label: z.label,
      creature: c.id,
      at: first,
      kind: "moves_in",
      feet: steps * 5,
    });
  }
  return {
    ...check,
    path: planned.path.map((p) => ({ x: p.x, y: p.y })),
    cost,
    movement_left: exploring ? left : Math.max(0, left - cost),
    zones,
    opportunity_attacks:
      c.disengaged || exploring
        ? []
        : enemies.filter((x) => leftReach.includes(x.id)).map((x) => x.id),
    turns: exploring ? turnsFor(cost, speed) : null,
  };
}

/** What `previewArea` places: a spell, a save effect (`ability`) or a legendary action's. */
export interface AreaRequest {
  readonly id: string;
  readonly area: AreaPlacement;
  readonly spell?: string;
  readonly ability?: string;
  readonly legendary?: string;
}

/**
 * The squares and creatures an area would cover if combatant `id` placed it now: a spell's
 * (`spell`), a saving throw effect's (`ability`: a breath weapon) or a legendary action's, with
 * each creature's cover from its point of origin. `ok: false` with the engine's reason when the
 * placement is refused (out of range, a Cube away from its creator, no positions).
 */
export function previewArea(
  encounter: Encounter,
  request: AreaRequest,
  ctx: EncounterContext,
): AreaPreview {
  const fail = (reasons: readonly Message[]): AreaPreview => ({
    ok: false,
    reasons: texts(reasons),
    codes: texts(reasons).map(refusalCode),
    reason_messages: [...reasons],
    squares: [],
    targets: [],
    total_cover: [],
  });
  try {
    const c = combatantIn(encounter, request.id);
    const { area, range, label } = areaOf(encounter, ctx, c, request);
    if (!area) return fail([message("refusal.no_area_place", { spell: label })]);
    const placed = placeArea(encounter, ctx, c, area, request.area, range, label);
    const squares = [...placed.squares]
      .map((k) => k.split(",").map(Number) as [number, number])
      .map(([x, y]) => ({ x, y }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    return {
      ok: true,
      reasons: [],
      codes: [],
      reason_messages: [],
      squares,
      targets: placed.ids.map((id) => {
        const cover = placed.cover.get(id);
        return {
          id,
          cover:
            cover?.degree === "half" || cover?.degree === "three_quarters" ? cover.degree : "none",
          by: cover?.by ?? null,
        };
      }),
      total_cover: placed.total,
    };
  } catch (error) {
    if (error instanceof EncounterError) return fail(error.details);
    throw error;
  }
}

function areaOf(
  e: Encounter,
  ctx: EncounterContext,
  c: EncounterCombatant,
  request: AreaRequest,
): { area: SpellArea | null; range: number | null; label: string } {
  const fromSpell = (id: string) => {
    const spell = lookup(catalogOf(ctx, c).spells, id);
    if (!spell) throw new EncounterError([message("refusal.unknown_spell", { spell: id })]);
    return { area: spell.mechanics?.area ?? null, range: spellRangeFeet(spell), label: spell.name };
  };
  if (request.spell) return fromSpell(request.spell);
  const view = encounterCombatant(e, c.id, ctx);
  if (request.ability) {
    const line =
      view.save_actions.find((a) => a.name === request.ability) ??
      (() => {
        throw new EncounterError([
          message("refusal.no_save_effect", { name: c.name, ability: request.ability }),
        ]);
      })();
    return { area: line.area ?? null, range: line.range ?? null, label: line.name };
  }
  if (request.legendary) {
    const line =
      view.legendary_actions.find((a) => a.name === request.legendary) ??
      (() => {
        throw new EncounterError([
          message("refusal.no_legendary_action_named", { name: c.name, action: request.legendary }),
        ]);
      })();
    const save = line.save ?? view.save_actions.find((a) => a.name === line.uses);
    if (save) return { area: save.area ?? null, range: save.range ?? null, label: line.name };
    const cast =
      c.monster !== null
        ? monsterSpells(monsterDef(ctx, c)).find(
            (x) => x.section === "legendary_actions" && x.action === line.name,
          )
        : undefined;
    if (cast) return fromSpell(cast.spell);
    return { area: null, range: null, label: line.name };
  }
  throw new EncounterError([message("refusal.give_area_source")]);
}
