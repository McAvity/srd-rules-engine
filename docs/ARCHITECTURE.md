# Architecture

How the engine is built and why. What comes next is in [ROADMAP.md](ROADMAP.md); how to write
content is in [CONTENT.md](CONTENT.md).

## Overview

Three kinds of saved documents, each plain JSON, and rules content as data:

- a **build** (`CharacterBuild`): the player's choices, from which every number is derived;
- a **play state** (`CharacterState`): what's spent or chosen at the table (HP, slots, items…);
- an **encounter** (`Encounter`): a fight's Initiative order, turns, monsters and timed effects.

Every change goes through a function that checks it against the rules and returns a new
document: builder setters for builds, `applyAction` for play states, `applyEncounterAction` for
encounters. Nothing derived is stored: sheets and combatants are recomputed from the documents
and the catalog.

The engine informs; its callers decide. It's meant for any client (an app, a CLI, a bot), so it
reports everything the rules say about an action (every reason it would be refused, the rolls,
the costs) and leaves the policy to the caller: how strictly to play, what to override, what to
roll without resolving. Rules are general primitives, not modes for one way of playing.

| Layer | Module | Responsibility |
|---|---|---|
| Content | `content/**/*.yaml`, `src/content/` | Rules data in packs; schema + cross-reference validation at load |
| Build | `src/models/build.ts` | The player's choices only; immutable |
| Resolution | `src/rules/build-resolution.ts` | Build + catalog → active sources, pending choices, option availability |
| Validation | `src/rules/build-validation.ts` | Errors (illegal), pending (missing), notes (not automated) |
| Sheet | `src/rules/sheet.ts` | Derived numbers with contributions (`AC 17 = 16 Chain Mail + 1 Defense`), attack lines, toggles |
| Builder | `src/services/builder.ts` | Validated setters + normalization |
| Play | `src/models/state.ts`, `src/services/play.ts` | Play state and its actions; the play sheet |
| Combat | `src/rules/damage.ts`, `combatant.ts`, `casting.ts` | Damage, combatants, attacks, spells, saving throw effects (pure) |
| Encounters | `src/models/encounter.ts`, `src/services/encounter.ts` | Initiative, turns, action economy, timed effects |
| UI | `src/cli/`, `src/http/` | Interactive shell and HTTP API; no rules logic |

## Content and packs

Rules content is YAML validated by the Zod schemas in `src/models/content.ts` (published as
`schemas/*.schema.json`). A **content pack** is a folder; the SRD is one
(`content/srd-5.2.1/`), compiled to JSON and bundled.

- **Layering.** `createCatalog(...packs)` layers packs in order: a later pack adds entities and
  replaces earlier ones with the same id. Duplicate ids within one pack are errors.
  Cross-references are checked after layering. The catalog is deep-frozen.
- **Manifests.** A pack's `pack.yaml` gives its id, version, ruleset, default `source` and the
  packs it `requires` (checked against load order); without one, the pack's name is its id and
  default source (`homebrew` without a name). `catalog.packs` keeps the manifests
  (`GET /v1/content/packs`).
- **Patches.** `patches.yaml` edits an entity from an earlier pack by path (`set`, `append`,
  `remove`; list elements by index or `id`). A patch applies to the parsed entity (defaults
  filled in, so paths are stable), and the result is validated again, so a patch can't produce
  an invalid entity or change an id.
- **Sources.** Every entity has a `source`. `createCatalog(packs, { sources })` keeps only the
  entities and patches of those sources (the books a campaign allows). Builds may list the packs
  they need (`build.packs`); a missing one is a validation error.
- **Entry points and partial catalogs.** The main entry (`src/index.ts`) has no content:
  the bundled SRD (`src/content/srd.ts`, the compiled JSON) is `srd-rules-engine/srd`, also
  re-exported by `srd-rules-engine/node` and used by the HTTP handler's default catalog;
  `tests/api.test.ts` walks the main entry's imports to keep it out. The build also publishes
  the SRD split by table (`splitPack`: `manifest.json` with the pack manifest, creation rules
  and patches, plus one `<table>.json` per table); `loadPack(fetchJson, { tables })` reads it
  back with the caller's loader. `createCatalog(packs, { tables })` loads only those tables:
  each one left out is a frozen proxy that throws a `ContentError` naming the table on any
  read (`isLoaded` tells them apart), patches to it are skipped, and `validateReferences`
  skips references into it (the compiled SRD was checked whole). `npm run content` keeps the
  full bundle under `MAX_GZIP_KB` and the core tables a builder starts with (`CORE_TABLES`)
  under `MAX_CORE_GZIP_KB`.
- **Leak guard.** `npm run check:sources` (part of `npm run check`) fails if `content/` holds
  anything besides `srd-5.2.1/`, if a `source` in `content/` or the bundled JSON isn't
  `srd-5.2.1`, or if one in `examples/` or `tests/fixtures/` isn't `srd-5.2.1`, `homebrew` or
  `test`. Non-SRD content lives in separate, private packs.

**Importers.** Most SRD content is generated from the SRD 5.2.1 Markdown (`docs/srd-5.2.1/`,
git-ignored) by scripts that keep the SRD's text and take mechanics from overlay tables:
`import-srd-classes.py` (class levels 2–20, subclasses, invocations, Metamagic),
`import-srd-spells.ts`, `import-srd-items.ts` (magic items, conditions) and
`import-srd-monsters.ts`. Parsers only draft: spell mechanics are used after a review against the
text (`REVIEWED`, `REJECTED`, hand-written `MECHANICS`); the monster importer reads stat block
fields exactly, throws on anything unexpected, and corrects two values the Markdown garbles
(`FIXES`, with the reason). Their `--report` flags list what became data and what stayed text.

## Character builder (level 1)

### Step order

`STEPS` in `src/models/content.ts` defines the order, based on dependencies. Each step only
uses what earlier steps decided, and nothing important is asked before the facts that
constrain it are known. The order follows the 2024 rules (Class → Origin → Ability Scores →
Details), and you can move freely between steps.

1. **Class**: sets the primary ability, saves, armor training and skill list.
2. **Species**, including size, lineage and legacy (sub-choices that change speed,
   darkvision and resistances).
3. **Background**: sets which abilities can be raised, plus the origin feat, skills and tool.
4. **Ability scores**: standard array, point buy or 4d6, then the background's +2/+1 or
   +1/+1/+1. This comes after class and background so the builder can recommend where scores go.
5. **Equipment** comes before features so Weapon Mastery can mark weapons you carry and
   Fighting Style can preview its AC or attack effect.
6. **Features**: Fighting Style, Weapon Mastery, Divine/Primal Order, Eldritch Invocation, the
   Human Versatile feat, and feat sub-choices.
7. **Spells** comes after features because a feature can decide which list you pick from
   (Magic Initiate's list, Thaumaturge's extra cantrip, Pact of the Tome).
8. **Skills & tools** comes late so every fixed grant (background, species, feats) is known
   before free picks are spent. Duplicates are greyed out.
   Expertise is asked last within the step, once every proficiency is known.
9. **Languages.**
10. **Name & alignment** is last because nothing depends on it.

You can jump to any step. If a change upstream makes a later choice invalid,
`normalize` in `src/services/builder.ts` removes it and says why. For example, switching to Criminal
removes Stealth from Skilled.

### Sources and choices

A **source** is anything that grants something: base creation rules, the class, the species,
a chosen option (Wood Elf), the background, a feat, or an equipment package. Each source has
`Grants` (skills, tools, effects, items, …) and may declare **choices**. Answering a choice can
activate more sources. For example, Human → Versatile → Skilled adds a
"choose 3 skills or tools" choice.

Keys are flat strings so the build can store answers without nesting:

- `class:fighter#skills`
- `species:elf#lineage` (the answer `wood-elf` activates source `species:elf#lineage=wood-elf`)
- `feat:skilled@species:human#versatile#proficiencies`

Validation and the UI both use `Resolution.options(choice)`. It lists every option together
with the reason it's unavailable, if any, so the rules for what can be picked live in one
place.

### Effects

Grants change numbers and rolls declaratively:

