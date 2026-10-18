/**
 * Encounter events: what changed between the encounter (and its characters' states) before and
 * after an action, as data. Comparing documents rather than instrumenting each rule keeps every
 * change covered, whichever rule made it.
 */

import { type Catalog, lookup } from "../content/catalog";
import type { CharacterBuild } from "../models/build";
import type { Encounter, EncounterCombatant } from "../models/encounter";
import type { EncounterEvent } from "../models/events";
import type { CharacterState } from "../models/state";
import { computePlaySheet } from "./play";

interface Characters {
  readonly [key: string]: {
    readonly build: CharacterBuild;
    readonly state: CharacterState;
    readonly catalog?: Catalog;
  };
}

/** HP, temp HP, conditions and status of a combatant, from its document or its state. */
function vitals(
  c: EncounterCombatant,
  catalog: Catalog,
  build: CharacterBuild | undefined,
  state: CharacterState | undefined,
) {
  if (c.monster !== null) {
    const max = lookup(catalog.monsters, c.monster)?.hit_points ?? 0;
    return {
      hp: c.hp ?? max,
      temp: c.temp_hp,
      conditions: c.conditions,
      concentration: c.concentration,
      status: c.defeated ? "defeated" : "up",
      resources: {} as Record<string, number>,
    };
  }
  if (!build || !state) return null;
  const play = computePlaySheet(build, state, catalog).play;
  const resources: Record<string, number> = {};
  state.spell_slots_spent.forEach((n, i) => {
    resources[`spell_slot:${i + 1}`] = n;
  });
  resources.pact_slot = state.pact_slots_spent;
  for (const [k, n] of Object.entries(state.uses_spent)) resources[`uses:${k}`] = n;
  return {
    hp: play.hp.current,
    temp: play.hp.temp,
    conditions: state.conditions,
    concentration: state.concentration,
    status: state.dead
      ? "dead"
      : state.stable && play.hp.current === 0
        ? "stable"
        : play.hp.current === 0
          ? "down"
          : "up",
    resources,
  };
}

/**
 * The events between `before` and `after`: turns, who joined or left, Initiative, moves, HP,
 * conditions, status, Concentration, the economy spent, resources, effects, zones, the map.
 */
export function encounterEvents(
  before: Encounter,
  after: Encounter,
  catalog: Catalog,
  charactersBefore: Characters = {},
  statesAfter: Readonly<Record<string, CharacterState>> = {},
  /** The action, when known: a `move` by feet (no positions) is still a move. */
  action?: { readonly type: string; readonly id?: string },
): EncounterEvent[] {
  const events: EncounterEvent[] = [];
  const turnOf = (e: Encounter) => (e.round === 0 ? null : (e.order[e.turn] ?? null));
  if (before.round > 0 && after.round === 0) events.push({ type: "fight_ended" });
  const now = turnOf(after);
  if (now && (after.round !== before.round || now !== turnOf(before))) {
    events.push({ type: "turn", round: after.round, id: now });
  }
  const was = new Map(before.combatants.map((c) => [c.id, c]));
  const is = new Map(after.combatants.map((c) => [c.id, c]));
  for (const c of after.combatants) if (!was.has(c.id)) events.push({ type: "joined", id: c.id });
  for (const c of before.combatants) if (!is.has(c.id)) events.push({ type: "left", id: c.id });
  for (const c of after.combatants) {
    const b = was.get(c.id);
    if (!b) continue;
    if (b.initiative !== c.initiative) {
      events.push({ type: "initiative", id: c.id, value: c.initiative });
    }
    const moved = (p: { x: number; y: number } | null, q: { x: number; y: number } | null) =>
      p?.x !== q?.x || p?.y !== q?.y;
    const byFeet = action?.type === "move" && action.id === c.id && c.moved > b.moved;
    if (moved(b.position, c.position) || byFeet) {
      events.push({
        type: "moved",
        id: c.id,
        from: b.position ? { ...b.position } : null,
        to: c.position ? { ...c.position } : null,
        feet:
          after.round === before.round && after.turn === before.turn
            ? Math.max(0, c.moved - b.moved)
            : 0,
      });
    }
    if (after.round === before.round && after.turn === before.turn) {
      for (const what of ["action", "bonus_action", "reaction"] as const) {
        if (!b.used[what] && c.used[what]) events.push({ type: "used", id: c.id, what });
      }
    }
    const key = c.character ?? "";
    const ref = charactersBefore[key];
    const v0 = vitals(b, ref?.catalog ?? catalog, ref?.build, ref?.state);
    const v1 = vitals(c, ref?.catalog ?? catalog, ref?.build, statesAfter[key] ?? ref?.state);
    if (!v0 || !v1) continue;
    if (v0.hp !== v1.hp || v0.temp !== v1.temp) {
      events.push({
        type: "hp",
        id: c.id,
        from: v0.hp,
        to: v1.hp,
        temp_from: v0.temp,
        temp_to: v1.temp,
      });
    }
    for (const x of v1.conditions) {
      if (!v0.conditions.includes(x))
        events.push({ type: "condition_added", id: c.id, condition: x });
    }
    for (const x of v0.conditions) {
      if (!v1.conditions.includes(x))
        events.push({ type: "condition_removed", id: c.id, condition: x });
    }
    if (v0.status !== v1.status) {
      events.push({ type: "status", id: c.id, status: v1.status as "up" });
    }
    if (v0.concentration !== v1.concentration) {
      events.push({
        type: "concentration",
        id: c.id,
        spell: v1.concentration,
        previous: v0.concentration,
      });
    }
    for (const r of new Set([...Object.keys(v0.resources), ...Object.keys(v1.resources)])) {
      const [from, to] = [v0.resources[r] ?? 0, v1.resources[r] ?? 0];
      if (from !== to)
        events.push({ type: "resource", id: c.id, resource: r, spent_from: from, spent_to: to });
    }
  }
  const effects0 = new Set(before.effects.map((x) => x.id));
  const effects1 = new Set(after.effects.map((x) => x.id));
  for (const x of after.effects) {
    if (!effects0.has(x.id)) {
      events.push({
        type: "effect_added",
        effect: x.id,
        target: x.target,
        condition: x.condition,
        label: x.label,
      });
    }
  }
  for (const x of before.effects) {
    if (!effects1.has(x.id)) events.push({ type: "effect_ended", effect: x.id, target: x.target });
  }
  const zones0 = new Map(before.zones.map((z) => [z.id, z]));
  const zones1 = new Set(after.zones.map((z) => z.id));
  for (const z of after.zones) {
    const old = zones0.get(z.id);
    if (!old) events.push({ type: "zone_added", zone: z.id, label: z.label });
    else if (old.point?.x !== z.point?.x || old.point?.y !== z.point?.y) {
      events.push({ type: "zone_moved", zone: z.id, to: z.point ? { ...z.point } : null });
    }
  }
  for (const z of before.zones)
    if (!zones1.has(z.id)) events.push({ type: "zone_ended", zone: z.id });
  if (JSON.stringify(before.map) !== JSON.stringify(after.map)) events.push({ type: "map" });
  if (after.pending && !before.pending) {
    events.push({
      type: "pending",
      combatant: after.pending.combatant,
      kind: after.pending.kind,
      question: after.pending.question,
      ...(after.pending.question_message
        ? { question_message: after.pending.question_message }
        : {}),
    });
  }
  return events;
}
