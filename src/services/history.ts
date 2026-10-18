/**
 * Undo and replay for encounters. Every action rolls only through `rng` and its result lists the
 * dice it drew (`EncounterResult.rolls`), so a history (the start and each action with its dice)
 * replays to the same encounter and character states: undo replays all but the last action.
 */

import type { Encounter, EncounterAction } from "../models/encounter";
import { type EncounterHistory, EncounterHistorySchema } from "../models/history";
import type { CharacterState } from "../models/state";
import { scriptedRng } from "../rules/rng";
import { applyEncounterAction, type EncounterContext, type EncounterResult } from "./encounter";

/** A history starting from this encounter and these character states. */
export function createHistory(
  encounter: Encounter,
  states: Readonly<Record<string, CharacterState>> = {},
): EncounterHistory {
  return EncounterHistorySchema.parse({ start: { encounter, states } });
}

/** The history with one more applied action (the result `applyEncounterAction` returned). */
export function recordAction(
  history: EncounterHistory,
  action: EncounterAction,
  result: Pick<EncounterResult, "rolls">,
): EncounterHistory {
  return { ...history, steps: [...history.steps, { action, rolls: [...result.rolls] }] };
}

/**
 * The encounter and character states after the first `steps` actions (default: all), replayed
 * with their recorded dice. `ctx` gives the catalog and the characters' builds; their states come
 * from the history.
 */
export function replayHistory(
  history: EncounterHistory,
  ctx: EncounterContext,
  steps = history.steps.length,
): { encounter: Encounter; states: Record<string, CharacterState> } {
  let encounter = history.start.encounter;
  const states: Record<string, CharacterState> = {};
  for (const [key, ref] of Object.entries(ctx.characters ?? {})) {
    states[key] = history.start.states[key] ?? ref.state;
  }
  for (const step of history.steps.slice(0, steps)) {
    const characters = Object.fromEntries(
      Object.entries(ctx.characters ?? {}).map(([k, ref]) => [
        k,
        { ...ref, state: states[k] as CharacterState },
      ]),
    );
    const r = applyEncounterAction(encounter, step.action, {
      ...ctx,
      characters,
      rng: scriptedRng(step.rolls),
    });
    encounter = r.encounter;
    Object.assign(states, r.states);
  }
  return { encounter, states };
}

/** Undo the last action: the history without it, and the encounter and states before it. */
export function undoAction(
  history: EncounterHistory,
  ctx: EncounterContext,
): { history: EncounterHistory; encounter: Encounter; states: Record<string, CharacterState> } {
  const shorter = { ...history, steps: history.steps.slice(0, -1) };
  return { history: shorter, ...replayHistory(shorter, ctx) };
}