- **Numeric effects** (`effects`): `Effect{target, op: add|set|max|min, value: int|"prof"|
  "half_prof"|ability, min, when}`. An ability value means that ability's modifier; `min` is a
  floor (Thaumaturge: "Wisdom modifier, minimum of +1"). `target` and `when` are closed lists
  (`EFFECT_TARGETS`, `EFFECT_CONDITIONS`; the table is in [CONTENT.md](CONTENT.md#effects)):
  anything else is rejected at load, and the sheet's lookups are typed against the same lists.
  `when` knows what the character wears (`wearing_armor`, `unarmored`…).
- **Damage riders** (`damage_riders`): extra damage on the attacks they apply to (by ability,
  weapon or Unarmed Strike, weapon property or kind). The amount is dice, a flat bonus, or a
  column of the source class's table read at its current level (Rage Damage, Sneak Attack).
  Automatic riders become a damage part of every matching attack line; optional ones are listed
  on the line (`riders`) and `makeAttack` adds them on request, checking `requires:
  advantage_or_ally` and asking for the damage type when there's a choice. The latest rider with
  an id wins (Divine Strike 1d8 → 2d8 at Cleric 14).
- **Advantage** (`advantages`: `save.<ability>`, `check.<ability>`): listed on the sheet with
  its source; `rollSavingThrow` applies it and cancels it against Disadvantage.
- **Toggles** (`toggles`): features switched on in play (Rage). Their grants apply while active,
  which covers "while raging" without a new `when` condition (see "Play state").

**Armor Class** is not a sum of effects: features like Unarmored Defense and Mage Armor are
*alternative* calculations that never stack with each other or with armor. Content declares
them as `ac_calculations` (`base` + ability modifiers, whether a Shield still applies). The
sheet evaluates every legal configuration (each owned and trained armor, or no armor with each
calculation; with or without a Shield), including conditional effects such as Defense, and
picks the highest. Ties go to the simpler option.

### Spell choices

Spells are content (`spells.yaml`: level, school, class `lists`, ritual, concentration, full
text, and `mechanics` for casting; see "Casting spells"). A class declares `spellcasting`
(list, ability, slots, `pact` for Warlocks) and its picks as `kind: spell` choices:

- `spell_level` and `spell_list` filter the options; `ritual: true` keeps only rituals.
- `spell_list: $spell_list` takes the list from a sibling choice's answer (Magic Initiate); a
  `spellcasting.ability` can do the same (`$spellcasting_ability`).
- `subset_of: spellbook` limits options to what a sibling choice picked (a Wizard prepares from
  the spellbook). The sheet lists the pool as `spellbook`, not as prepared spells.
- `always_prepared: true` marks picks that don't count against a class's limit (Magic
  Initiate, Pact of the Tome); `grants.spells` does the same for fixed spells (Hunter's Mark,
  Speak with Animals).
- A spell you already have from any other source is unavailable ("already known from Ranger"),
  except between a pool and its subset.

## Levels and multiclassing

A character is created at level 1, then gains levels one at a time. The build stores each level after the first as `{ class_id, hp }` (`hp: null` = the
fixed value, hit die / 2 + 1; a number = the stored Hit Die roll), so any level can be
recomputed or undone.

**Class content** has three parts:

- `grants`: core traits you get only when it's your first class (saves, skills, gear);
- `multiclass`: what you get instead when you multiclass into it (SRD "As a Multiclass
  Character");
- `features`: grants by class level, `1`–`20`. Level 1 features apply either way.

**Sources by level.** The first level in a class is the source `class:<id>` (core or multiclass
grants merged with level 1 features), so level 1 choice keys are the same as before; later
levels are `class:<id>:<class level>`. A `kind: subclass` choice picks the subclass, whose
features are sources `subclass:<id>:<class level>`. Every source and choice knows the character
level it was gained at, so the builder can ask each level's choices in order and validation
reports issues per level. `at_class_level` switches on more grants when the class reaches a
level (a subclass's spell table, the Land druid's resistance, Improved Blessed Strikes).

**Multiclassing** (SRD "Multiclassing"): taking a new class needs a score of 13+ in the primary
abilities of the new class and every class you have (`primary_mode: all` classes need all of
them). Spell slots come from the Multiclass Spellcaster table (in `creation.yaml`): full casters
count every level, Paladins and Rangers half (rounded up). The single-class Paladin and Ranger
tables match that formula, and a test checks it. Pact Magic slots are separate. Each class's
spell choices use that class's own table (its "levels you have slots for"). Extra Attack from
several classes doesn't stack (effects use `op: max`), and AC calculations never stack.

**Ability scores** are recomputed in level order: base scores, background bonus, then every
Ability Score Improvement, feat increase and fixed bonus (Primal Champion), each capped (20, or
the feat's own cap such as 30 for Epic Boons). Prerequisites are checked against the scores
from before the level where the choice is made.

**Feats and feature options** have prerequisites: character level, class level, ability scores,
other feats or features, a trait (Fighting Style feats need the Fighting Style feature),
Spellcasting, or knowing one of some spells. Eldritch Invocations and Metamagic options have the
same shape as feats but live in their own `features` table, so an Ability Score Improvement
("any feat you qualify for") can't pick one.

### Changing choices: replacements and lists

The SRD has two kinds of "change it later" rule, modeled differently:

- **"Whenever you gain a level, you can replace one…"** (history matters: you can't swap
  everything at once, and a spell swapped in at level 5 may be of a level you didn't have at
  level 1). The family's choices share a `tag` and have `swap: class_level` (or `any_level` for
  Magic Initiate). At each later qualifying level the engine adds an optional replacement choice
  (`<level source>#replace:<scope>:<tag>`) whose answer is `[old, new]`. Its new options are
  those of the family's latest choice at that level (so level and list upgrades apply);
  `same_level` keeps the spell level (Mystic Arcanum, Magic Initiate). A replaced Eldritch
  Invocation can't be one another invocation requires.
- **"After a Long Rest you can change…"** lists are one choice with `scaling`: count (and
  maximum spell level) by class level. You can re-pick them at any time; a level-up just makes
  them bigger.

A `SwapLedger` replays each family in level order (picks, then replacements) and
`Resolution.contributed(choice, atLevel)` gives what each choice really provides. When any
replacement is stored, `resolve` runs twice so that a replaced invocation's feature source (and
its own choices) disappears and the new one appears at the replacement's level.

### Changing the past (override mode)

Every setter works on any level, and three rules keep the result a legal character without
wiping everything after the edited level:

1. **A pick is judged as of its own level.** "Already proficient / known / have this feat" only
   counts what the character had at that level (choices at the same level count both ways;
   "after a rest" lists are judged now). So an edit to level 3 can take something a later level
   also took, and the *later* pick gives way.
2. **Repair, don't wipe.** `normalize` walks choices in level order and removes only picks
   whose source disappeared or that became illegal; everything else is kept, and the removed
   picks show up again as pending questions.
3. **Refuse what repair can't fix.** After applying and repairing, `commit` validates the whole
   build; any error that wasn't there before (a later multiclass level whose prerequisite is no
   longer met, say) makes the change fail with the validator's own message, and the build is
   unchanged. The guard has no rules of its own, so anything the validator checks is enforced.

`previewChange` runs a change and diffs the result (picks removed, new pending questions) so
UIs can ask for confirmation. `previewOption(build, catalog, key, value)` lists the sheet numbers
one option would change (AC, HP, Initiative, Speed, Passive Perception, ability scores), against
the choice left unanswered, for a builder to show next to the option. `setLevelClass` changes a past level's class: class features follow
the Nth level *in* a class (`class:fighter:3`), so they move along with their choices.

## Play state

The build holds characteristics; a separate `CharacterState` (`src/models/state.ts`) holds what
changes at the table: HP (`current: null` = at the maximum, so it follows level-ups), temporary
HP, spent Hit Dice, death saves, conditions, Exhaustion, Concentration, Heroic Inspiration, spent
slots and uses, active toggles, the inventory, coins, and `choices`: today's picks for choices
marked `rest_change` (prepared spells, Weapon Mastery…). The state stores only what's *spent* or
*chosen*; maxima always come from the build, so they never go stale.

- **Actions** (`PlayActionSchema`, plain JSON) go through `applyAction(build, state, catalog,
  action, { rng })` → `{ state, notes }`, or throw `PlayError`. After every action the result is
  passed through `reconcileState`, so an accepted action can't leave an invalid state.
- **The played build.** `playBuild` overlays `state.choices` on the build (only for
  `rest_change` choices); `computePlaySheet` computes the sheet from it with a `PlayContext`
  (carried items, active conditions, Exhaustion, active toggles), then adds the live `play`
  block and, on each spell, the slots it can be cast with now (`spellSlots`, shared with the
  encounter's options: every level it could use, those with none left included with a reason). A rest-change pick is validated by running the builder's `setChoice` on the played
  build, so it follows exactly the same rules as a build pick; a UI lists those choices' options
  by resolving the played build (`playBuild` is public), so they match what `set_choice` accepts.
- **Starting equipment.** `createState` puts the build's starting equipment (the armor and
  Shield the sheet picks worn) and gold in the inventory and sets `starting_equipment: true`. A
  state made before the build had its equipment (an app creating the state with a new, empty
  build) has `false`; the play action `take_starting_equipment` adds the kit once, and the play
  sheet's `starting_equipment_taken` tells an app to offer it (`startingEquipment(build,
  catalog)` lists what it would add). States saved before the field existed read as taken when
  the inventory or purse isn't empty, so no kit is ever added twice.
- **Buying and selling.** Gear, tools, weapons and armor have their SRD price (`cost`, gear
  per `bundle`: 20 Arrows for 1 GP) and weight. The play action `buy` pays the price from the
  coins (`rules/currency.ts` `pay`: the smallest coins first, one larger coin broken for change
  in gold, silver and copper) and adds the items; `sell` gives half the price (SRD "Selling
  Equipment") in gold, silver and copper; `price` sets another (a deal, a magic item). Carried
  weight counts gear and tools too (a bundle's weight shared by its items).
- **Items.** An inventory entry points at a catalog item; magic items made from a mundane one
  store its `base` (Weapon, +1 → `longsword`; `magicItemBases` lists the allowed ones) and kinds
  a `variant`. A magic item is *active*
  when worn/held (or carried, per `active_when`) and attuned if required; active items become
  sources, so their grants use the same machinery as feats. A magic weapon's bonus applies to
  its attack line whenever attunement allows (you wield it to attack). With a play context, AC
  comes from the equipped armor and Shield instead of the best armor owned.
- **Conditions** are data: `implies` (Unconscious → Incapacitated, Prone) and `speed_zero`.
  Exhaustion is a level on the state; the sheet applies −2 per level to d20 tests and −5 ft per
  level to speed. Incapacitated ends Concentration.
- **Toggles.** `state.active` holds the keys of toggles switched on (like resources:
  `barbarian:rage`); `activate` spends the toggle's `uses`, `deactivate` ends it, and active
  toggles are sources, like magic items. `reconcileState` ends a toggle whose `blocked_when`
  effect condition holds (Heavy armor) or whose `ends_on` condition is active (Incapacitated);
  `no_spells` drops Concentration, refuses new Concentration and makes the combatant unable to
  cast. In an encounter, `extends_each_turn` toggles also end at the end of a turn they weren't
  extended in (see "Encounters").
- **Build changes** don't touch the state; `reconcileState` clamps spent resources, drops
  rest-change picks that no longer fit, ends attunements that are no longer allowed and toggles
  that are gone.

## Combat

Combat is pure functions over **combatants**; they never change a document themselves. They
return rolls, damage instances and the play actions that apply them, and the caller (or an
encounter) applies those to each target's own document.

### Damage

`rules/damage.ts` holds the damage rules, shared by play, combat and encounters:

- `rollDamage(parts, { critical, rng })` rolls `DamagePart`s (`{ dice, bonus, type }`). A
  Critical Hit doubles each part's dice, not its bonus; a part never goes below 0.
- `adjustDamage` applies Immunity, then Resistance (halved, rounded down), then Vulnerability
  (doubled), per instance and per type; `"all"` covers every type, including untyped damage
  (Petrified). Several Resistances to one type count once.
- `takeDamage(vitals, instances, defenses, { critical })` sums the adjusted instances, takes
  Temporary Hit Points first, and reports dropping to 0, dying (massive damage, or damage at 0
  HP at least the maximum), Death Saving Throw failures and the Concentration DC. The caller
  updates its own state (conditions, death saves, Concentration).
- `isBloodied(hp, maxHp)`: at half the Hit Point maximum or fewer (Rules Glossary "Bloodied"),
  0 HP included, Temporary Hit Points not counted. Combatants carry it (`bloodied`), and so does
  the play sheet (`play.hp.bloodied`).

Every attack line on the sheet carries its damage as parts (`damage_parts`, and
`two_handed_damage_parts` for Versatile weapons), and its display string is built from them.
A fixed damage amount (the Blowgun's 1) gets no ability modifier (SRD "Damage Rolls").

### Combatants and attacks

A `Combatant` (`rules/combatant.ts`) is what combat needs to know about a creature: AC, HP and
Temporary HP, saving throw bonuses, damage defenses, conditions and condition immunities, attack
lines, critical range, attacks per action, spellcasting (DC, attack bonus, modifier per
feature), Advantage, saving throw effects. It's a read-only view built from something else:
`combatantFromCharacter(build, state, catalog)` (from the play sheet),
`combatantFromMonster(monster, state)` (a stat block), `combatantFromSnapshot(character)` (a
hand-filled `Character`), or `encounterCombatant(encounter, id, ctx)`.

`makeAttack(attacker, attackName, target, { mode, two_handed, riders, ally_adjacent, rng })`
rolls the d20 (twice with Advantage or Disadvantage), decides hit and Critical Hit, adds the
requested riders, rolls the damage parts, and previews `takeDamage` on the target.
`rollSavingThrow` rolls a save with the combatant's bonus and Advantage. `POST /v1/state/attack`
does an attack between two characters and applies it.

**Conditions change rolls.** Conditions carry their effects on rolls as data (`attack_rolls`,
`attacked`, `attacked_beyond_5ft`, `critical_within_5ft`, `fail_saves`, `save_disadvantage`,
`initiative`), and every combatant has them merged in `condition_rolls` (`conditionRolls`,
implied conditions included; `combatantFromMonster` needs the catalog's `conditions` for it).
`attackMode` combines the caller's `mode` with the attacker's and the target's conditions: any
Advantage and any Disadvantage together make a normal roll (`resolveMode`), and the result lists
the reasons ("Advantage: Goblin Warrior is Prone (within 5 ft)"). `makeAttack` and spell attacks
use it, with `within_5ft` defaulting to true for melee attacks and false for ranged ones; a hit
on a Paralyzed or Unconscious target within 5 feet is a Critical Hit. `rollSavingThrow` fails
Strength and Dexterity saves without a roll while Paralyzed, Petrified, Stunned or Unconscious
(`automatic_failure`), and gives Disadvantage on Dexterity saves while Restrained. Sneak Attack's
requirement uses the combined mode.

**Ability checks.** `rollAbilityCheck(combatant, { skill } | { ability }, dc)` uses the skill's
bonus (the sheet's skill lines: proficiency, Expertise, Jack of All Trades; a monster's listed
skills, else its ability modifier) or the ability's (`ability_checks` on the sheet: the modifier,
`checks` effects, Exhaustion). Advantage from features (`check.str` while raging) and conditions
(Poisoned, Frightened: Disadvantage, from the condition field `ability_checks`) combine as for
other rolls; without a DC, `success` is `null` (a contest, or the GM decides).

**Rolls on their own.** `rollD20Test(combatant, { skill } | { ability } | { save } | { attack },
{ dc, mode, rng })` is a sheet's roll button: a check, a saving throw (a DC optional) or an
attack roll with no target (the attacker's side of `attackMode` only; `dc` is an AC), each with
the modes its features and conditions give and the reasons. It offers nothing to spend
(Indomitable, Legendary Resistance, Bardic Inspiration: no `decide`). `rollCheck(build, state,
catalog, …)` rolls it for a character from its play state.

### Casting spells

Catalog spells can carry `mechanics` (attack or save, damage by type with a flat bonus,
healing, targets, upcasting, Cantrip Upgrade, conditions with their duration, area, darts or
rays, a follow-up save, hit riders, a damage type the caster picks, a lasting area). `castSpell(caster, spell, targets, { slot_level, pact,
spellcasting, mode, modesFor, nearby, rng })` in `rules/casting.ts` resolves them between
combatants: a spell attack per target (per beam or ray: Eldritch Blast, Scorching Ray), or a
save with the damage rolled once for all targets; darts that hit automatically (Magic Missile);
healing; conditions on a hit or a failed save (not for a target immune to them). Beams, rays
and darts go at one target or one `targets` entry each, so a target given twice takes two. A
follow-up save (Ice Knife) comes after the attack, hit or miss, for the target and `nearby`
(`follow_up`); a hit's riders are in `targets[i].on_hit`. `modesFor(target, shot)` gives
Advantage or Disadvantage to one spell attack roll. It returns each target's result (`target`:
its index in `targets`, `id`: its combatant id in an encounter, `name`) with the play actions that apply it (`targets[i].actions`) and the caster's (`spend_slot` or
`spend_pact_slot`, `set_concentration`). `POST /v1/state/cast` checks
that the caster has the spell and applies everything to the states.

The spellcasting feature used is the one asked for, else the one with the best save DC whose
spell list has the spell, else the best overall (a species' fixed spells). A character's spell
says which feature it's cast with (`SpellLine.spellcasting`: the Spellcasting of the class or
subclass feature that gives it, or a feat's own); a roll by hand (`roll`'s `cast`) and an
encounter `cast` take `spellcasting` and, without one, use the spell's when it has exactly one.
So a Bard spell that's also on the Sorcerer list is cast as a Bard spell, and a Sorcerer's
bonuses scoped to "your Sorcerer spells" (Innate Sorcery, kenli K-001) don't reach it. A spell
given by two features (a validation error) lists both and is cast as `castSpell` picks unless
the caller names one. A monster casts through its action (`via`); another `spellcasting` is
refused. A spell without
`mechanics` is still cast (slot, Concentration) with a note that its effects are in the text.

84 SRD spells have mechanics: hand-written entries (golden spells with worked tests, zones,
walls, marks and smites) and drafts from the importer's parser reviewed against their text, a
few corrected by hand (`tests/casting.test.ts` snapshots them all). The other 255 are cast with
their text: 204 have nothing to model (utility spells), and 51 have effects the parser
deliberately doesn't guess (damage after casting, several saves, tables…). Marks (`mark`:
Hunter's Mark, Hex) are encounter marks that add their dice to the caster's attack hits on the
target while it concentrates, moved with `move_mark` once the target drops; a smite (`after_hit`:
Divine Smite) is cast right after a melee hit this turn, on the creature hit, its dice doubled if
the hit was a Critical Hit, with `bonus_vs` dice against some creature types; a condition with
`ends_on_damage` ends when its creature takes damage (Mass Suggestion).

### Monsters

`monsters` is a content table (330 SRD stat blocks, generated by
`scripts/import-srd-monsters.ts`; 423 attack rolls and 163 saving throw effects structured, the
rest as SRD text). `tests/monsters.test.ts` checks every stat block's invariants (HP dice, saves,
PB by CR, Passive Perception, damage averages) and compares 15 golden stat blocks field by field
with the Markdown.

`combatantFromMonster(monster, { hp, temp_hp, conditions })` turns a stat block into a combatant:
its attacks become attack lines (`ability: null`), its Multiattack the number of attacks per
action, its saving throw effects `save_actions`, its condition Immunities
`condition_immunities`. `useSaveAction(user, name, targets)` resolves a breath weapon like a save
spell (one damage roll, half per type on a success, conditions on a failure).

**Legendary actions and Legendary Resistance.** A stat block's `legendary_uses` (per round, and
in its lair) and `legendary_resistance` (per day, and in its lair) are read from its text, and
each legendary action records whether it's once per round, the attacks it makes and another
action it uses. A combatant's `legendary_actions` list them (their own saving throw effects are
only there, not in `save_actions`), and `legendary_resistance` holds the uses left:
`rollSavingThrow` turns a failed save into a success while it's above 0, automatic failures
included, and marks the result (`legendary_resistance`). `MonsterState` gives `in_lair`, the uses
already spent, and `auto_legendary_resistance: false` to leave the choice to the GM.

**Monster spellcasting.** The importer reads every action that casts spells into `casts`
(ability, save DC, attack bonus, and the spells as catalog ids with a fixed `level` and
per-spell `per_day`): the Spellcasting action's lists ("At Will", "1/Day Each"), actions that
cast one of a few spells ("Divine Aid (2/Day)", "Protective Magic"; "using the same
spellcasting ability as Spellcasting" copies its numbers), and legendary actions that "use
Spellcasting to cast" one. An action's "(N/Day)" becomes `per_day`. Sentences it can't read
safely stay text and are listed by `--report` (the Pit Fiend's two Fireballs, the Unicorn's
touch); a misspelled spell name is corrected in `SPELL_NAME_FIXES`. `monsterSpells(monster)`
lists them with their limits, and `combatantFromMonster` gives one spellcasting line per casting
action, named after it, so `castSpell(…, { spellcasting: "Spellcasting" })` resolves a monster's
spell like a character's.

### Encounters

An `Encounter` (`src/models/encounter.ts`) is its own saved document: combatants, the Initiative
order, the round and whose turn it is, what each combatant has spent this turn (action, Bonus
Action, reaction, movement, attacks left, once-per-turn riders), expended recharge abilities, and
timed effects. Monsters live in it (catalog id, current HP, Temporary HP, conditions,
Concentration, `defeated`); characters are referenced by a key into the caller's characters
(build + state), so their HP and conditions stay in their `CharacterState`.

`applyEncounterAction(encounter, action, { catalog, characters, rng })` → `{ encounter, states,
notes, result }`, or `EncounterError`. `states` holds the character states the action changed;
`result` is the roll of an `attack`, `save_action`, `cast`, `check`, `unarmed` or `escape`. `POST /v1/encounters/apply` runs a
list of actions.

**A character's own catalog.** A character may be built on other content than the encounter (another
version of a pack): its `CharacterRef` can carry `catalog`. Then everything about that combatant
comes from its catalog: its sheet, defences and resistances, the spells it knows and casts, what
they cost, its species and size; the effect of an action on it is settled by its catalog too (the
actor's dice, DC and attack bonus carry over). Monsters, their conditions, `add_monster` and the
map use the encounter's `catalog`. `catalogOf(ctx, combatant)` says which. Without `catalog`
(the default) every character uses the encounter's catalog, as before. Every step of an action,
and a caller passing states on to the next action or `replayHistory`, keeps the whole reference
(`{ ...ref, state }`). Nothing falls back to another catalog: an id the judging catalog lacks is
refused.

- **Setup and order:** `add_monster` (average or rolled HP), `add_character`, `remove`,
  `roll_initiative` (d20 + Initiative bonus; Disadvantage when surprised; one roll per group of
  identical monsters), `set_initiative`, `set_order` (ties only), `start`, `next_turn`, `end`.
- **Economy:** `use` (action, Bonus Action or reaction), `move`, `dash`. An action, Bonus Action
  and movement only on your turn; a reaction at any time, once until the start of your next
  turn; nothing while Incapacitated; movement up to your Speed (0 while a condition sets it to
  0), plus your Speed again with Dash.
- **Resolving in one step:** `attack` (the first attack of a turn uses the action; Extra Attack
  or a monster's Multiattack allow more; `reaction: true` is an Opportunity Attack; once-per-turn
  riders are enforced, and each turn, anyone's, resets them), `save_action` (a monster's saving
  throw effect; one with a Recharge is `expended` and rolled for on a d6 at the start of the
  monster's turns) and `cast` (the casting time decides the action, Bonus Action or reaction;
  the caster must have the spell). A monster casts through the action that lists the spell
  (`via` when several do): the action's section decides the economy, the spell is cast at its
  listed level only, and daily uses (`daily_used`, by action and by `<action>#<spell>`) and the
  action's Recharge are enforced; a spell with a casting time of a minute or more is refused.
  `legendary` casts a legendary action's spell. A monster's "(N/Day)" attacks and saving throw
  effects count `daily_used` too.
