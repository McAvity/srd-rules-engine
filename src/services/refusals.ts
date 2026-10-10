/**
 * Refusal codes for the engine's messages (`EncounterError.codes`): one table of patterns, so a
 * UI can tell "not your turn" from "out of range" without reading English.
 */

import type { RefusalCode } from "../models/events";

const PATTERNS: readonly [RegExp, RefusalCode][] = [
  [/^Waiting for a decision/, "pending_decision"],
  [/^Everyone waits: /, "halted"],
  [/The fight hasn't started|^Roll Initiative first/, "not_started"],
  [/It isn't .*'s turn|after another creature's turn, not on its own/, "not_your_turn"],
  [/ is Incapacitated$/, "incapacitated"],
  [/ is (already )?defeated$| is dead\b|The character is dead/, "defeated"],
  [/has already used its (action|bonus action|reaction)/, "economy_used"],
  [/no attacks left|no granted attacks left|already made its Cleave attack/, "no_attacks_left"],
  [/has already used .* this turn|can't take .* again until the start/, "once_per_turn"],
  [/Total Cover/, "total_cover"],
  [/ isn't on the map$/, "off_map"],
  [/feet away|out of .*(range|reach)|beyond .*range|must start next to/, "out_of_range"],
  [/can't move to|can't reach|is blocked$|is in that space|The path jumps/, "no_path"],
  [
    /can move \d+ more feet|feet of movement to stand up|can't right itself at Speed 0|its Speed is 0/,
    "no_movement",
  ],
  [
    /spell slots? left|Pact Magic slots? left|times? today|hasn't recharged|uses? left|No uses|has no .*uses/,
    "no_resources",
  ],
  [
    /^Unknown |^No (combatant|character|effect|wall|zone|point of interest) |has no (feature|legendary|class)|can't cast/,
    "unknown",
  ],
  [
    /^Give |[Cc]hoose |needs a target|needs its source|needs positions|place it first/,
    "incomplete",
  ],
];

/** The code for one of the engine's refusal messages (`refused` when no pattern matches). */
export function refusalCode(message: string): RefusalCode {
  return PATTERNS.find(([re]) => re.test(message))?.[1] ?? "refused";
}
