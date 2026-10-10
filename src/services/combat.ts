import type { Character } from "../models/character";
import { abilityModifier } from "../rules/dice";

// --- hit points ---------------------------------------------------------------------------

export function isAlive(character: Character): boolean {
  return character.current_hit_points > 0;
}

export function passivePerception(character: Character, proficient = false): number {
  const bonus = proficient ? character.proficiency_bonus : 0;
  return 10 + abilityModifier(character.ability_scores.wisdom) + bonus;
}