- **Standard actions:** `dodge` (until the start of its next turn, attack rolls against it have
  Disadvantage and it has Advantage on Dexterity saves; not while Incapacitated or at Speed 0),
  `disengage` (an `attack` with `opportunity: true` against it is refused this turn), `dash`;
  each takes `bonus_action: true` for a feature that allows it (Cunning Action). `help` records
  (`encounter.helps`) Advantage on the next attack roll by one of the helper's allies against an
  enemy, or, with a skill the helper is proficient in, on an ally's next check with it; the next
  such roll uses it up, and it expires at the start of the helper's next turn. `unarmed` is an
  Unarmed Strike's Grapple or Shove, in place of one attack: the target makes a Strength or
  Dexterity save against 8 + Strength modifier + Proficiency Bonus (no more than one size larger
  than the attacker), or is Grappled (an effect with the grappler as source and `escape_dc`) or
  pushed 5 feet or knocked Prone. `escape` (the action) is an Athletics or Acrobatics check
  against the escape DC; a grapple also ends when the grappler is Incapacitated. `stand` spends
  half the Speed to end Prone. `attack` with `light_extra` is the Light property's extra attack:
  a Bonus Action after attacking with a Light weapon in the Attack action, with a different
  Light weapon, using the line's `light_extra_damage_parts` (no positive ability modifier unless
  the Two-Weapon Fighting feat).
