# Changelog

All notable changes are documented here. This project follows
[Semantic Versioning](https://semver.org/); until 1.0, minor versions may contain breaking API
changes. Saved documents (builds, play states, encounters) are never broken: an older format is
migrated when it's loaded.

## [Unreleased]

### Added
- The play sheet's spells say which slots each can be cast with now (`PlaySheet.spells`:
  `PlaySpellLine`): `slot_levels` (levels with a slot left; empty for a cantrip), `pact_slot`
  (the Pact Magic slot's level while one is left), and `slots` (`SpellSlotChoice`: every level it
  could use, those with none left included, with `left`, `available` and a `reason` in the
  `OptionReason` shape). `spellSlots(level, play)` computes them; encounter options use it too.
- Saving throws on demand: the `check` action takes `save: Ability` (a `D20TestResult`, note
  `save.result`), with the combatant's conditions, a DC or none, nothing applied.
- Messages for any language: `renderMessage(message, catalog, { locale })` (and `formatMessage`'s
  new last argument, `RenderOptions`) picks a `plural` option by the locale's rules
  (`Intl.PluralRules`: `zero`, `one`, `two`, `few`, `many`, `other`; `=n` first; English rules
  without a locale, as before). List joiners are catalog entries: `list.comma`, `list.plus`,
  `list.semicolon`, `list.or`, `list.and` (English when a catalog lacks them). New codes in
  `MESSAGES_EN`: `step.<id>` (the builder's step titles, `STEP_TITLES` now reads them),
  `alignment.<id>` (`ALIGNMENT_NAMES`), `stat.*`; `StatChange.label_message` and
  `D20TestResult.label_message` (`rollCheck`, `rollD20Test`: `roll.check`, `roll.save`,
  `roll.attack_label`).
- GM override: `force: true` on an action taken in turns (`attack`, `cast`, `move`, `feature`,
  `legendary`…) applies it despite a refusal of legality, one of `FORCEABLE_REFUSALS`
  (`not_your_turn`, `incapacitated`, `economy_used`, `no_attacks_left`, `once_per_turn`,
  `out_of_range`, `off_map`, `no_movement`, `no_resources`), each noted as `override.applied`
  ("GM override: Brakka has no attacks left this turn"). A cost that can't be paid isn't spent (no
  slot of that level left: the spell is cast without one). Other refusals still refuse.
  `checkAction` with `force` lists what it would override (`overrides`, `override_codes`).
- Rolling by hand, a dice roller: `rollByHand(combatant, what, { catalog, monster?, character?,
  rng })` rolls an attack, a Grapple or Shove, a spell, a feature, a saving throw effect or a
  legendary action (`RollWhat`) with no target, no turn and no action economy, and applies
  nothing: a pure function over plain inputs (a `Combatant`; the monster's stat block for its
  spell lines and daily uses; the character's build and state for features, known spells and
  Cunning or Brutal Strike). Its `ByHandRoll` has `rolls` (`DeclaredRolls`: `attacks`, one
  `AttackDice` per attack roll, each beam or ray, with the d20, the mode and reasons from the
  actor's own state, bonus, total, `critical_hit`, `critical_miss` and the damage, crit dice
  doubled; `damage` rolled once; `healing`; a forced save's `ability` and `dc`) and `costs`
  (`RollCost`, not spent: a play action for the character's state, such as a spell slot,
  Concentration or a feature's uses; a monster's daily use; a monster's ability to recharge).
  In an encounter, `{ type: "roll", id, what, force? }` rolls and spends the costs: refused only
  when a cost can't be paid or the actor can't act, `force` rolling anyway with an unpayable cost
  unspent; its result is a `DeclaredResult`, with notes (`manual.declared`, `manual.attack`,
  `manual.damage`, `manual.healing`, `manual.save`). On a sheet, `POST /v1/state/roll` rolls and
  applies the character's costs. `rollAttack(attacker, attack, options)` rolls one attack without a
  target; `castSpell` takes `by_hand` (its result's `by_hand`: `SpellDice`); `use_feature` takes
  `manual` to spend a feature's uses without its healing.
- Every refusal reason, with a category: options (`OptionEntry`, `StrikeOption`) list `reasons`
  (`OptionReason`: `code`, `category`, `text`, `message`), every reason the engine would refuse
  the option now, not only the first, and `rollable` (the `roll` action takes it). Each refusal
  code has a category (`REFUSAL_CATEGORIES`: `economy`, `turn`, `target`, `movement`, `resource`,
  `state`, `input`, `other`), so a client chooses which ones to enforce. New refusal code
  `no_target` (no creature to aim an option at). `checkAction` with `force` also lists what it
  overrode when something else stops the action (`EncounterError.overridden`).
- `encounter.positions` (`optional` by default, or `required`), set by the GM with
  `{ type: "set_positions", mode }`: when required and anyone is on the map, an attack, spell,
  save effect, Help, Grapple, Shove or feature that checks reach or range is refused if the actor
  or a target has no position (refusal code `off_map`).
- Messages for translation: results have `messages` next to `notes` (`Message`: `code`,
  `params`, English `text`), with the English templates in `MESSAGES_EN` and `renderMessage` /
  `formatMessage` to render them with another catalog: encounter results, `applyAction` and
  `reconcileState` (`PlayResult`), `takeDamage`, `adjustDamage`, `castSpell`, and the HTTP routes
  that return notes. Attack, save and check results have `reason_messages` next to `reasons`
  (`ModeReason` takes an optional `message`). Refusals too: `EncounterError`, `PlayError` and
  `BuildError` have `details` next to `messages`; `checkAction` and the move and area previews
  have `reason_messages`, options `reason_message`; the rules throw `RuleError` (a `RangeError`
  with `detail`). Decisions have `message` next to `question`, and `encounter.pending` and its
  event `question_message`. The builder too: `Issue.detail`, `OptionView.unavailable_message`,
  `LevelUpOption.unavailable_message`, `BuildResult.messages`, `ChangePreview.pending[].detail`,
  the play sheet's `StateIssue.detail`; options have `label_message`, `note_message` and (Cunning
  and Brutal Strike) `cost_message`.
- `unassignedValues(method, scores, rules, pool)` is public: the standard array's or rolled pool's
  values not assigned to an ability yet.
- `builder.previewOption(build, catalog, choiceKey, value)`: the sheet numbers an option would
  change (`StatChange`: `stat`, `label`, `before`, `after`), as the CLI builder shows them.
- Spell and saving throw effect results name each target by its combatant id
  (`SpellTargetResult.id`, `null` outside an encounter), next to `target` (the index) and `name`.
- Rolls outside an encounter: `rollCheck(build, state, catalog, request, { dc, mode, rng })` and
  `rollD20Test(combatant, request, …)` roll a check, a saving throw or an attack roll with no
  target, with Advantage and Disadvantage from features and conditions and the reasons.
  `attackMode` takes `null` for no target.
- `magicItemBases(catalog, magicItemId)`: the catalog items a magic item can be made from. Gear has
  `ammunition` (the SRD Ammunition table's five kinds).
- `playBuild(build, state, catalog)` is public: the build as played today (after-a-rest picks
  overlaid), to list those choices' options as the play action `set_choice` judges them.
- Attack options list the Cunning Strike and Brutal Strike effects the attacker has
  (`OptionEntry.strikes`, `StrikeOptionSchema`): cost, a ready action, and whether the engine
  would take it now, with the reason.
- A creature's space on the grid: `Combatant.space` (squares on a side: Large 2, Huge 3,
  Gargantuan 4, otherwise 1) and `spaceForSize(size)`.
- `zoneSquares(encounter, zoneId, ctx)`: the squares a zone covers now, an Emanation's moving
  with its creature and sized from its space.
- Bloodied: `isBloodied(hp, maxHp)`, `Combatant.bloodied` and `computePlaySheet(...).play.hp.bloodied`
  (half the Hit Point maximum or fewer, 0 included; Temporary Hit Points don't count).
- Exploring: outside a fight (`round: 0`) a `move` has no limit, and its note and
  `previewMove(...).turns` (new) say how many turns of Speed it takes. Encounters have a travel
  `pace` (Fast: −5 to Passive Perception, Slow: +5; Disadvantage or Advantage on Perception
  checks) set with `set_exploration`.
- Points of interest: `encounter.points` (`PointOfInterestSchema`, `POINT_KINDS`), actions
  `add_point`, `update_point`, `remove_point`. Hidden until the GM reveals them; a character
  notices one in range and in sight by Passive Perception (`combatantPassivePerception`) or a
  Perception `search` (which now takes no action outside a fight), and its move stops there;
  with `notice_stops: everyone` every move waits (`halted`, refusal code `halted`) until the GM
  reveals it or `resume`s.
- Starting equipment taken later: play states have `starting_equipment` (whether the build's
  starting equipment and gold are in the inventory), and the play action
  `take_starting_equipment` adds them once, for a state made before the build had its
  equipment. `computePlaySheet(...).play.starting_equipment_taken` and
  `startingEquipment(build, catalog)` (what it would add) let an app offer it. States saved
  before read as taken when their inventory or purse isn't empty.
- Moves follow a path square by square (`move` `to`, straight, or a new `path`): zones entered
  on the way make their save, a creature held on the way stops, and zones with the `move`
  trigger deal damage for every 5 feet moved in them.
- Zone options: `optional` (the caster may force the save: a `zone_force` decision, by default
  for enemies only), `anchor: point` and `space` (an Emanation around a placed space), `ram`
  (`move_zone` `onto` a creature), `on_fail` (`no_actions`, `lose_concentration`), and
  conditions `until: end_of_its_turn`. Six more SRD spells use them: Spike Growth, Stinking
  Cloud, Sleet Storm, Flaming Sphere, Conjure Animals, Conjure Woodland Beings.
- `srd-rules fight`: `zone <id> move <x> <y> onto <who>`.
- `combatantOptions(encounter, id, ctx)`: what a combatant can do now (attacks and their
  variants, spells with slot levels left, features with uses left, monster saving throw effects
  and legendary actions, standard actions, its zones), each as an encounter action with its cost,
  candidate targets, and whether the engine would take it or why not. `checkAction` answers the
  same for one action by a dry run. Routes `POST /v1/encounters/options` and
  `/v1/encounters/check`; JSON Schema `schemas/options.schema.json`.

- `srd-rules-engine/srd`: the bundled SRD (`srdCatalog`, `srdPack`), also in
  `srd-rules-engine/node`.
- The SRD split by table, published as `srd-rules-engine/srd-5.2.1/*.json` (`manifest.json` and
  one file per table); `splitPack(pack)` splits any pack, `loadPack(fetchJson, { tables })`
  reads one back.
- `createCatalog(packs, { tables })` loads only some tables (`CORE_TABLES`: what a character
  builder needs first); reading a table that wasn't loaded throws a `ContentError`; `isLoaded`.

- A map for encounters (`encounter.map`): walls between grid corners, Difficult Terrain and
  blocked squares, changed with `set_terrain`, `add_wall` and `remove_wall`. Moves pay 10 feet
  for a square of Difficult Terrain (the map's, a zone's, or a creature's space that isn't an
  ally's or Tiny), can't go through walls, blocked squares or creatures that can't be passed
  through (SRD "Moving around Other Creatures"), and a move `to` a square goes around obstacles
  by the cheapest path. Zones can be Difficult Terrain (`zone.difficult`): Web, Grease, Spike
  Growth, Sleet Storm, Black Tentacles, Insect Plague. `rules/grid.ts`: `findPath`,
  `stepBlocked`, `stepCost`, `straightPath`.
- `srd-rules fight`: `terrain difficult|blocked|clear x y [x2 y2]`, `wall [remove] x1 y1 x2 y2`;
  `map` draws walls, blocked squares, Difficult Terrain and zones.

- Cover worked out from the map when positions are used and the caller gives none: walls,
  blocked squares and creatures in between give Half, Three-Quarters or Total Cover (noted);
  Total Cover can't be targeted. Areas and zones leave out squares with no clear line from their
  point of origin, and Dexterity saves against an area get cover from it. `combatantOptions`
  leaves targets behind Total Cover out. `mapCover`; `rules/grid.ts`: `lineClear`, `coverDegree`,
  `obstacles`.

- Previews for a map: `reachableSquares` (the squares a combatant can end a move on, with
  their cost), `previewMove` (a move's path, cost, zones on the way and Opportunity Attacks) and
  `previewArea` (an area's squares and the creatures in it, with their cover); routes
  `POST /v1/encounters/reachable`, `/preview-move`, `/preview-area`; JSON Schemas
  `reachable`, `move-preview`, `area-preview`.

- Encounter results have `events` (`EncounterEventSchema`, `schemas/encounter-event.schema.json`):
  turns, moves, HP, conditions, status, Concentration, the economy and resources spent, effects,
  zones and map changes, as data; and `rolls`, the dice the action drew.
- Refusal codes: `EncounterError.codes` (`REFUSAL_CODES`, `refusalCode`), also in `checkAction`,
  options, previews and the HTTP API's 400 responses (`codes`).
- Undo and replay: `createHistory`, `recordAction`, `replayHistory`, `undoAction`
  (`EncounterHistory`, `schemas/history.schema.json`). `POST /v1/encounters/apply` returns
  `events` and `log` (each action with its dice). `srd-rules fight`: `undo`.

- Options carry `odds` against their first target: the chance to hit and to score a Critical
  Hit, or that the target fails its save, and the average damage. `attackOdds`, `failOdds`,
  `averageDamage`. `srd-rules fight`'s `options` shows them.

- Encounter actions `hide` (and `reveal`), `search`, `ready` and `release`, `study`, `influence`,
  `utilize` (SRD actions); combatants record `hidden` and `readied`. `srd-rules fight`: `hide`,
  `reveal`, `search`, `utilize`, `release`.

- Class features used in turns: Indomitable (a decision on a failed save), Deflect Attacks (a
  reaction when hit), Stunning Strike's effects on a successful save, Lay On Hands' cure for
  Poisoned, Innate Sorcery (a toggle: +1 spell save DC, Advantage on spell attacks), Divine Spark
  and Turn Undead. Feature `actions` gain `many`, `range`, `creature_types`, `removes`,
  `reduces_attack_damage`, `save.dc_ability: spell`, `save.damage`, `save.rounds`,
  `save.ends_on`, `save.on_success`, `heal.scaling`; effect target `spell.save_dc`, Advantage
  target `attack.spell`, rule `indomitable`. The encounter action `feature` takes `targets` and
  `damage_type`.

- Cunning Strike and Brutal Strike (`attack` options `cunning` and `brutal`), Relentless Rage (a
  decision), Agonizing Blast, Sacred Weapon. `makeAttack` options `forgo`, `extra_damage`,
  `forgo_advantage`, `bonus`; effects with `repeat_save`; effect target `attack.weapon`;
  `spell_damage` `spell`.

- Wall spells: `mechanics.wall`, placed with `cast` `wall: { from, to, side }`: Wall of Force,
  Wall of Stone and Wall of Ice (between squares: they block movement and lines), Blade Barrier,
  Wall of Thorns and Wall of Fire (zones of squares). Zones gain `squares`, `segments`,
  `wall_squares`, `cover`, `cost` and `no_save`; terrain can cost more per foot (`costs`).
  `srd-rules fight`: `cast <spell> from x,y to x,y [left|right]`.

- Toggles can last `rounds` in an encounter (Rage: 10 minutes, Innate Sorcery: 1 minute, Sacred
  Weapon: 10 minutes); damage riders can be `own_turn` (Divine Strike); zones can halve other
  creatures' Speed (`speed_halved`: Spirit Guardians).

- Spell mechanics for Hunter's Mark, Hex, Divine Smite, Flame Strike, Chain Lightning and Mass
  Suggestion: `mark` (encounter marks of kind `quarry`, moved with the encounter action
  `move_mark`), `after_hit`, `bonus_vs`, conditions' `ends_on_damage`; `castSpell`'s `critical`.

- Shopping: the play actions `buy` and `sell` (coins with change, half the price when selling;
  `rules/currency.ts`: `pay`, `priceInCp`, `coinsFor`, `formatCp`, `purseValue`); gear and tools
  have `cost` and `weight` (gear also `bundle`), from `scripts/import-srd-gear.ts`, which adds
  the SRD's Adventuring Gear (100 items). `srd-rules play`: `buy`, `sell`.

- Monster traits in encounters: damage auras at the end of the monster's turn, Death Burst and
  Death Throes when it dies, Regeneration (and dying at 0 HP only when it can't regenerate),
  Aura of Authority's Advantage; trait fields `trigger`, `aura`, `regeneration`,
  `advantage_aura`, read by `import-srd-monsters.ts`.

### Changed
- An ammunition magic item (Ammunition, +1) can only be made from ammunition, not from any gear;
  a shield's base respects its `ids` and `except`.
- Carried weight counts gear and tools.
- Leaving an enemy's reach is judged at every step of a move, not only from its start and end.
- **Breaking:** `srdCatalog` and `srdPack` moved from `srd-rules-engine` to
  `srd-rules-engine/srd` (or `srd-rules-engine/node`), so the main entry no longer bundles the
  SRD data (about 2 MB). Migration: `import { srdCatalog } from "srd-rules-engine/srd"`.
  `SRD_PACK_ID` stays in the main entry.
- `srd-rules fight`: `options` shows what's left this turn and every option, dimmed with the
  reason when the engine would refuse it.

### Fixed
- An encounter action of an unknown type did nothing; it's refused ("Unknown action").

### Removed
- **Breaking:** public exports nothing used: `baseScoreErrors`, `backgroundBonusErrors` and
  `multiclassBlockers` (English-only twins of the builder's messages); `applyDamage`,
  `applyHealing` (use the play actions `damage` / `heal`, or `takeDamage`); `isAlive`,
  `passivePerception`, `savingThrow` and `AbilityFullNameSchema` (still behind the HTTP routes
  `/v1/characters/{name}/alive`, `/passive-perception` and `/v1/combat/saving-throw`);
  `formatDiceExpression`; the types `LevelUp`, `CharacterClass`, `AbilityScores` and `PatchOp`
  (their schemas and constants stay).

## [0.1.0] - 2026-10-05

### Changed
- Encounter notes: a monster's damage no longer notes Massive Damage or Death Saving Throw
  failures (it dies at 0 HP); a Bardic Inspiration die is noted before the result it changed;
  spell attack notes give the target's AC.
- The builder's title shows the loaded build's level instead of always "Level 1".
- Bardic Inspiration and Legendary Resistance are decisions: in `auto` mode (the default) the
  die is used only when it can turn a failure into a success; Uncanny Dodge is offered when an
  attack hits instead of being declared with `attack` `target_feature` (removed).
- A monster's legendary saving throw effects are no longer in `save_actions`: only the
  encounter action `legendary` uses them.
- The published `srd-5.2.1.json` is minified (about 2 MB instead of 3.8 MB).
- Docs: README reorganized by use (builder, play, combat, spells, monsters, encounters, packs);
  ARCHITECTURE.md restructured, with every flagged interpretation in one section;
  `docs/ROADMAP.md` (what's done, decisions, next steps) replaces the roadmap review;
  "Writing your own pack, step by step" in CONTENT.md.
- Effect `target` and `when` are closed lists (`EFFECT_TARGETS`, `EFFECT_CONDITIONS`): content
  with an unknown target or condition is rejected at load instead of being silently ignored.
  The JSON Schemas list them for autocompletion.
- An entity without a `source` gets its pack's name (`homebrew` for a pack without a name)
  instead of `srd-5.2.1`. The bundled SRD is unchanged.
- Class content is split into core traits (`grants`), `multiclass` grants and `features` by
  level. Level 1 choice keys are unchanged, so existing builds still load.
- Sheet: `hit_die` became `hit_dice`; spell slots moved from each spellcasting line to
  `spell_slots` and `pact_magic`; Eldritch Invocations are `feature` choices
  (`feature:pact-of-the-tome@class:warlock#invocation`).
- Ported the engine from Python (FastAPI, Pydantic) to TypeScript. Saved builds keep the
  same JSON format, so characters saved by the Python builder still load.
- The HTTP API is now a framework-free `fetch` handler (`srd-rules-engine/http`) that runs on
  Node, Deno, Bun and Cloudflare Workers. Routes and payloads are unchanged.
- `/v1/spells/save` also returns `damage_dealt`.
- Dice expressions are limited to 1000 dice of up to 1000 sides.

### Added
- A `version` on builds, play states and encounters (`DOCUMENT_VERSION`, now 1): new documents
  are written with it, a document without one is version 1, and one from a newer engine is
  refused with a message saying so. The JSON Schemas include it.
- JSON Schemas for play documents and actions: `schemas/state.schema.json`,
  `encounter.schema.json`, `play-action.schema.json` and `encounter-action.schema.json`
  (generated by `npm run content`), with the action unions shared as `$defs` (`PlayAction`,
  `EncounterAction`). `tests/json-schemas.test.ts` validates the bundled SRD, builds, states and
  encounters against every schema with Ajv (a dev dependency).
- Spell zones: `mechanics.zone` (triggers `enter`, `start_turn`, `end_turn`; `once_per_turn`,
  `on_cast`, `designate`) and `encounter.zones` (`ZoneSchema`). Creatures save when they enter a
  zone or it moves onto them, and at the start or end of their turn there; the encounter actions
  `zone_save`, `move_zone` and `end_zone`; `zone` commands in `srd-rules fight`. Eight SRD spells
  use it: Moonbeam, Spirit Guardians, Cloudkill, Insect Plague, Incendiary Cloud, Black
  Tentacles, Web, Grease.
- `mechanics.damage_types` with `castSpell`'s `damage_type` option and `cast`'s `damage_type`
  (Spirit Guardians); `cast`'s `unaffected`; `castSpell` results' `damage_parts`.
- `escape` on a spell's conditions: `escape` ends a hold (Black Tentacles, Web) with the
  check the spell names (`EncounterEffect.escape_skill`).
- Spell mechanics: a flat damage `bonus` (Magic Missile's 1d4 + 1, Disintegrate, Finger of
  Death); `projectiles` (darts that hit automatically, or rays with an attack each; one target
  or one `targets` entry per projectile); `follow_up`, a saving throw after the attack for the
  target and the creatures within its radius (Ice Knife); `on_hit: [advantage_against]`
  (Guiding Bolt); `until` on conditions (Ray of Sickness, Color Spray, Sunbeam). Five more SRD
  spells have mechanics: Magic Missile, Scorching Ray, Ice Knife, Disintegrate, Finger of Death.
- `castSpell` options `modesFor` (Advantage or Disadvantage for one spell attack roll, melee or
  ranged) and `nearby`; results `follow_up` and `targets[i].on_hit`.
- Encounters: `marks` (`SpellMarkSchema`) for Guiding Bolt's Advantage, used by the next attack
  roll against the target, whoever makes it; Help, Vex and Sap now reach spell attack rolls;
  `cast` takes `nearby` for a follow-up save without positions (`near …` in `srd-rules fight`);
  conditions with a duration in the spell's text end at the start or end of the caster's next
  turn.
- `npm run demo` (`examples/battle-demo.ts`): a seeded battle that shows the main features, its
  story snapshotted in `tests/demo.test.ts`. `rules/areas.ts` (`areaSquares`, `inArea`,
  `distanceToPoint`) is exported from the package.
- Areas of effect on the grid: `area: { point } | { toward }` on `cast`, `save_action` and
  `legendary` chooses the targets (`rules/areas.ts`: `areaSquares`, `inArea`,
  `distanceToPoint`); monster save effects' `area` and `range` read from their text (79 areas,
  54 ranges), with single-target ranges checked; `SpellArea.width` (5 by default); the fight
  CLI's `@x,y` and `>x,y`. Areas skip creatures out of the fight.
- Positions on a 5-foot grid, optional: encounter combatant `position`, the actions `place` and
  `move` `to`, `gridDistance`; reach, normal and long range, close combat (also for spell
  attacks), thrown weapons (`attack` `thrown`), spell range and Touch, Sneak Attack's adjacent
  ally and "within 5 feet" measured; Opportunity Attacks noted when leaving reach; `cover` on
  `attack`, `cast` and `save_action`. `AttackLine.reach` and `range`; `castSpell` options
  `modes` and `within_5ft`. The fight CLI's `place`, `move <x> <y>` and `map`.
- `srd-rules fight`: an encounter in the terminal with saved characters and SRD monsters (turn
  order and status, commands for every encounter action, `options`, decisions as y/n questions
  with `--ask`, saving and resuming). `Pending.recommended`. Spell and saving throw effect notes
  give each target's save or attack roll and what it takes; check notes name the skill or
  ability; a refused change to a character's state names the character.
- Decisions after a roll: `Decision`, `Decide`, the `decide` option of `rollSavingThrow`,
  `rollAbilityCheck`, `makeAttack`, `castSpell` and `useSaveAction`; `Combatant.id`; encounter
  `decisions` (`ask` | `auto`, also per combatant and on `add_monster` / `add_character`),
  `pending` (`PendingSchema`) and the actions `decide` and `set_decisions`;
  `createEncounter({ decisions })`; `EncounterResult.pending`. `POST /v1/encounters/apply`
  returns `pending` and `applied`.
- Class features used in turns: grants `actions` (`FeatureActionDef`: economy, resource,
  healing, extra action, standard actions along, granted attacks, an after-hit save, an
  inspiration die, a damage-halving reaction); sheet `actions` (`FeatureActionLine`); the play
  action `use_feature`; the encounter action `feature`, `attack` `granted` and `target_feature`;
  encounter fields `surged`, `granted_attacks`, `hits`, `features_used`, `inspiration`;
  `Combatant.inspiration_die`, used on a failed D20 Test (`inspiration` in attack, save, check
  and spell attack results). Content: Second Wind, Action Surge, Lay On Hands, Flurry of Blows,
  Patient Defense, Step of the Wind, Stunning Strike, Uncanny Dodge, Bardic Inspiration.
- Class features that change rolls: Danger Sense, Reckless Attack (ends at the start of your
  next turn in encounters), Feral Instinct, Frenzy, Evasion (also the Assassin's), Reliable
  Talent, Primal Strike, Colossus Slayer, Potent Spellcasting, Potent Cantrip, Empowered
  Evocation, Elemental Affinity. Content: Advantage targets `initiative`, `attack.str`,
  `attacked` and the `{target, unless}` form; toggle `ends_at_turn_start`; rider `while_active`,
  `requires: target_damaged` and `{progression, die}` damage; grants `rules` (`FEATURE_RULES`)
  and `spell_damage`. Sheet `rules` and `spell_damage`; combatant `rules`,
  `proficient_skills`, `spell_damage`.
- Monster spellcasting: monster action fields `casts` (the Spellcasting action's lists, other
  actions that cast spells, legendary actions that use Spellcasting; 97 in the SRD) and `per_day`
  ("(2/Day)"); `monsterSpells`, `MonsterSpellLine`; monster combatants get a spellcasting line
  per casting action. The encounter action `cast` works for monsters (`via` picks the action;
  fixed levels, daily uses, Recharge), `legendary` casts a legendary action's spell, and
  "(N/Day)" attacks and saving throw effects are limited (`daily_used`). The encounter `cast`
  action's `targets` is optional.
- Weapon Mastery properties in encounters: Graze (damage on a miss), Vex, Sap and Slow (encounter
  `masteries`, ending on the attacker's turns), Topple (Constitution save or Prone), Push (noted),
  Cleave (`attack` with `cleave: true`, once per turn; `AttackLine.cleave_damage_parts`), Nick
  (the Light extra attack as part of the Attack action). `attack` takes `mastery: false` to skip
  them; `makeAttack` takes `cleave`.
- Standard combat actions in encounters: `dodge`, `disengage` (and `dash`) with `bonus_action`
  for features that allow it; `help` (an ally's next attack roll against an enemy, or its next
  check with a skill you're proficient in); `unarmed` (Grapple and Shove: a Strength or
  Dexterity save against 8 + Strength modifier + Proficiency Bonus; size limit); `escape`
  (Athletics or Acrobatics against the grapple's escape DC; `effects` takes `escape_dc`);
  `stand` (half the Speed); `attack` with `opportunity` (refused against a Disengaged target)
  and `light_extra` (the Light property's extra attack as a Bonus Action). Grapples end when
  the grappler is Incapacitated. Encounter fields `dodging`, `disengaged`, `light_attacks`,
  `helps`, effects' `escape_dc`; `AttackLine.light_extra_damage_parts` (Two-Weapon Fighting
  keeps the modifier); `Combatant.size`; `makeAttack` options `modes` and `light_extra`;
  `rollAbilityCheck` option `modes`.
- Ability checks and skills: `rollAbilityCheck`, the sheet's `ability_checks`, combatants'
  `ability_checks` and `skills`, the condition field `ability_checks` (Poisoned, Frightened), the
  encounter action `check`. Encounters roll a dying character's Death Saving Throw at the start of
  its turn (`createEncounter({ auto_death_saves: false })` to keep the reminder instead).
- Legendary actions and Legendary Resistance: monster fields `legendary_uses`,
  `legendary_resistance`, and `once_per_round`, `attacks`, `uses` on legendary actions;
  combatants' `legendary_actions` and `legendary_resistance` (a failed save succeeds instead,
  `SaveResult.legendary_resistance`); `MonsterState` `in_lair`, `legendary_resistance_used`,
  `auto_legendary_resistance`. Encounter action `legendary` (after another creature's turn, uses per
  round and in the lair, once-per-round limits), Legendary Resistance counted in encounters,
  `add_monster` `in_lair` and `auto_legendary_resistance`.
- Conditions change rolls: condition fields `attack_rolls`, `attacked`, `attacked_beyond_5ft`,
  `critical_within_5ft`, `fail_saves`, `save_disadvantage`, `initiative`,
  `except_against_source`; `Combatant.condition_rolls`, `conditionRolls`, `attackMode`,
  `resolveMode`. Attacks and spell attacks get Advantage or Disadvantage from both sides'
  conditions (`within_5ft` option; `reasons` in the result), automatic Critical Hits within 5 feet
  on Paralyzed or Unconscious targets; saves fail automatically (`automatic_failure`) or roll
  with Disadvantage; Initiative too. `combatantFromMonster` takes the catalog's `conditions`.
- Encounters track a condition applied with a `source` even without a duration (Grappled's
  exception for the grappler), and drop an effect whose condition was removed.
- `npm run content` reports the bundled SRD's size (minified, gzipped, largest tables) and
  fails when the gzipped size is over the budget (`MAX_GZIP_KB`).
- Encounter turn rules: `attack` (Attack action with Extra Attack / Multiattack, Opportunity
  Attacks, once-per-turn riders), `save_action` (Recharge), `cast` (casting time, prepared
  spells, Concentration spells' conditions as effects), timed effects with durations
  (`effects` with `rounds` / `until`, `end_effect`), automatic Concentration saves on damage,
  Rage ending when not extended (`extends_each_turn` toggles, `extend`). Monsters have
  `multiattack`. `applyEncounterAction` also returns the `result` of an attack, save or cast.
- Encounters: an `Encounter` document and `applyEncounterAction` (add monsters and characters,
  Initiative with surprise and group rolls, turn order and ties, rounds and turns, action /
  Bonus Action / reaction, movement and Dash, `effects` routing attack and spell results to
  monsters and characters, Monster Death), `encounterCombatant`, `currentCombatant`.
  `POST /v1/encounters/apply`.
- Monsters: a `monsters` content table with all 330 SRD stat blocks (`import-srd-monsters.ts`),
  `combatantFromMonster`, and `useSaveAction` for saving throw effects such as breath weapons.
  Combatants have `condition_immunities` (respected by spells and save effects) and
  `save_actions`; attack lines' `ability` can be `null` (monsters).
- Effects, step 1: `damage_riders` (dice, flat or a class table column; automatic or optional;
  Rage Damage, Sneak Attack, Divine Strike), `advantages` (`save.str`…, applied by
  `rollSavingThrow`) and `toggles` (features switched on in play: Rage). Play state `active`,
  actions `activate`/`deactivate`, CLI `on`/`off`; `makeAttack` takes `riders` and
  `ally_adjacent` (also in `POST /v1/state/attack`). Attack lines have `ability`, `weapon`,
  `properties` and `riders`; the sheet has `advantages` and `toggles`.
- Spell `mechanics` (attack or save, damage by type, healing, targets, upcasting, Cantrip
  Upgrade, conditions, area) for 53 reviewed SRD spells (drafted by a parser in
  `import-srd-spells.ts`, each checked against its text), and `castSpell` to resolve them between
  combatants, with the play actions that apply the result. `POST /v1/state/cast`.
- Combatants have `level` and `spellcasting` (save DC, attack bonus, modifier per feature).
- Combatants (`rules/combatant.ts`): `combatantFromCharacter` (build + play state),
  `combatantFromSnapshot` (the old `Character`), `makeAttack` (attack lines, critical range,
  Advantage/Disadvantage, two-handed Versatile damage, a preview of the damage),
  `rollSavingThrow`, `rollD20`. `POST /v1/state/attack` resolves an attack between two
  characters and applies the damage to the target's state.
- The play action `damage` accepts `instances: [{ amount, type }]` instead of `amount`, each
  adjusted for its own type.
- `rules/damage.ts`: `rollDamage`, `adjustDamage` (Immunity, Resistance, Vulnerability) and
  `takeDamage` (Temporary Hit Points, dropping to 0, massive damage, death save failures,
  Concentration DC), shared by the play action `damage` and the combat `applyDamage`.
- Attack lines have `kind`, `damage_parts` and `two_handed_damage_parts` (structured damage,
  ready for `rollDamage`); the `damage` string is built from them.
- Content pack manifests (`pack.yaml`: id, version, ruleset, default `source`, `requires`),
  checked against load order; `catalog.packs` lists them and `GET /v1/content/packs` serves them.
- Patches (`patches.yaml`): `set`, `append` and `remove` on a path of an entity from an earlier
  pack, validated again after patching (`applyPatch`, `PatchSchema`).
- `createCatalog(packs, { sources })` loads only the given sources.
- Builds can list the packs they need (`packs`, optional); a missing one is a validation error.
  The CLI builder records the packs loaded with `--content` when it saves.
- `tests/api.test.ts` snapshots the names each entry point exports.
- `npm run check:sources` (part of `npm run check`): fails if `content/` holds anything but
  the SRD, or if an example or test pack has a `source` other than `srd-5.2.1`, `homebrew` or
  `test`.
- Play state (`CharacterState`, `applyAction`, `computePlaySheet`, `createState`,
  `validateState`, `reconcileState`): HP and temporary HP, dying and death saves, massive damage,
  Short and Long Rests with Hit Dice, spell and Pact slots, limited-use features (`resources` in
  content), conditions and Exhaustion with their sheet effects, Concentration, Heroic
  Inspiration, inventory, equipment, Attunement, charges, coins, and today's picks for "after a
  rest" choices (`rest_change`). CLI `srd-rules play`; HTTP `/v1/state/*`.
- All 275 SRD magic items and the 15 conditions (`scripts/import-srd-items.ts`,
  `npm run content:import-items`). Magic weapons, armor, AC and save bonuses, ability score
  floors and resistances change the sheet.
- Replacements on level-up, following each SRD rule: "whenever you gain a level, you can
  replace one…" features (cantrips and prepared spells of Bards, Sorcerers and Warlocks; Cleric
  and Druid cantrips; Invocations; Metamagic; Mystic Arcanum; the Fighter's Fighting Style;
  Blessed and Druidic Warrior cantrips; Magical Discoveries; Magic Initiate on any level-up)
  get one optional `[old, new]` replacement per level. "After a Long Rest" lists (Cleric,
  Druid, Paladin, Ranger and Wizard prepared spells, Wizard cantrips, Weapon Mastery) are
  single lists that grow with the class and can be changed at any time.
- Override mode: change any past choice, a past level's class (`setLevelClass`) or its Hit
  Points. Picks are judged as of their own level, so later picks that stop fitting are
  removed and asked again while the rest is kept; `previewChange` shows the effect first; every
  setter refuses a change that would leave the character illegal. CLI `edit`; HTTP `preview`,
  `set-level-class`, `set-level-hp`.
- `scripts/import-srd-classes.py` (`npm run content:import-classes`): the generator of class
  levels 2–20, subclasses, invocations, Metamagic and feats.
- Level-up to 20, one level at a time: `levelUp`, `setLevelHp`, `removeLastLevel`,
  `levelUpOptions`; builds store `levels: [{ class_id, hp }]`. Multiclassing with its
  prerequisites, partial proficiencies, combined spell slots and separate Pact Magic.
- Every SRD class feature to level 20 (feature text from the SRD), and the 12 SRD subclasses.
- All 339 SRD spells; Ability Score Improvement, Grappler and the Epic Boon feats; Eldritch
  Invocations and Metamagic (`features` table); feat prerequisites.
- Content schema: `features` by class level, `multiclass`, `progression` (class table columns),
  `subclasses`, `at_class_level`, choice kinds `subclass`, `ability_increase`, `feature`,
  `ability_bonuses`, spell choice `max_spell_level`/`school`/`tag`/`known_only`.
- Sheet: `classes`, `hit_dice`, `attacks_per_action`, `critical_hit_on`, `spell_slots`,
  `pact_magic`, `resources`, `features`; traits carry their source and level.
- HTTP: `POST /v1/builds/set-choice`, `/v1/builds/level-up`, `/v1/builds/remove-level`.
- All 12 SRD classes at level 1 (Barbarian, Bard, Cleric, Druid, Monk, Paladin, Ranger, Rogue,
  Sorcerer, Warlock and Wizard join the Fighter), and a Spells step in the builder.
- The 84 SRD cantrips and level 1 spells (`spells` table, imported by
  `scripts/import-srd-spells.ts`).
- Spell choices (`kind: spell`) filtered by level, class list (or the list another choice picked,
  as in Magic Initiate), and the Ritual tag; `subset_of` for a Wizard's prepared spells.
  Magic Initiate is now fully automated.
- `kind: expertise`; alternative AC calculations (`ac_calculations`: Unarmored Defense, Mage
  Armor); Martial Arts; effect values that use an ability modifier, with a minimum.
- Weapon proficiencies by property (`martial:light`, `martial:finesse`); Weapon Mastery only
  offers weapons you're proficient with.
- The sheet has `spellcasting` (DC, attack bonus, slots), `spells` and `spellbook`, and marks
  skills with Expertise.
- Elf, Gnome and Tiefling lineage spells use the spellcasting ability chosen for the lineage;
  Forest Gnomes always have Speak with Animals prepared.
- Content packs: `createCatalog(srdPack, homebrewPack)` layers homebrew over the SRD.
- `srd-rules validate <dir>` checks a content pack.
- JSON Schemas for every content file and for saved builds (`schemas/`).
- The SRD as one JSON file: `srd-rules-engine/srd-5.2.1.json`.
- HTTP: `GET /v1/content/...` and `POST /v1/builds/evaluate`.
- `seededRng`, `scriptedRng` and `fixedRng` for deterministic dice.

### Removed
- The Python version's `Character` attack and spell functions: `resolveAttack`, `attackRoll`,
  `damageRoll` (use `makeAttack` with combatants, or `POST /v1/state/attack`); the `Spell` model
  (`SpellSchema`, `SPELL_SCHOOLS`) and `spellSaveDc`, `spellAttackBonus`, `castSpellAttack`,
  `castSpellSave`, `castSpellDamage`, `resolveSpellAttack`, `resolveSpellSave` (use `castSpell`,
  or `POST /v1/state/cast`); the routes `POST /v1/combat/attack`, `/v1/spells/attack` and
  `/v1/spells/save`. The other `Character` routes stay, `/v1/spells/stats` included.
- Internal helpers are no longer exported: the package lists its exports explicitly instead of
  `export *` (`answers`, `definedEntries`, `replaceErrors`, `choiceIssues`, `classLevelKey`,
  `entityName`, `mergeGrants`, `inspire`, `combineModes`, `expandConditions`, `titleCase`,
  `choiceStep`, `formatModifier`, `signed`, `catalogItem`, `unassignedValues`, `abilityScore`).

### Fixed
- Ray of Sickness's Poisoned and Color Spray's Blinded lasted until removed; they end at the end
  of the caster's next turn. Guiding Bolt's Advantage on the next attack was dropped.
- `GET /v1/content/magic_items` (and `magic-items`) returned 404: table names with `_` didn't match.
- The Blowgun's fixed damage no longer adds the ability modifier (SRD "Damage Rolls").
- While Petrified, untyped damage is halved too (Resistance to all damage).

[Unreleased]: https://github.com/luigibrb/srd-rules-engine/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/luigibrb/srd-rules-engine/releases/tag/v0.1.0