- **Hide, Search, Ready and the other actions.** `hide` (the action, or `bonus_action`) is a
  DC 15 Dexterity (Stealth) check; with positions it needs Three-Quarters or Total Cover from
  every enemy that isn't Incapacitated, unless the caller says it's Heavily Obscured
  (`obscured: true`). On a success the combatant has the Invisible condition (an effect labeled
  `Hidden`) and `hidden` holds its total; it stops being hidden when it makes an attack roll,
  casts a spell with a Verbal component, is found, or with `reveal`. `search` is a Wisdom check
  (Perception by default) that finds the hidden enemies (or the `target`) whose total it equals
  or beats. `ready` takes the action and stores the trigger and the action to take (`readied`:
  an attack, an Unarmed Strike, a spell with a casting time of an action, a move, Help) until the
  start of the combatant's next turn; a readied spell is cast at once (slot or daily use spent)
  and held with Concentration, and dissipates if Concentration ends. `release` takes the readied
  action with the reaction, outside the combatant's turn (a readied move up to its Speed, not
  counted in its turn's movement). `study` (Intelligence), `influence` (Charisma or Wisdom; a
  monster's DC is 15 or its Intelligence score, whichever is higher) and `utilize` take the
  action.
- **Features used in turns:** `feature` uses a character's `sheet.actions` entry: its economy
  (action, Bonus Action, reaction, or free on your turn) and resource are spent (through the play
  action `use_feature`), then it heals (Second Wind; Lay On Hands from its pool, on any creature),
  gives one additional action after the first (Action Surge; `surged`: that action can't cast a
  spell), takes standard actions along (Patient Defense: Disengage and Dodge), grants attacks
  used with `attack` `granted: true` (Flurry of Blows), forces a save after a hit this turn
  (Stunning Strike: Stunned until the start of the monk's next turn), or gives a Bardic
  Inspiration die (`inspiration`), which its holder can add to a failed attack roll, saving throw
  or check (a decision, below). A target with Uncanny Dodge or Deflect Attacks is offered it when
  an attack hits it. A feature can take several `targets` of some creature types within a range
  (Turn Undead), use the class's spell save DC (Channel Divinity), deal damage on a failed save
  (half on a success, a damage type chosen with `damage_type`: Divine Spark), last some rounds
  and end on damage or when its user is Incapacitated, mark the target on a successful save
  (Stunning Strike: Speed halved and Advantage against it), or remove conditions (Lay On Hands:
  Poisoned). Indomitable is a decision on a failed save. An `attack` can add Cunning Strike
  effects (`cunning`: Poison, Trip, Withdraw; one, two with Improved Cunning Strike), paid with
  Sneak Attack dice taken off before the roll (`makeAttack`'s `forgo`), with saves against 8 +
  Dexterity modifier + Proficiency Bonus after the damage; or Brutal Strike effects (`brutal`:
  Forceful, Hamstring, and at level 13 Staggering and Sundering; two at 17), which need Reckless
  Attack, forgo the roll's Advantage (`forgo_advantage`; refused with Disadvantage) and add 1d10
  (2d10 at 17) of the weapon's type. Hamstring, Staggering and Sundering Blows are encounter
  marks until the start of the barbarian's next turn. Relentless Rage is a decision when a
  raging barbarian would drop to 0 Hit Points without dying: a Constitution save, DC 10 + 5 per
  use since its last rest (a resource that recharges on a Short Rest); on a success its Hit
  Points become twice its Barbarian level instead. An effect can repeat its save at the end of
  each of the target's turns (`repeat_save`: Cunning Strike's Poison).
- **Positions (optional).** A combatant's `position` is its square on a 5-foot grid (`place`,
  or `move` with `to`), top-left for a creature larger than Medium (Large 2×2, Huge 3×3,
  Gargantuan 4×4: `spaceForSize`, and `space` on every `Combatant`). `gridDistance` counts squares to the nearest square of the other space,
  diagonals like any other step (SRD "Playing on a Grid"). When attacker and target both have
  positions, the encounter measures: a melee attack needs the target within its line's `reach`
  (5 ft, 10 with Reach, a monster's listed reach); a ranged or thrown (`thrown: true`) attack
  has Disadvantage beyond normal range, can't go past long range, and has Disadvantage with an
  enemy within 5 ft that isn't Incapacitated (spell attacks too); "within 5 feet" (Prone,
  Paralyzed) and Sneak Attack's ally next to the target are measured; a spell's range ("60
  feet", Touch) is checked; Unarmed Strike and Help need 5 ft. Moving to a square costs its
  distance, can't end in another creature's space, and notes the enemies whose reach it leaves
  (an Opportunity Attack, unless the mover Disengaged). Without positions, the caller says what's
  within 5 feet or in range, as before. That's the default (`positions: optional`); the GM can set
  `positions: required` (`set_positions`): once anyone is on the map, an action that checks reach
  or range (attacks, ranged spells and their area points, save effects with targets, Help,
  Grapple and Shove, features with a range) is refused when the actor or a target isn't on it
  (refusal code `off_map`). Cover can be given per attack (`cover`) or per target
  (`cast`, `save_action`): +2 or +5 to AC and Dexterity saves, Total Cover can't be targeted;
  with positions and no cover given, it's worked out from the map (below).
- **Exploring.** Before the fight starts and after it ends (`round: 0`) a `move` has no turns and
  no limit: anyone moves along the planned path (walls, blocked squares, Difficult Terrain and
  other creatures as in a fight, no Opportunity Attacks), and the note and `previewMove`'s
  `turns` say how many turns of Speed it takes (`turnsFor`: about 6 seconds each). The group's
  travel pace (`pace`, `set_exploration`) gives Disadvantage (Fast) or Advantage (Slow) on Wisdom
  (Perception) checks, so −5 or +5 to Passive Perception (`combatantPassivePerception`).
- **Points of interest.** `encounter.points` are places the GM prepared (`add_point`,
  `update_point`, `remove_point`): a title, a `kind`, text for the players, notes for the GM,
  `revealed` (hidden until the GM reveals it; the notes never name a hidden point, since the log
  is everyone's). With a `dc`, a character notices a hidden point it sees (`pointsInSight`:
  within its `within` feet, no Total Cover from walls or blocked squares to its square) when its
  Passive Perception is at least the DC, after a move, a placing, or a change to the points;
  `search` with Perception finds those its check total reaches. Noticing adds it to
  `noticed_by` and never reveals it: that's the GM's. Outside a fight a move stops where the
  mover notices one; with `notice_stops: everyone` (the GM's choice) every move then waits
  (`halted`, refusal code `halted`) until the GM reveals it or `resume`s.
- **The map.** `encounter.map` holds walls (segments between grid corners: corner `x,y` is the
  top-left corner of square `x,y`), Difficult Terrain squares and blocked squares (a pillar,
  solid rock); `set_terrain`, `add_wall` and `remove_wall` change it (the GM's actions, no
  economy). The pure grid rules are in `src/rules/grid.ts` (`gridDistance`, `straightPath`,
  `stepBlocked`, `stepCost`, `findPath`). A step costs 5 feet, or 10 when a square it enters is
  Difficult Terrain: the map's, a zone's whose spell says so (`zone.difficult`: Web, Grease,
  Spike Growth, Sleet Storm, Black Tentacles, Insect Plague), or another creature's space that
  isn't an ally's or a Tiny creature's (SRD "Moving around Other Creatures"). A creature passes
  through an ally, an Incapacitated creature, a Tiny one or one two sizes larger or smaller;
  any other creature's space, a wall or a blocked square stops the step. A `path` is checked
  step by step; a move `to` a square goes straight when nothing blocks it, else along the
  cheapest path (A* over the 8 neighbours, deterministic ties, so a replayed decision moves the
  same way), refused with its cost when it's too far ("can't reach 4,7 (needs 40 ft, 30
  left)"). An enemy whose reach the mover leaves at any step is noted for its Opportunity
  Attack. A move can't end in a blocked square, nor can `place`.
- **Monster traits in turns.** Traits the importer reads from their exact sentences act in
  encounters: a damage aura (`aura`: Fire Aura, Heat Aura) hits the creatures in its Emanation at
  the end of the monster's turn (only its enemies when the trait says "of its choice"; not while
  Incapacitated when it says so); a Death Burst (`trigger: death`, with its `save`) makes the
  creatures around it save when it dies; Regeneration (`regeneration`) gives Hit Points back at
  the start of its turns unless it took the damage types that stop it, and a regenerating
  monster at 0 Hit Points is Unconscious, not dead, until it starts a turn there unable to
  regenerate; Aura of Authority (`advantage_aura`) gives the monster and its allies within it
  Advantage on attack rolls and saving throws. Without positions, auras and bursts are noted.
- **Wall spells.** A spell with `mechanics.wall` is placed with `cast` `wall: { from, to }`
  (straight, up to its length, both ends within range) and leaves a zone for its duration
  (Concentration). Wall of Force, Stone and Ice stand on grid lines between squares
  (`segments`): nothing moves through them and they block lines (Total Cover, areas). Blade
  Barrier, Wall of Thorns and Wall of Fire fill the squares of the line (`wall_squares`): the
  creatures in them save when it appears, then on entering or ending a turn there; Blade Barrier
  gives Three-Quarters Cover to lines through it and is Difficult Terrain, Wall of Thorns costs 4
  feet per foot moved (20 feet a square) and its later damage is Slashing, Wall of Fire's zone
  also covers 10 feet on its chosen `side` and deals its damage there without a save. The fight
  CLI casts one with `from x,y to x,y [left|right]` and draws it.
- **Cover and line of effect.** With positions, a target's cover is worked out from the map
  unless the caller gives `cover` (which wins): from the attacker's space for attacks, spells
  and save effects aimed at creatures, from an area's point of origin for creatures in an area
  (`mapCover`, `coverDegree` in `rules/grid.ts`). Walls and blocked squares block lines; another
  creature a clear line passes through gives Half Cover. Half and Three-Quarters Cover add +2 or
  +5 to AC and Dexterity saves and are noted ("Guard has Half Cover (behind an obstacle)."); a
  target behind Total Cover can't be targeted (no clear path), and a creature in an area with
  Total Cover from its point of origin isn't affected. An area's squares (zones' too) leave out
  blocked squares and those with no clear line from the point of origin (SRD "Area of Effect").
  `combatantOptions` leaves targets behind Total Cover out of its candidates.
- **Areas of effect.** A spell's `mechanics.area` and a monster save effect's `area` (read from
  "each creature in a 60-foot Cone") place on the grid with `area: { point }` (a Sphere,
  Cylinder or Cube) or `area: { toward }` (a Cone or Line aimed at a square) on `cast`,
  `save_action` or `legendary`: the targets are the creatures in it (`rules/areas.ts`), noted
  ("Fireball's Sphere covers Brakka, Goblin Warrior."). The point must be within the spell's or
  effect's range; a Cube "originating from" its caster must touch its space. A single-target
  save effect's range ("one creature … within 30 feet") is checked when both have positions.
- **Decisions after a roll.** Bardic Inspiration, Legendary Resistance and Uncanny Dodge are
  choices made after seeing the roll and before its consequences. The rules functions
  (`rollSavingThrow`, `rollAbilityCheck`, `makeAttack`, `castSpell`, `useSaveAction`) take a
  `decide` callback that receives a `Decision` (who, what, the question with the roll, and a
  `recommended` answer: only when it can turn the failure into a success; always for Legendary
  Resistance and Uncanny Dodge); without one they follow the recommendation. In an encounter,
  each combatant's `decisions` (or the encounter's, default `auto`) says who answers: `auto`
  takes the recommendation; `ask` stops the action before anything is applied, with the question
  in `encounter.pending` and nothing else allowed until `decide` answers it. `applyEncounterAction`
  records the dice an action rolls, so `decide` replays the stopped action with the same dice
  and the answers given so far: an action with several decisions (a Fireball on two dragons)
  asks them one at a time, and the engine never undoes anything. `set_decisions` changes the
  mode mid-fight; `POST /v1/encounters/apply` stops a list of actions at the first decision
  (`pending`, `applied`).
- **Weapon Mastery:** an `attack` with a line that has a mastery applies it unless
  `mastery: false`: Graze deals the ability modifier on a miss; Vex (Advantage on the attacker's
  next attack roll against the target, until the end of its next turn), Sap (Disadvantage on the
  target's next attack roll) and Slow (−10 feet of Speed, not cumulative; both until the start of
  the attacker's next turn) are `encounter.masteries`, used up by the roll they change; Topple
  forces a Constitution save (DC 8 + the attack's modifier + Proficiency Bonus) or Prone; Push is
  noted; Cleave allows one `attack` with `cleave: true` against a second creature per turn
  (`cleave_damage_parts`: no positive modifier), not counted among the Attack action's attacks;
  Nick makes the Light extra attack part of the Attack action once per turn. Help, Vex and Sap
  reach spell attack rolls too.
- **Spells in turns:** `cast` applies `castSpell`'s results. Guiding Bolt's hit is an
  `encounter.marks` entry (Advantage on the next attack roll against the target, by anyone,
  until the end of the caster's next turn), used up by the roll it changes. A follow-up save's
  creatures are the positioned ones within its radius of the target, or `nearby` without
  positions. Conditions with a duration in the spell's text (Ray of Sickness, Color Spray,
  Sunbeam) are timed effects that end at the start or end of the caster's next turn; a
  Concentration spell's other conditions last while it concentrates. A hold that an action's
  check ends (Black Tentacles, Web) gets an escape DC, and `escape` uses it with the skill the
  spell names.
- **Zones:** a spell with `mechanics.zone` (Moonbeam, Spirit Guardians, Cloudkill, Insect
  Plague, Incendiary Cloud, Black Tentacles, Web, Grease, Spike Growth, Stinking Cloud, Sleet
  Storm, Flaming Sphere, Conjure Animals, Conjure Woodland Beings) leaves an `encounter.zones`
  entry: its area (at a point; an Emanation around its caster, or around a space at a point:
  Conjure Animals' Large pack), save, damage at the cast level and conditions. With positions, a
  move goes square by square (`to`, straight, or a given `path`): a creature saves when it gets
  into a zone on the way (or the zone moves onto it: `move_zone`, or an Emanation's caster
  moving), at the start or end of its turn there, and takes `move` zones' damage for every 5
  feet in them (Spike Growth); a creature held on the way (Web) stops there. Without positions,
  `zone_save` names who saves. `zoneSquares` lists a zone's squares now (an Emanation's around
  where its creature stands). "Only once per turn" is tracked per zone (`saved`, reset at every
  turn's start). A failed save can also take the turn's action and Bonus Action (Stinking Cloud)
  or end Concentration (Sleet Storm). Saves the caster may force (Conjure Animals) are a
  `zone_force` decision, by default for enemies only; a ramming zone (Flaming Sphere) makes the
  creature it's moved onto save (`move_zone` `onto`). A zone ends with its caster's
  Concentration, after its duration, or with `end_zone`; the creatures its caster designates
  are spared.
- **Effects by hand:** `effects` applies play actions (what `makeAttack`, `castSpell` and
  `useSaveAction` return) to a character's state or to a monster (damage with its defenses,
  healing, Temporary HP, conditions with its immunities), optionally as timed effects.
- **Tracked effects** (`encounter.effects`) are conditions with a duration, tied to
  Concentration, or with a known source: `ends: { at: start|end, of, count }` counts that
  combatant's turn starts or ends ("until the end of its next turn", N rounds); one set during
  `of`'s own turn doesn't count that turn's end. A Concentration effect ends when its source stops
  concentrating on it. `cast` records a Concentration spell's conditions this way, for its
  duration ("up to 1 minute": 10 rounds). A condition goes when its last effect ends;
  `end_effect` ends one early, and an effect whose condition was removed another way is dropped.
  An effect's source is how the encounter knows a Grappled attacker's grappler, against whom
  Grappled gives no Disadvantage.
- **Legendary actions:** `legendary` takes one right after another creature's turn (never on the
  monster's own), within its uses per round (its lair's when `in_lair`) and once-per-round
  limits; uses come back at the start of its turn. It resolves the action's attack (a choice of
  attacks needs `attack`), the action it uses, or its own saving throw effect through the same
  code as `attack` and `save_action`, without spending the monster's action; otherwise it notes
  that the effect is in the text. Legendary Resistance uses spent on saves are counted
  (`legendary_resistance_used`) and noted.
- **Conditions in turns:** `attack` takes `within_5ft`; Initiative rolls with Advantage while
  Invisible and with Disadvantage while Incapacitated or surprised; notes give the reasons.
- **Concentration saves** are rolled automatically when a concentrating combatant takes damage
  (DC 10 or half the damage); a failure ends its Concentration effects.
- **Turn hooks.** At the end of a turn: effects counting turn ends, and `extends_each_turn`
  toggles (Rage) that weren't extended that turn (an attack roll, a save forced, a Bonus Action,
  or `extend`) end, except in the turn they started. At the start of a turn: effects counting
  turn starts, recharge rolls, and once-per-turn riders reset for everyone.
- A monster dies at 0 Hit Points (SRD "Monster Death") and its turns are skipped, as are a dead
  character's. A dying character's Death Saving Throw is rolled at the start of its turn
  (`createEncounter({ auto_death_saves: false })` leaves it to the player, with a reminder).
- **Checks:** the `check` action rolls an ability or skill check, with or without a DC; it uses no
  action by itself.

### What a combatant can do now

`combatantOptions(encounter, id, ctx)` (`src/services/options.ts`) lists a combatant's options
for a UI: attack lines and their variants (thrown, Opportunity Attack out of turn, the Light
extra attack, Cleave, granted attacks), spells (a character's cantrips and prepared spells with
the slot levels and Pact Magic slot left; a monster's listed spells with their fixed level and
daily uses), a character's `sheet.actions` features with uses left, a monster's saving throw
effects (those waiting for a Recharge too) and legendary actions (uses left this round), the
standard actions (Dash, Disengage, Dodge, Help, Grapple, Shove, escaping a hold, standing up,
moving) and the zones it created. Each option is an `EncounterAction` ready to send, with its
cost, label, candidate targets (`TargetSpec`: enemies first, then nearest first; only those
within reach or range when positioned), and `available`/`reason`. An attack option also lists
the Cunning Strike and Brutal Strike effects its attacker has (`strikes`: Cunning Strike's on a
line that can deal Sneak Attack, Staggering and Sundering Blow with Improved Brutal Strike), each
with its cost, its own ready action and its own dry-run verdict.

Legality isn't re-derived: `checkAction(encounter, action, ctx)` dry-runs
`applyEncounterAction` with dice fixed in the middle of their range and returns the
`EncounterError` messages, and `combatantOptions` judges every option that way; the same dry
run's result gives an allowed option's `odds` against its first target (`rules/odds.ts`): its
d20 was 10, so the result's total says the bonus, and its roll says the mode the engine chose
(Advantage, cover, conditions all included). Average damage uses the attack line's or spell's
damage parts (features' bonus dice left out), Critical Hits, a save's half damage and the target's
Resistance, Immunity and Vulnerability (without rounding down) (`{ check: false
}` skips it). An action that stops for a decision counts as allowed. The dry run says whether an
action is allowed, not how its dice would land. An option aimed at a creature is judged against
its first candidate; with none in range, against the nearest creature (so the reason is the
engine's "out of reach"), or "No creature within N ft". The result has a Zod schema
(`CombatantOptionsSchema`, `schemas/options.schema.json`); `POST /v1/encounters/options` and
`/v1/encounters/check` serve both functions.

### Messages (for translation)

A result's `messages` are its `notes` as data: `{ code, params, text }`, `text` being the English
sentence rendered from `MESSAGES_EN[code]` (`src/messages/en.ts`). Encounter and play results,
`takeDamage`, `adjustDamage` and `castSpell` have them; attack, save and check results have
`reason_messages` next to `reasons` (each "Advantage: …" a `roll.reason` message around the
cause, which a `ModeReason` carries as `message`). Templates are a small subset of ICU
MessageFormat (`{x}`, `plural`, `select`, `list`); a parameter can be a nested message (a save's
roll, an ability's name, the reason an effect ends), so a translation rephrases every part. An app
renders them with its own catalog (`renderMessage(message, catalog, { locale })`, English `text`
for a code it lacks). Nothing English is left outside the catalog: a `plural` picks its option by
`Intl.PluralRules(locale)` (`zero`, `one`, `two`, `few`, `many`, `other`; an exact `=n` first,
English rules without a locale), and lists are joined with the catalog's `list.comma`,
`list.plus`, `list.semicolon`, `list.or` and `list.and` (plain separators). Names the builder
shows have codes too: `step.<id>` (`STEP_TITLES`), `alignment.<id>` (`ALIGNMENT_NAMES`), `stat.*`
(`StatChange.label_message`), and a D20 Test's `label` has `label_message`. Content names in
params (spells, conditions, damage types) stay as the catalog has them.

Internally the services collect `Message`s, not strings (`run()` in the encounter,
`applyAction`), and derive `notes` with `texts()`, so the compiler refuses an uncoded sentence.
Refusals are messages as well: the services' `fail` takes a `Message` only, the error classes
(`EncounterError`, `PlayError`, `BuildError`) keep `messages` (English) and add `details`, and a
rule refusing a roll throws `RuleError`, a `RangeError` whose `detail` the encounter passes on
(`ruleReason`). Refusal codes (`REFUSAL_CODES`) still come from the English text's patterns
(`services/refusals.ts`), which the templates keep. Decision questions (`Decision.message`,
`pending.question_message`) are messages too.

The builder's validation (`Issue.detail`), option reasons (`OptionView.unavailable_message`),
repairs and setter notes (`BuildResult.messages`), the play sheet's state issues and the
encounter options' labels and notes are messages as well (`baseScoreMessages`,
`multiclassBlockerMessages`, `replaceErrorMessages`; their English-only twins are gone).

Code `text` (`params.text`) is left only for a reason an app passes as a plain string. Content
(names, choice labels, descriptions) and the sheet's number breakdowns ("AC 17 = 16 Chain Mail +
1 Defense") aren't messages: translating content is a separate topic. `message()` throws on a
missing parameter or a message pasted into a string.

### Events, refusal codes and undo

- **Events.** `applyEncounterAction` returns `events` (`src/services/events.ts`,
  `EncounterEventSchema`), worked out by comparing the encounter and its characters' states
  before and after the action rather than by instrumenting each rule, so every change is covered
  whichever rule made it: a new turn or the fight's end, combatants joining or leaving,
  Initiative, moves (`from`, `to`, feet), HP and Temporary HP, conditions added or removed,
  status (`defeated`, `down`, `stable`, `dead`, `up`), Concentration, the action economy spent,
  a character's spell slots, Pact Magic and limited uses, effects and zones added, moved or
  ended, map changes, and a pending decision. Their order follows the combatants, not the
  order things happened in; the notes keep that. A dry run (`checkAction`) skips them
  (`{ events: false }`).
- **Refusal codes.** `EncounterError.codes` gives each message a code from `REFUSAL_CODES`
  (`src/services/refusals.ts`: one table of patterns over the engine's messages, `refused` when
  none matches); `checkAction`, options and previews carry them too, and the HTTP API returns
  them in `codes`.
- **Undo.** Every action rolls only through `rng`, and its result lists the dice it drew
  (`rolls`; for `decide`, only the new ones). An `EncounterHistory` (`src/models/history.ts`, a
  document of its own: the start and each action with its dice) replays with `scriptedRng` to the
  same encounter and states (`replayHistory`); `undoAction` replays all but the last action, so
  undoing a `decide` brings its question back. `POST /v1/encounters/apply` returns the steps in
  `log`. The fight CLI keeps one for `undo`.
- **Rolling by hand, a dice roller.** `rollByHand` (`src/services/by-hand.ts`) is a pure
  function over plain inputs: a `Combatant`, and the monster's stat block (`monster`: its spell
  lines, daily uses and the spells its legendary actions cast) or the character's build and state
  (`character`: its features, known spells, Cunning and Brutal Strike) when the roll needs them.
  It rolls the actor's dice without a target and returns what it costs as data (`RollCost`), never
  checking or spending it: a play action for the character (slot, Pact slot, Concentration, a
  feature's uses with `manual`), a monster's daily use, a monster's ability to recharge. Attacks go
  through `rollAttack` (shares `prepareAttack` with `makeAttack`: the mode comes from `attackMode`
  with no target, so only the actor's own state and the `mode` asked count; damage is rolled
  whatever the d20); spells through `castSpell` with `by_hand` (an attack roll per beam or ray
  with its damage, else the damage rolled once, a save's DC, healing). Rolling and paying are
  separate. The encounter's `roll` action is a free roll: it calls the roller (`rollWith`, which
  adds Brutal Strike's turn check for automatic attacks) on the combatant's full stat block (an
  ability waiting to recharge still rolls), checks each cost with `checkCosts` (a character's
  play actions tried in order on its state, a monster's counters), spends nothing, and `byHand`
  builds the `DeclaredResult` and its notes. The `spend` action pays costs: play actions through
  `applyTo` (so the Concentration sweep runs at once and `force` can override `no_resources`),
  daily uses and Recharge on the monster's counters, refused when one can't be paid. Both go in
  the history, so undo replays rolls and payments like any action.
- **Every reason, with a category.** `REFUSAL_CATEGORIES` maps each refusal code to what it's
  about (`economy`, `turn`, `target`, `movement`, `resource`, `state`, `input`, `other`), so a
  client picks what to enforce: the engine informs, the caller decides. An option the plain dry
  run refuses gets a second dry run with `force: true`: each refusal the GM could override becomes
  a note and the run goes on, so `reasons` lists all of them, then the one that stops it
  (`EncounterError.overridden` keeps the overridden ones when the run fails). An option of a
  rollable kind (`RollWhatSchema` parses it) is also judged as a `roll`: rollable when the engine
  takes it, with the costs it couldn't pay now merged into its reasons.
- **GM override.** `force: true` on an action taken in turns turns a refusal of legality into a
  note: `run` checks those with `refuse(reason)` instead of `fail`, which throws unless the action
  is forced and the reason's refusal code is in `FORCEABLE_REFUSALS` (turn, Incapacitated,
  economy, attacks left, once per turn, range and reach, off the map, movement, resources); then
  it notes `override.applied` with the reason and the action goes on. A forced cost spends what
  it can: a character's `PlayError` with only forceable reasons (no slot of that level left, no
  uses of a feature) skips that play action, legendary uses stop at the round's maximum, an
  economy flag already spent stays spent. Unknown ids, missing input, defeated creatures, paths,
  Total Cover and refusals from the rules functions (`RuleError`) aren't forceable.
  `checkAction` reports the overrides it would make.

### Previews

`src/services/previews.ts` answers a map UI's questions without applying anything, with the
encounter's own planning so the answers match what happens: `reachableSquares` floods the grid
from the combatant's space as `move` sees it (`rules/grid.ts` `reachable`: walls, blocked and
Difficult squares, creatures it can pass through but not end in) up to its movement left;
`previewMove` plans the move like `move` does (`planMove`), judges it with `checkAction`, and
walks the path to list the zones each creature would get into (an Emanation moving with its
caster included), the feet moved in zones that deal damage for moving, and the enemies whose
reach it would leave; `previewArea` places a spell's, a save effect's or a legendary action's
area like `cast` does (`placeArea`): its squares with a clear line from the point of origin, the
creatures in it with their cover, and those Total Cover keeps out. Saves aren't rolled, so a
preview can't say whether a zone would stop a creature on the way. The results have Zod schemas
(`schemas/reachable.schema.json`, `move-preview.schema.json`, `area-preview.schema.json`).

## Interpretations (flagged, not invented)

Where the SRD is silent or ambiguous, the engine picks a reading and lists it here.

**Character building**

- **A spell or Expertise choice needs no more picks than there are options left.** With the
  SRD's 27 cantrips, a multiclass caster can already know every cantrip on a short list (the
  Cleric has seven), and a multiclass Wizard may have none of the skills Scholar needs. The SRD
  doesn't cover this; the builder accepts fewer picks instead of blocking the character. A spell
  choice whose list isn't chosen yet (Magic Initiate) still needs its full count.
- **A repeatable feat that must differ each time** (Magic Initiate: a different spell list) stops
  being offered once every option is used.
- **"A Warlock cantrip that deals damage"** (Agonizing Blast, Eldritch Spear, Repelling Blast)
  is Chill Touch, Eldritch Blast, or Poison Spray, the SRD Warlock cantrips that deal damage with
  an attack roll or save.
- **Class feature text for levels 2–20 is the SRD's own**, generated from the Markdown; level 1
  traits stay summarized. Features that change numbers or rolls are modeled as data (effects,
  riders, Advantage, toggles); the rest is text and class resources.

**Play**

- A Long Rest doesn't remove conditions (the SRD ties them to their source).
- Attuning is recorded immediately, with a note that it takes a Short Rest.
- Damage while Petrified is halved, typed or not (Resistance to all damage).
- A Short or Long Rest ends every active toggle (Rage lasts at most 10 minutes).

**Damage and attacks**

- Bloodied uses the current Hit Point maximum (after any reduction), and an odd maximum's half
  isn't rounded: 3 of 7 is Bloodied, 4 isn't (the SRD says "half its Hit Points or fewer").
- Damage that Temporary Hit Points absorb entirely calls for no Concentration save and causes no
  Death Saving Throw failure, and the Concentration DC uses the damage that got past them (the
  SRD says "if you take damage"; this keeps Temporary Hit Points a full buffer).
- A magic weapon's damage bonus still applies to fixed damage (only the ability modifier is
  excluded).
- A roll in an extended critical range (19 with Improved Critical) is a Critical Hit and so hits
  regardless of AC, like a natural 20 (SRD "Critical Hit"). A natural 1 misses even inside such
  a range. Natural 20s and 1s mean nothing special on saving throws.

**Monster traits**

- An aura "of its choice" hits the monster's enemies (its side's opponents); Fire Aura's
  "start burning" and auras' effects on objects are text. A regenerating monster at 0 Hit Points
  has the Unconscious condition until it regenerates (the SRD says only when it dies).

**Spells**

- On a successful save for half, each damage type is halved separately (rounded down), since
  Resistance applies per type.
- Healing that several targets receive is rolled once, like damage.
- Each beam's damage preview is against the target as it was before the spell.
- Magic Missile's darts share one damage roll ("The darts all strike simultaneously"); each dart
  is still its own damage, so a concentrating target makes a save per dart.
- Ice Knife's Cold damage is rolled once for every creature that saves, like other save damage;
  a creature within 5 feet of the target includes the caster.
- Guiding Bolt's Advantage applies to the next attack roll against the target by anyone,
  spell attacks included, and a new hit replaces the old mark.
- A zone's later damage is rolled without features' bonuses (Empowered Evocation's "one damage
  roll" is the casting's), once for the creatures that save at the same moment.
- Entering a zone is judged by where a move ends: a move straight through it isn't seen, and
  `place` (setting up or forced movement) triggers nothing. The save when the spell appears
  counts as that turn's save.
- Zones that drift or move (Cloudkill, Incendiary Cloud, Moonbeam's Magic action) move only by
  `move_zone`, whose action and direction are the caller's. Spirit Guardians' halved Speed and
  Moonbeam's effect on shape-shifters stay text.
- Web's Restrained lasts until the creature escapes or the caster's Concentration ends ("while
  in the webs" isn't checked).
- A move to a square goes straight, diagonals first; a `path` gives another way. Entering a zone
  on the way counts, but an Opportunity Attack is still judged by where the move starts and
  ends.
- A save the caster may force (Conjure Animals, Conjure Woodland Beings) is forced on enemies in
  `auto` mode, never on the caster itself; "a creature you can see" isn't checked.
- Flaming Sphere's "within 5 feet of the sphere" is a 5-foot Emanation from its square; it rams
  a creature only through `move_zone` with `onto`. Conjure Animals' pack is a 10-foot Emanation
  from a Large space; its Advantage on Strength saves and Conjure Woodland Beings' Disengage
  stay text, as do Spike Growth's camouflage and Sleet Storm's doused flames.

**Monsters**

- A "First Failure" is what a failed save does; the second failure stays text.
- Conditions a stat block gives only to targets of some size or HP, or after being swallowed or
  engulfed, stay text; so does damage that depends on something ("if the attack roll had
  Advantage").
- Who can be targeted (size limits) is the caller's to decide; range is measured when combatants have positions.
- A stat block without a save DC or attack bonus for its spells gets 8 + modifier + Proficiency
  Bonus as the DC and the DC − 8 as the attack bonus (the Brass Dragon lists Scorching Ray with a
  save DC only). Most stat blocks that give both follow that relation, not all (the adult Bronze
  Dragon's +10 with DC 17).
- A spell's restriction from the stat block (`note`: "self only", "Beast or Humanoid form only…")
  is shown, not enforced.
- Daily uses aren't reset by the encounter: a new day is a new encounter document.
- A Multiattack's "replace one attack with a use of Spellcasting" stays text.

**Conditions and rolls**

- Frightened gives Disadvantage on attack rolls as if the source of fear were always in line of
  sight.
- Invisible's benefit applies against every creature: "a creature that can see you" (Truesight,
  Blindsight) isn't modeled.
- Without positions, whether an attack is within 5 feet defaults by its kind (melee: yes,
  ranged: no); the caller sets it otherwise (a reach weapon, a ranged attack at close range).
- Grappled's exception for the grappler needs the grappler known: an encounter effect with it as
  the source. Otherwise the Disadvantage applies to every target.

**Class features**

- Reckless Attack is switched on by the caller, who decides it's the first attack roll of the
  turn; in an encounter it ends at the start of the barbarian's next turn.
- Frenzy's "first target you hit on your turn" is a once-per-turn rider offered while Rage and
  Reckless Attack are both on.
- Primal Strike applies to weapon attacks; Beast-form attacks aren't attack lines.
- Empowered Evocation's and Elemental Affinity's "one damage roll" is the first damage part of
  the first roll (the first beam, ray or dart of a spell that has several; never a follow-up
  save's damage); Potent Spellcasting adds to every roll.
- Reliable Talent covers skill checks; tool proficiencies aren't checks the engine rolls.
- Action Surge can be used once the turn's action is spent (the additional action replaces it).
- In `auto` mode, a Bardic Inspiration die is used on a failed D20 Test only when its highest
  roll could turn the failure into a success; in `ask` mode its holder decides. It lasts until
  used in the encounter ("within the next hour" isn't tracked); a death save doesn't use it.
- Stunning Strike accepts any hit this turn ("with a Monk weapon or an Unarmed Strike" isn't
  checked); its successful-save effects (half Speed, Advantage on the next attack) stay text.
- Uncanny Dodge is decided once the hit is known, with the damage already rolled (the question
  doesn't show it); it doesn't check that the rogue can see the attacker; Lay On Hands' option to cure
  Poisoned stays text.

**Positions**

- **Noticing points of interest.** The SRD leaves noticing to the GM ("Passive Perception",
  "Finding Hidden Objects"); the engine's reading: only characters notice (monsters don't look
  for the party's clues), seeing a point means no Total Cover from a corner of the space to its
  square (light and obscurement aren't modelled), and the move stops on the square where it was
  noticed (a free one), so a noticed trap isn't walked into. Who else stops is the GM's
  `notice_stops`.
- **Walls on the grid.** The SRD doesn't say how walls sit on a grid: a wall is a segment
  between grid corners, so it stands between squares; a step goes from square center to square
  center and is blocked when that line touches a wall, so a diagonal can't cut a wall's corner
  (SRD "Corners") nor pass the corner of a blocked square.
- **Larger creatures on the map.** A Large or bigger creature moves all its squares by the same
  step, each of which must be free; the step costs double when any square it enters is
  Difficult Terrain.
- **Which path.** A move `to` a square goes straight (diagonals first) when nothing blocks it,
  even if a detour would cost less; otherwise it takes the cheapest path, which doesn't avoid
  zones (give `path` to choose the route). The whole route's cost is checked against the
  movement left before the move starts, even if something stops the creature on the way.
- **Leaving reach on the way.** An enemy whose reach the mover leaves at any step of its path can
  make an Opportunity Attack (noted once per enemy, after the move).
- Spirit Guardians' "Speed is halved in the Emanation" is judged where the creature is when its
  movement is checked (the start of a move): entering the Emanation partway through doesn't
  shorten that move.
- A Tiny creature takes one square; several Tiny creatures can't share it.
- Close combat's "an enemy who can see you" is the caller's to judge; so is cover without
  positions.
- An Opportunity Attack (`opportunity: true`) skips the reach check: it happens just before the
  target leaves, after the target's move was recorded.

**Cover and line of effect**

- **Cover on a grid.** The SRD gives cover's degrees and what offers them, not how to find them
  on a grid; the engine uses the DMG's grid method: from the corner of the attacker's space that
  sees best (or an area's point of origin), lines to the four corners of the target's least
  covered square; none blocked: no cover; 1–2: Half; 3: Three-Quarters; 4: Total. A line that
  only grazes an obstacle (along a wall's face, past its free end, or past a single corner) isn't
  blocked; one through the corner where two walls or blocked squares meet is.
- **Creatures as cover.** Another creature (ally or enemy) that a clear line passes through gives
  Half Cover, against areas too (SRD: "another creature"); it never gives more than Half.
- **Points of origin.** A Sphere's or Cylinder's is its grid intersection, a Cube's its center
  (the SRD puts it on a face), an Emanation's, Cone's or Line's the center of the space it comes
  from. A square is in an area when the line from the point of origin to its center is clear
  (the SRD: when not all lines to it are blocked).
- Cover isn't worked out for a zone's later saves, nor for a follow-up save's creatures (Ice
  Knife); "a creature you can see" (vision, light, Invisible) stays the caller's.

**Class features**

- Innate Sorcery's +1 to the save DC and Advantage on spell attacks apply to all the
  character's spells, not only Sorcerer ones. A toggle's duration (`rounds`: Rage's 10 minutes,
  Innate Sorcery's minute, Sacred Weapon's 10 minutes) counts the character's turn starts in an
  encounter; outside one it lasts until switched off.
- Cunning Strike's Withdraw gives half the rogue's Speed as extra movement and Disengage for the
  rest of the turn (the SRD: that move "immediately after the attack"); Forceful Blow's push and
  the barbarian's move toward the target are noted, not made. Devious Strikes (rogue 14) are text.
- Sacred Weapon's bonus applies to every weapon attack while it's on (the SRD: the one Melee
  weapon imbued), and its Radiant damage option isn't tracked. Agonizing Blast's
  Charisma goes to the chosen cantrip's damage like Potent Spellcasting (once per damage roll).
- Deflect Attacks reduces the damage; redirecting it (a Focus Point when it reaches 0) and Deflect
  Energy's other damage types are text. Turn Undead's "it tries to move as far from you as it
  can" is the GM's to play.
- Indomitable is offered on any failed save while a use is left (recommended only when the
  reroll can succeed); a Bardic Inspiration die can still be added after it.

**Spells**

- Chain Lightning's other targets "within 30 feet of the first target" aren't checked; Mass
  Suggestion's Charmed ends when the creature takes any damage (the SRD: from the caster or its
  allies); Hex's Disadvantage on the chosen ability's checks and Hunter's Mark's edge to find its
  quarry are text; Divine Smite follows the caster's last hit this turn.

**Wall spells**

- Walls are straight, from point to point: rings, Wall of Force's and Wall of Ice's domes, globes
  and panels at angles, and walls that cut through a creature's space (pushed aside, Wall of
  Ice's save) are text; so are breaking a wall (AC and Hit Points per section), Wall of Ice's
  frigid air, Wall of Stone's enclosure save and its permanence.
- Wall of Fire's "when it enters the wall" and Blade Barrier's and Wall of Thorns' saves use the
  whole zone (for Wall of Fire, its side too); Wall of Fire's opacity and Wall of Thorns' "blocks
  line of sight" are vision, which isn't modeled.

**Hide, Search and Ready**

- "Out of any enemy's line of sight" is read as Three-Quarters or Total Cover from each enemy that
  isn't Incapacitated (there's no vision model); Heavy Obscurement is the caller's to say.
- A Search with Perception finds every hidden enemy whose Stealth total it equals or beats,
  wherever they are; the other Search skills are plain checks.
- A readied action's trigger is the caller's to watch; the engine checks only that the reaction
  is free and the readied action is still legal when it's released.

**Areas of effect**

- The SRD defines the shapes but not how they cover squares: a square is in an area when its
  center is inside the shape. Spheres and Cylinders spread from a grid intersection with the
  grid's distance rule (diagonals count as one step), so their area is square (a 20-foot radius:
  8×8 squares); Emanations spread the same way from their origin's space, which isn't part of
  the area (the SRD doesn't say whether it is; a spell that affects its caster says so). Cones and Lines start
  at the center of their origin's space; a Cone's width equals its distance from the origin.
- A Cylinder's height and "each enemy" (rather than each creature) aren't distinguished: the
  caller removes a target that shouldn't be there by giving `targets` instead.
- Creatures out of the fight (dead characters, defeated monsters) aren't in areas.

**Encounters**

- **What an action rolled by hand changes.** Nothing: its resources are costs the table pays
  with `spend` if it wants, never the action economy or the turn; the same attack can be rolled
  any number of times. No
  Rage extension, hiding, Help, Vex, Sap or marks used, no Action Surge action or granted attacks,
  no Bardic Inspiration die given. A Grapple or Shove shows its DC with the target's choice of
  Strength or Dexterity (`ability: null`) unless `save` names one.
- Initiative ties go to the higher Initiative bonus, then the order combatants joined (the SRD
  leaves ties to the GM and players: `set_order`).
- Dash uses the walking Speed.
- A monster's Multiattack is a number of attacks for the action (summed from its text; the
  Hydra's is `null`), without checking which attacks.
- "Once per turn" resets on every creature's turn; Divine Strike can only be added on the
  cleric's own turns (`own_turn`).
- A monster's spell slots aren't tracked.
- Allies are combatants on the same `side`; combatants without a side are all allies (Help needs
  sides to tell an ally from an enemy).
- The target of a Grapple or Shove chooses Strength or Dexterity: by default its better save
  bonus; the escape check likewise takes the better of Athletics and Acrobatics. "A hand free"
  and one grapple per hand aren't checked; a stat block's "Medium or Small" counts as Medium.
- Dodge's Disadvantage applies to every attacker ("if you can see the attacker" isn't modeled),
  and Help's attack benefit to any ally's attack roll against the enemy, wherever the helper is.
- Nick applies when the weapon making the Light property's extra attack has it. Vex and Slow need
  damage dealt after Immunity and Resistance (damage to Temporary Hit Points counts). Push and Cleave's "within 5
  feet of the first" are the caller's to handle (no positions).
- An Opportunity Attack (`opportunity: true`) is checked only against Disengage and for being a
  melee attack; whether the target left the attacker's reach is the caller's to decide.
- In `auto` mode, Legendary Resistance is spent on the first failed save while uses are left; the
  SRD says the monster "can choose", which `decisions: ask` gives the GM.
  `auto_legendary_resistance: false` keeps its older meaning: the monster never uses it.
- A legendary action that makes an attack or uses another action resolves just that roll; what
  else it does (moving, teleporting, regaining Hit Points) is in its text.
- Ending the fight keeps active effects; they stop counting down.

## Known gaps

What the engine doesn't do yet is listed with sizes in [ROADMAP.md](ROADMAP.md). The main ones:
51 spells keep their effects in text.
Starting-equipment items "of your choice" (a Bard's instrument, a Monk's tool) are placeholders,
like the Soldier's gaming set.

## Named rules in code (documented exceptions)

Most rules are data; these are code, by name:

- `rules/sheet.ts`: Martial Arts (Dex and the Martial Arts die for Unarmed Strikes and Monk
  weapons, only without armor or Shield) is triggered by the `martial_arts.die` effect; Great
  Weapon Fighting adds a note to two-handed melee attacks; Two-Weapon Fighting keeps the ability
  modifier in a Light weapon's `light_extra_damage_parts`.
- Feature `rules` (a closed list, `FEATURE_RULES`): `evasion` in `resolveSave`
  (`rules/casting.ts`), `reliable_talent` in `rollAbilityCheck`, `potent_cantrip` in
  `castSpell`, `indomitable` in `rollSavingThrow` (its bonus and uses from
  `combatantFromCharacter`); in `services/encounter.ts`, `cunning_strike` and
  `improved_cunning_strike` (the `attack` option `cunning`), `brutal_strike` and
  `improved_brutal_strike` (`brutal`), and `relentless_rage` (when raging damage would drop the
  character to 0 Hit Points). A monster's trait named "Evasion" (the Assassin) sets `evasion`.
- `attackMode` reads the `attack.str` and `attacked` Advantages (Reckless Attack).
- `services/play.ts` knows a few SRD condition ids: `petrified` halves all damage (Resistance to
  all damage), `unconscious` is added at 0 HP and removed when you regain Hit Points, and
  `incapacitated` (or a condition that implies it) ends Concentration and toggles with `ends_on`.
- `services/encounter.ts`: `incapacitated` stops actions and reactions, `petrified` gives a
  monster Resistance to all damage, a monster at 0 HP is defeated (SRD "Monster Death"),
  `grappled` is what `unarmed` gives and `escape` ends (and ends with an Incapacitated grappler),
  and `prone` is what a shove or Topple gives and `stand` ends; the eight SRD mastery properties
  are matched by name in `applyMastery`.

## Runtime and packaging (TypeScript)

The engine was ported from Python to TypeScript so the same code can run in a browser
builder, a VTT client, an edge function and a server.

- **Isomorphic core.** `src/index.ts` and `src/http/` import no Node built-ins. The SRD is
  compiled from YAML to JSON at build time (`scripts/compile-content.ts`) and bundled, so no
  filesystem or YAML parser is needed at runtime. Node-only code (reading content
  directories, the `node:http` adapter, the CLI) is in `src/content/load.ts`,
  `src/http/node-server.ts` and `src/cli/`.
- **Content size.** The SRD is bundled into `srd-rules-engine/srd` (not the main entry) and
  also published, minified, as `srd-5.2.1.json` and split by table under `srd-5.2.1/` (the
  repository copy stays formatted). `npm run content` reports the minified and gzipped sizes
  and fails over `MAX_GZIP_KB` (whole) or `MAX_CORE_GZIP_KB` (the core tables)
  (`scripts/compile-content.ts`); see "Entry points and partial catalogs" above.
- **Schemas: Zod.** Content, builds, play states, encounters and API payloads are Zod schemas.
  The TypeScript types are inferred from them, except for the recursive `Grants`/`ChoiceDef`/
  `ChoiceOption`/`ToggleDef`, which are written by hand. The same schemas generate
  `schemas/*.schema.json` for content authors and for other languages (content files, pack
  manifests, patches, builds, play states, encounters and the play and encounter actions);
  `tests/json-schemas.test.ts` checks them with a JSON Schema validator against the bundled SRD
  and against documents the engine writes.
- **snake_case data.** Fields keep the YAML/JSON names (`class_id`, `base_ac`), so content,
  saved documents, sheets and HTTP payloads share one format, and builds saved by the Python
  version still load. Functions are camelCase.
- **Immutability.** Catalogs are deep-frozen and builds are frozen; play states and encounters
  are cloned by every action. Lookups by id go through `lookup()` (an `Object.hasOwn` check), so
  ids like `constructor` can't hit the prototype.
- **Dice.** Every rolling function takes an optional `Rng` (`{ int(min, max) }`).
  `seededRng` (mulberry32) gives the same sequence on every platform; `scriptedRng` and
  `fixedRng` are for tests.
- **Public API.** `tests/api.test.ts` snapshots the names each entry point exports; changing
  the snapshot is a deliberate API change, noted in the CHANGELOG. `src/index.ts` lists every
  export by name, so a new helper stays internal unless it's added there.
- **Document versions.** Builds, play states and encounters have a `version`
  (`DOCUMENT_VERSION`, in `models/version.ts`). A document without one is version 1; parsing
  refuses a newer one. A format change raises the version and migrates older documents on
  parse, so saved documents keep loading.
- **HTTP.** A Web-standard `fetch` handler with no router dependency. Request bodies are
  validated with the same Zod schemas (422 on failure). The Node adapter limits bodies to
  1 MB, and dice expressions are limited to 1000 dice of up to 1000 sides.
