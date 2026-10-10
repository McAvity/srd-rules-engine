# SRD Rules Engine

A rules engine for 5th-edition tabletop RPGs, based on the **System Reference Document 5.2.1**
(the 2024 rules): a character builder, play-state tracking, and combat with monsters and
encounters. Written in TypeScript. It has no framework dependencies and runs in Node, Deno, Bun,
browsers and edge workers.

```ts
import { builder, computeSheet, createBuild, explainStat } from "srd-rules-engine";
import { srdCatalog } from "srd-rules-engine/srd";

const catalog = srdCatalog();
let build = createBuild();
build = builder.setClass(build, catalog, "fighter").build;
build = builder.setSpecies(build, catalog, "dwarf").build;
build = builder.setAbilityMethod(build, catalog, "standard_array").build;
build = builder.setBaseScores(build, catalog, { str: 15, dex: 14, con: 13, int: 8, wis: 10, cha: 12 }).build;

const sheet = computeSheet(build, catalog);
sheet.max_hp?.total;              // 12
explainStat(sheet.max_hp!);       // "10 Fighter d10 + 1 Con + 1 Dwarf"  ← every number explains itself
```

## Highlights

- **Rules that run the game.** The engine embeds the SRD rules and follows the game flow: what's
  legal, whose turn it is, what a roll does and what it changes.
- **One engine for the whole game.** Character creation, play and combat share the same rules.
- **Explanations built in.** Numbers, refusals and rolls come with their reasons.
- **Faithful to the SRD.** Content is reviewed against the SRD text, and the readings it leaves
  open are documented.
- **Homebrew without forks.** Your content is YAML layered on the SRD, validated the same way.
- **Any runtime, any language.** Browsers, Node, Deno, Bun and edge workers; other languages
  through the HTTP API.

## See it in action

```bash
npm run demo
```

[`examples/battle-demo.ts`](examples/battle-demo.ts) builds a level 5 party through the builder
API (a refused choice with its reason, an AC that explains itself) and fights a red dragon
wyrmling and its goblins on a grid: reach and Opportunity Attacks, a Fireball and a breath weapon
choosing their targets, Bardic Inspiration asked after a failed roll, Action Surge, Weapon
Mastery. The dice are seeded, so the story is the same on every run.

## Install

```bash
npm install srd-rules-engine
```

| Entry point | What | Runs on |
|---|---|---|
| `srd-rules-engine` | The engine and its schemas, without content | everywhere |
| `srd-rules-engine/srd` | The SRD content bundled in: `srdCatalog()`, `srdPack` (about 2 MB) | everywhere |
| `srd-rules-engine/http` | `createHandler()`: the HTTP API as a `fetch` handler (bundles the SRD) | everywhere |
| `srd-rules-engine/node` | Everything above, plus `loadContentPack(dir)` and `serveNode()` | Node |
| `srd-rules-engine/srd-5.2.1/*.json` | The SRD content split by table (`manifest.json`, `classes.json`…), for `loadPack` | any language |
| `srd-rules-engine/srd-5.2.1.json` | The SRD content as one JSON file | any language |
| `srd-rules-engine/schemas/*.json` | JSON Schemas for content files, pack manifests, patches, builds, play states, encounters and their actions | any language |

### In a browser

The main entry has no content, so a web app can fetch the SRD tables it needs and cache them:
the core tables a character builder starts with are about 60 KB gzipped, the whole SRD about
300 KB. Serve the files of `srd-rules-engine/srd-5.2.1/` (copy them to your static assets), then:

```ts
import { CORE_TABLES, createCatalog, loadPack } from "srd-rules-engine";

const base = "/content/srd-5.2.1/";
const fetchJson = (file: string) => fetch(base + file).then((r) => r.json());
const tables = [...CORE_TABLES, "spells"] as const;     // add "monsters", "magic_items" later
const catalog = createCatalog([await loadPack(fetchJson, { tables })], { tables });
```

A table left out isn't there: reading `catalog.monsters` throws "The table 'monsters' isn't
loaded in this catalog". To add one, build the catalog again with more tables.
`splitPack(pack)` splits your own packs the same way.

## Usage

### Building a character builder UI

A build stores only the player's choices. `evaluate()` resolves it against the catalog
and returns everything a UI needs: the active choices, every option with the reason it
can't be picked, what's still missing at each step, and the derived sheet.

```ts
import { BuildError, builder, createBuild, evaluate, issuesForStep } from "srd-rules-engine";
import { srdCatalog } from "srd-rules-engine/srd";

const catalog = srdCatalog();
let build = createBuild();
build = builder.setClass(build, catalog, "fighter").build;
build = builder.setSpecies(build, catalog, "human").build;
build = builder.setBackground(build, catalog, "soldier").build;

const ev = evaluate(build, catalog);
const skills = ev.resolution.choice("class:fighter#skills")!;
ev.resolution.options(skills);
// [{ id: "acrobatics", name: "Acrobatics", unavailable: null, … },
//  { id: "athletics",  name: "Athletics",  unavailable: "already proficient from Soldier", … }, …]

issuesForStep(ev.report, "proficiencies").map((i) => i.message);
// ["Fighter skills: choose 2 more", "Skillful skill: choose 1 more", "Soldier gaming set: choose 1 more"]

// Setters validate input and throw BuildError with readable messages…
builder.setChoice(build, catalog, "class:fighter#skills", ["athletics", "history"]);
// BuildError: ["Athletics: already proficient from Soldier"]

// …and when an upstream change invalidates a later choice, they repair the build and explain:
const { build: next, notes } = builder.setBackground(build, catalog, "criminal");
// notes: ["Skilled proficiencies: removed Stealth (already proficient from Criminal)."]
```

Levels are added one at a time. A level 5 character is a level 1 character plus four
level-ups, each in any class you qualify for:

```ts
builder.levelUpOptions(build, catalog);
// [{ class_id: "fighter", class_level: 2, fixed_hp: 6, unavailable: null },
//  { class_id: "wizard", class_level: 1, unavailable: "Wizard needs Intelligence 13+" }, …]

build = builder.levelUp(build, catalog, "fighter").build;     // fixed Hit Points
build = builder.levelUp(build, catalog, "fighter", 7).build;  // a Hit Die roll of 7
evaluate(build, catalog).resolution.choicesForLevel(3);       // [class:fighter:3#subclass]
```

The build stores each level as `{ class_id, hp }`, so it stays small and replayable.

Changing the past uses the same setters: any past choice with `setChoice`, a past level's class
with `setLevelClass`, its Hit Points with `setLevelHp`. `previewChange(build, catalog, change)`
reports what a change would remove and what new choices it creates, before you apply it. Every
setter refuses (`BuildError`) a change that would leave the character illegal.

Builds are frozen, JSON-serializable objects: save them with `JSON.stringify` and load them
with `parseBuild(json)`. Choice keys (`class:fighter#skills`,
`feat:skilled@species:human#versatile#proficiencies`) are explained in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Playing: HP, slots, conditions, inventory

The build is the character's characteristics; what changes at the table lives in a separate
`CharacterState` (its own JSON). Every change is an action, checked against the rules:

```ts
import { applyAction, computePlaySheet, createState } from "srd-rules-engine";

let state = createState(build, catalog);        // full HP, starting gear (armor worn), gold
({ state } = applyAction(build, state, catalog, { type: "damage", amount: 9, damage_type: "fire" }));
({ state } = applyAction(build, state, catalog, { type: "add_item", item: "weapon-1", base: "longsword" }));
const { notes } = applyAction(build, state, catalog, { type: "short_rest", hit_dice: [{ die: 10 }] });
computePlaySheet(build, state, catalog).play;   // hp, hit dice, slots, uses, conditions, inventory…
```

Actions cover damage (resistances, temporary HP, dropping to 0, death saves, massive damage,
Concentration DCs), healing, Short and Long Rests, spell and Pact slots, limited-use features
(Rage, Channel Divinity, Second Wind…), features you switch on and off (`activate`,
`deactivate`: Rage), conditions and Exhaustion (their effects show on the
sheet), Heroic Inspiration, items (equip, attune up to 3 with class restrictions, potions,
charges), the starting equipment for a state made before the build had it
(`take_starting_equipment`), coins, and today's picks for "after a rest" choices such as prepared spells: those
live in the state, so the build keeps its starting picks. An impossible action throws
`PlayError` with the reason. Magic items change the sheet: +1 weapons and armor, Ring of
Protection, Gauntlets of Ogre Power, Bracers of Defense, resistances…

After the build changes (a level-up, an edit), `reconcileState` fits the state to it again.

### Combat: attacks and damage

```ts
import { applyAction, combatantFromCharacter, makeAttack, roll, seededRng } from "srd-rules-engine";

roll("2d6+3", seededRng(42));
// { dice_expression: "2d6+3", rolls: [4, 3], modifier: 3, total: 10 }  ← same result every time

// A combatant is a creature as combat sees it: AC, HP, saves, attack lines, defenses…
const attacker = combatantFromCharacter(fighterBuild, fighterState, catalog);
const target = combatantFromCharacter(rogueBuild, rogueState, catalog);
const result = makeAttack(attacker, "Greatsword", target, { mode: "advantage", rng: seededRng(1) });
// result.hit, result.critical_hit, result.damage (rolled parts), result.outcome (a preview)
if (result.hit) {
  ({ state: rogueState } = applyAction(rogueBuild, rogueState, catalog, {
    type: "damage", instances: [...result.instances], critical: result.critical_hit,
  }));
}
```

Combat functions change nothing: they return the rolls and the play actions that apply them,
and you (or an encounter) apply those to the target. A natural 1 always misses; a natural 20 (19
for a Champion) is a Critical Hit, which hits whatever the AC and doubles every damage die.
`rollSavingThrow(combatant, "dex", 15)` rolls a save with the sheet's bonus and Advantage.
Conditions count on their own: attacking a Prone goblin from within 5 feet rolls with Advantage
(`result.reasons` says why), a hit on a Paralyzed one within 5 feet is a Critical Hit, and it
fails Dexterity saves; pass `within_5ft: false` for an attack from farther away. Without an
`rng`, rolls use `Math.random()`.

Attack lines on the sheet carry their damage ready to roll (`damage_parts`), and `takeDamage`
applies Resistance, Vulnerability, Immunity, Temporary Hit Points and dropping to 0:

```ts
const greatsword = sheet.attacks.find((a) => a.name === "Greatsword")!;
const hit = rollDamage(greatsword.damage_parts, { critical: true, rng: seededRng(3) });
takeDamage({ hp: 7, temp: 0, max: 7 }, hit.parts.map((p) => ({ amount: p.total, type: p.type })),
  { resistances: ["slashing"] });
// { dealt, absorbed, hp, temp, dropped_to_zero, died, death_save_failures, concentration_dc, notes,
//   messages }
```

Class features that change attacks are data. Rage is a feature you switch on:
`{ type: "activate", key: "barbarian:rage" }` spends a use and applies Resistance, Rage Damage
(already in the attack lines) and Strength Advantage until it ends. Optional extra damage is
listed on each attack line (`riders`) and added on request, checking its conditions:
`makeAttack(rogue, "Dagger", target, { mode: "advantage", riders: [{ rider: "sneak-attack" }] })`.

### Spells

```ts
import { castSpell, lookup } from "srd-rules-engine";

const fireball = lookup(catalog.spells, "fireball")!;
const cast = castSpell(wizard, fireball, [goblin, orc], { slot_level: 5, rng: seededRng(7) });
// cast.targets[i]: the save, damage instances and the play actions that apply them
// cast.caster_actions: [{ type: "spend_slot", level: 5 }]
```

Catalog spells carry their `mechanics`: attack or save (half damage on a success), damage by
type, upcasting, Cantrip Upgrade, healing, conditions, darts and rays, a save after an attack,
hit riders and areas that last (Moonbeam, Spirit Guardians, Spike Growth). 72 SRD spells have
mechanics, each
reviewed against the SRD text; the others are cast with their text (slot and Concentration
only).

### Monsters

All 330 SRD stat blocks (monsters and animals) are in `catalog.monsters`: AC, HP, speed,
abilities, saves, defenses, CR, and their attacks and saving throw effects as data.

```ts
import { combatantFromMonster, makeAttack, useSaveAction } from "srd-rules-engine";

const dragon = combatantFromMonster(lookup(catalog.monsters, "adult-red-dragon")!);
makeAttack(dragon, "Rend", fighter);                        // Multiattack: three per action
useSaveAction(dragon, "Fire Breath", [fighter, rogue]);     // Dexterity save, half on a success
```

### Encounters

An `Encounter` is its own document: combatants in Initiative order, rounds and turns, what each
has spent this turn, monsters' HP and conditions, and timed effects. Characters are referenced by
key; their changed states come back in `states`.

```ts
import { applyEncounterAction, createEncounter } from "srd-rules-engine";

const ctx = { catalog, characters: { aerin: { build, state } } };
let encounter = createEncounter();
for (const action of [
  { type: "add_character", character: "aerin" },
  { type: "add_monster", monster: "goblin-warrior" },
  { type: "add_monster", monster: "goblin-warrior" },   // goblin-warrior-2
  { type: "roll_initiative", group: true },
  { type: "start" },
]) ({ encounter } = applyEncounterAction(encounter, action, ctx));

const { states, notes } = applyEncounterAction(encounter,
  { type: "attack", id: "aerin", target: "goblin-warrior", attack: "Greatsword" }, ctx);
// notes, for example: ["Aerin hits Goblin Warrior with Greatsword (19 vs AC 15): 11 slashing.",
//                      "Goblin Warrior drops to 0 Hit Points and dies."]
```

The encounter enforces the turn rules: one action and one Bonus Action on your turn, a reaction
once a round, movement up to your Speed (Dash doubles it), Extra Attack and Multiattack,
Opportunity Attacks, Dodge, Disengage, Help, Grapple and Shove (and escaping a grapple), Hide and
Search, Ready (an attack, a spell held with Concentration, a move or Help, taken with `release`),
Study, Influence and Utilize, the
Light property's extra attack (two-weapon fighting), Weapon Mastery properties (Graze, Vex, Sap,
Slow, Topple, Push, Cleave, Nick), positions on a 5-foot grid (optional: reach, range, close
combat, spell range, cover, Opportunity Attacks when leaving reach, areas of effect choosing their
targets; a map of walls, blocked squares and Difficult Terrain that moves find their way around,
cover and lines of effect worked out from it, and wall spells), exploring outside a fight
(moves without a limit, in turns of Speed; the travel pace; points of interest the GM reveals,
noticed by Passive Perception or a Search), casting times, monsters' spells (through the action that
lists them, with daily uses and fixed levels), class features used in turns (`feature`: Second Wind, Action Surge, Flurry of
Blows, Stunning Strike, Bardic Inspiration…), and decisions after a roll (Bardic Inspiration,
Legendary Resistance, Uncanny Dodge): with `decisions: "ask"` the action stops and shows the roll
so the player or GM can choose (`decide`), with `"auto"` the engine uses them only when they can
change the outcome (`cast`), once-per-turn riders (Sneak Attack), recharges (a
breath weapon on 5–6), conditions with durations (`effects` with `{ rounds: 10 }` or
`{ until: { at: "end" } }`), Concentration saves when damaged, a Concentration spell's
conditions ending with it, and Rage ending when it isn't extended. Played by hand
(`manual: true`), an action is a dice roller, like a virtual tabletop's: the engine rolls its
dice and spends its resources, with no target and no action economy, and the table applies the
outcome with `effects`. A GM can rule that something happens anyway: `force: true` applies an
action refused for its legality (turn, economy, range, movement, resources), noting the override.

What a combatant can do now, for a UI's buttons: `combatantOptions(encounter, id, ctx)` lists
every attack, spell, feature, monster ability, legendary action and standard action as an
encounter action ready to send, with its cost, candidate targets (in reach or range when
positioned), slot levels and uses left, and whether the engine would take it now or why not.
Allowed options against a creature carry `odds`: the chance to hit and to score a Critical Hit, or
that the target fails its save, and the average damage, from the same modifiers the engine would
use (`attackOdds`, `failOdds`, `averageDamage` for your own). `checkAction(encounter, action, ctx)` answers the same for one action by a dry run of
`applyEncounterAction`, so the options never disagree with the engine.

```ts
import { checkAction, combatantOptions } from "srd-rules-engine";

const options = combatantOptions(encounter, "aerin", ctx);
// options.attacks[1]: { label: "Greatsword +5 · 2d6+3 slashing", cost: "attack", available: true,
//   action: { type: "attack", id: "aerin", attack: "Greatsword", target: "goblin-warrior" }, … }
checkAction(encounter, { type: "dodge", id: "goblin-warrior" }, ctx);
// { ok: false, reasons: ["It isn't Goblin Warrior's turn: only a reaction can Dodge"] }
```

Each result also has `events`: what the action changed, as data (a turn, a move with its path,
HP before and after, conditions, Concentration, the economy and resources spent, effects,
zones), for animations and a combat log. A refusal's `EncounterError` has a `codes` entry per
message (`not_your_turn`, `out_of_range`, `off_map`, `total_cover`, `no_resources`…). Undo: an action's
result lists the dice it drew (`rolls`), so a history (`createHistory`, `recordAction`)
replays to the same state, and `undoAction` replays all but the last action.

Previews for a map, before anything is sent: `reachableSquares(encounter, id, ctx)` (every
square a combatant can end a move on, with its cost), `previewMove(encounter, { id, to }, ctx)`
(the path, its cost, the zones on the way and the Opportunity Attacks it would provoke) and
`previewArea(encounter, { id, spell, area: { point } }, ctx)` (the squares an area would cover
and the creatures in it, with their cover).

## Command line

```bash
npx srd-rules build                    # interactive level 1 character builder
npx srd-rules build --load characters/aerin.json --seed 7
npx srd-rules play --load characters/aerin.json   # track HP, slots, items in play
npx srd-rules fight --load characters/aerin.json --load characters/brakka.json \
  --monster goblin-warrior --monster goblin-warrior --ask   # run an encounter
npx srd-rules serve --port 8000        # HTTP API
npx srd-rules validate my-homebrew/    # check a content pack
npx srd-rules build --content my-homebrew/   # build with homebrew layered over the SRD
                                             # (save records the packs the build needs)
```

The builder walks you through Class, Species, Background, Ability Scores, Equipment,
Features, Spells, Skills & Tools, Languages, and Name & Alignment, in dependency order, and you can
jump between steps at any time. A live panel shows HP, AC, Initiative, Speed and Passive
Perception. Options you can't pick are greyed out with the reason, and picks that change
your numbers show a preview (`Defense · AC 16→17`). `save` writes the build to
`characters/<name>.json`. Builds saved by the earlier Python version of the builder load
unchanged. Builds, play states and encounters record their format `version`, so later formats
can migrate them.

Once level 1 is complete, `up` levels up the character: pick a class
(your own, or a new one if you meet the multiclass prerequisites, with the reason shown when
you don't), take the fixed Hit Points or roll, then answer that level's choices (subclass, feat
or Ability Score Improvement, new spells, invocations…). Where the rules allow it, each
level-up also offers optional replacements ("Replace one: Bard cantrips", Eldritch Invocations,
Metamagic, the Fighter's Fighting Style…). `L5` revisits level 5, and `down` removes the last
level.

`edit` changes the past without rebuilding: pick a level, then its class, Hit Points or any
choice (say, the subclass you chose at level 3 on a level 7 character). Before anything
changes you see a preview: which later picks no longer fit and will be removed (and asked
again), and which new questions appear. Picks that still fit are kept. A change that would
make a later level illegal (a multiclass prerequisite no longer met, say) is refused, with the
reason.

`play` tracks a built character at the table with short commands: `dmg 7 fire`, `heal 5`,
`short 10 10`, `long`, `slot 2`, `use 1`, `on 1` / `off 1` (Rage), `cond poisoned`, `exh 1`,
`prep 1` (today's prepared spells), `add weapon-1 base=longsword`, `equip 3`, `attune 3`,
`money +5gp`; `help` lists them.
`save` writes `characters/<name>.state.json`; resume it with `--state`.

`fight` runs an encounter: the characters given with `--load` (each resuming its play-mode
state file, if there is one) against the `--monster`s. Initiative is rolled, and every turn
shows the order with HP, AC, conditions and Concentration. Whoever's turn it is acts with short
commands (`attack goblin greatsword`, `cast fireball 2 3`, `feature second wind`, `dodge`,
`help brakka`, `grapple 2`, `use fire breath brakka lute`); `as dragon legend pounce brakka`
acts for someone else (legendary actions, reactions). Targets are ids, names, numbers from the
order, or the start of a word ("dragon"). `options` lists what a combatant can do. With `--ask`,
decisions after a roll are y/n questions that show the roll, defaulting to the engine's
recommendation; `ask on|off` changes it mid-fight, for everyone or one combatant. `save` (or
quitting) writes the characters' state files and `encounter.json`; resume with
`--encounter characters/encounter.json`. `place brakka 0 0` puts a combatant on a 5-foot grid,
`move 3 2` moves to a square, `map` draws it; with positions, reach, range and cover are checked.
Areas take a point or a direction instead of targets: `cast fireball @12,4`,
`use fire breath >10,2`.

## HTTP API

`createHandler()` returns a Web-standard `(Request) => Promise<Response>`, so it deploys
unchanged to most runtimes:

```ts
import { createHandler } from "srd-rules-engine/http";
const handler = createHandler({ cors: true });

Deno.serve(handler);                              // Deno
Bun.serve({ fetch: handler });                    // Bun
export default { fetch: handler };                // Cloudflare Workers
// Node: import { serveNode } from "srd-rules-engine/node"; serveNode(handler, { port: 8000 })
```

| Route | |
|---|---|
| `GET /health` | Liveness check |
| `GET /v1/content` · `/v1/content/{table}` · `/v1/content/{table}/{id}` | Browse the catalog |
| `GET /v1/content/packs` | The loaded content packs (manifests), in load order |
| `POST /v1/builds/evaluate` | Build → validation report, derived sheet, level-up options, and every choice with its options |
| `POST /v1/builds/set-choice` · `/v1/builds/level-up` · `/v1/builds/remove-level` · `/v1/builds/set-level-class` · `/v1/builds/set-level-hp` | Change a build the same way the builder does (validated, repaired, with notes) |
| `POST /v1/builds/preview` | What a `set-choice` or `set-level-class` change would remove and add, without applying it |
| `POST /v1/state/new` | Build → a fresh play state |
| `POST /v1/state/apply` | `{ build, state, action }` (one action or a list, all or nothing) → `{ state, notes, messages }` |
| `POST /v1/state/sheet` · `/v1/state/reconcile` | Play sheet and state issues · fit a state to a changed build |
| `POST /v1/state/attack` | `{ attacker: {build, state}, target: {build, state}, attack, mode?, two_handed?, riders?, ally_adjacent? }` → the attack, and the target's state after the damage |
| `POST /v1/state/cast` | `{ caster: {build, state}, spell, targets: [{build, state}], slot_level?, pact? }` → the spell's results, the caster's state (slot spent, Concentration) and the targets' states |
| `POST /v1/encounters/apply` | `{ encounter, characters: { key: {build, state} }, action }` (one or a list, all or nothing) → `{ encounter, states, notes, messages, events, log, pending, applied }` (`log`: each action with the dice it drew): Initiative, turns, attacks, spells, effects on monsters and characters; a list stops at a decision to make (`pending`), answered with `{ type: "decide", use }` |
| `POST /v1/encounters/options` | `{ encounter, characters, id }` → what that combatant can do now (`combatantOptions`; schema in `schemas/options.schema.json`) |
| `POST /v1/encounters/reachable` · `/preview-move` · `/preview-area` | `{ encounter, characters, id }` (+ `to` or `path`; + `area` and `spell`, `ability` or `legendary`) → where it can move, what a move or an area would do (schemas in `schemas/`) |
| `POST /v1/encounters/check` | `{ encounter, characters, action }` → `{ ok, reasons }`: whether the engine would take the action now, without applying it |
| `POST /v1/combat/roll` | Roll a dice expression (`{"expression": "2d6+3"}`) |

Routes that take a hand-filled `Character` snapshot (from the earlier Python version):
`POST /v1/characters/` (validate one), `/v1/characters/{name}/alive`,
`/v1/characters/{name}/passive-perception`, `/v1/combat/saving-throw` and `/v1/spells/stats`.
Attacks and spells use builds and states (`/v1/state/attack`, `/v1/state/cast`) or an
encounter.

Invalid bodies return `422` with a readable message; bad JSON, bad dice expressions and refused
setters or actions return `400` with the reasons in `detail`, as messages to translate in
`details` (and an encounter's refusal codes in `codes`); unknown routes and entities `404`.

## Homebrew and custom content

A content pack is a folder laid out like [`content/srd-5.2.1/`](content/srd-5.2.1). Every
file is optional:

```yaml
# my-homebrew/feats.yaml
# yaml-language-server: $schema=../node_modules/srd-rules-engine/schemas/feats.schema.json
- id: lucky-streak
  name: Lucky Streak
  source: homebrew
  category: origin
  grants:
    effects: [{target: initiative, value: 1}]
    choices: [{id: skill, label: Lucky Streak skill, kind: skill}]
```

```ts
import { createCatalog, loadContentPack, srdPack } from "srd-rules-engine/node";
const catalog = createCatalog(srdPack, loadContentPack("my-homebrew"));
```

Leave out `source` and entities take the pack's name (`my-homebrew` above). A pack can also
have:

- a manifest (`pack.yaml`: id, version, default source, the packs it requires);
- `patches.yaml`, which changes entities of earlier packs in place instead of copying them:
  `{target: spells/light, op: append, path: lists, value: warlock}`.

`createCatalog([srdPack, pack], { sources: ["srd-5.2.1", "my-homebrew"] })` keeps only the
sources a campaign allows, and a build records the packs it needs. The `$schema` comment gives
you autocompletion and inline errors in VS Code (with the YAML extension) and other editors. See
[`examples/homebrew-pack`](examples/homebrew-pack) and [docs/CONTENT.md](docs/CONTENT.md).

This repository only holds SRD content and invented homebrew: CI fails on anything else. Keep
content from other books in your own (private) packs.

## Using it from another language

The engine is TypeScript, but you don't need TypeScript to use it:

- **Data only:** `srd-5.2.1.json` holds every validated entity (monsters included) with
  defaults filled in, and `schemas/` describes content files, pack manifests, patches, saved
  builds, play states (`state.schema.json`), encounters (`encounter.schema.json`) and the actions
  that change them (`play-action.schema.json`, `encounter-action.schema.json`: one action or a
  list).
- **Rules as a service:** run `npx srd-rules serve` (or deploy the handler) and call
  `POST /v1/builds/evaluate`, `/v1/state/apply` or `/v1/encounters/apply` from Python, Go, C#,
  GDScript, or anything else.

## Status

| Area | Coverage |
|---|---|
| Character creation | Complete: all 12 SRD classes, 9 species, 4 backgrounds |
| Levels | 1–20 with multiclassing (prerequisites, partial proficiencies, combined spell slots, Pact Magic), fixed or rolled Hit Points, Ability Score Improvements, feats with prerequisites, Epic Boons |
| Class features | Every SRD class feature to level 20 and every SRD subclass (one per class). Numbers the sheet computes: HP, AC options (Unarmored Defense, Draconic Resilience, Mage Armor), Extra Attack, Martial Arts, Expertise, Jack of All Trades, Aura of Protection, Champion critical range, speed bonuses, subclass spells. In rolls: Danger Sense, Reckless Attack, Feral Instinct, Frenzy, Evasion, Reliable Talent, Divine and Primal Strike, Sneak Attack, Colossus Slayer, Potent Spellcasting, Potent Cantrip, Empowered Evocation, Elemental Affinity. Used in turns: Second Wind, Action Surge, Indomitable, Lay On Hands (and its cure), Flurry of Blows, Patient Defense, Step of the Wind, Stunning Strike, Deflect Attacks, Uncanny Dodge, Cunning Strike, Brutal Strike, Relentless Rage, Bardic Inspiration, Innate Sorcery, Channel Divinity (Divine Spark, Turn Undead, Sacred Weapon), Agonizing Blast; the rest is shown as the SRD text |
| Spells | All 339 SRD spells with full text; class spell choices by level, Wizard spellbook, Magical Secrets, Mystic Arcanum, Eldritch Invocations, Metamagic; casting with modeled mechanics (attack or save, upcasting, Cantrip Upgrade, healing, conditions, darts and rays, Ice Knife's save, Guiding Bolt's Advantage, lasting areas, walls, marks and smites) for 84 reviewed spells; the rest are cast with their text |
| Changing choices | Every SRD replacement rule: one pick per level for "whenever you gain a level" features, free lists for "after a Long Rest" ones; changing any past choice, a past level's class or Hit Points, with a preview and legality checks |
| Play | Session state: HP, death saves, rests, slots, limited uses, features switched on (Rage), conditions and Exhaustion, Concentration, inventory with 275 SRD magic items (attunement, charges, potions) and 100 priced items of gear, coins, buying and selling, prepared spells for the day |
| Combat | Attacks from the sheet's attack lines (Advantage, critical range, Versatile), damage with Resistance, Vulnerability, Immunity and Temporary HP, Bloodied, saving throws, ability and skill checks, damage riders (Rage Damage, Sneak Attack, Divine Strike), Advantage on saves, conditions changing rolls (Prone, Restrained, Blinded, Invisible, Poisoned; automatic Critical Hits and failed saves while Paralyzed or Unconscious) |
| Monsters | All 330 SRD stat blocks (monsters and animals) as data: AC, HP, speed, abilities, saves, defenses, CR; attacks, Multiattack, saving throw effects (breath weapons), spellcasting (97 casting actions: spell lists, daily uses, fixed levels), "X/Day" limits, legendary actions and Legendary Resistance usable in combat; auras, Death Burst, Regeneration and Aura of Authority in turns; other traits as text |
| Encounters | Initiative (surprise, group rolls, ties), rounds and turns, action / Bonus Action / reaction, movement and Dash, Opportunity Attacks, Dodge, Disengage, Help, Grapple and Shove, standing up from Prone, two-weapon fighting, Weapon Mastery properties, Help, Vex, Sap and Guiding Bolt on spell attacks, spell areas that last (zones), casting times, recharges, once-per-turn riders, conditions with durations, Concentration saves and Concentration effects, Death Saving Throws at the start of the turn, Rage's duration, walls and Difficult Terrain on the grid, cover and line of effect from them, exploring and points of interest; what a combatant can do now, with the reasons for what it can't |
| Content packs | Manifests, patches, filtering by source, builds that record their packs, JSON Schemas for editors, a leak guard for this repository; the SRD split by table for browsers, catalogs with only some tables |
| Not yet | Ringed and domed spell walls, most other class features' dice (shown as text), magic items' active powers |

What comes next is in [docs/ROADMAP.md](docs/ROADMAP.md); the design is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Project layout

| Path | Contents |
|---|---|
| `src/rules/` | Pure rules logic: dice, ability scores, build resolution and validation, sheet, damage, combatants and attacks, casting |
| `src/services/` | Workflows: the character builder (setters, normalization), play state (actions), encounters, `Character` hit point helpers |
| `src/models/` | Zod schemas and types for content, packs and patches, builds, play states, encounters |
| `src/content/` | Catalog creation and validation, the bundled SRD, loading content from disk |
| `src/http/` | HTTP API (`fetch` handler) and the Node server adapter |
| `src/cli/` | The `srd-rules` command: interactive builder, `play`, `serve`, `validate` |
| `content/srd-5.2.1/` | Rules content as YAML: the source of truth |
| `schemas/`, `src/content/data/` | Generated by `npm run content` (JSON Schemas, bundled SRD JSON) |
| `examples/homebrew-pack/` | A sample content pack layered over the SRD |
| `examples/battle-demo.ts` | The demo battle (`npm run demo`), checked by `tests/demo.test.ts` |
| `scripts/` | Content compiler, leak guard, importers from the SRD Markdown |
| `docs/` | [Architecture](docs/ARCHITECTURE.md), [content authoring](docs/CONTENT.md), [roadmap](docs/ROADMAP.md) |

## Development

```bash
npm install
npm test               # vitest
npm run check          # content up to date + leak guard + lint + typecheck + tests (what CI runs)
npm run builder        # run the CLI builder from source
npm run content        # recompile content/ YAML → bundled JSON + JSON Schemas
npm run build          # build dist/
```

The importers regenerate SRD content from the SRD 5.2.1 Markdown in `docs/srd-5.2.1/` (not
committed; see [DATA-SOURCES.md](DATA-SOURCES.md)): `npm run content:import-classes` (Python),
`content:import-spells`, `content:import-items`, `content:import-monsters`. The TypeScript ones
take `--report` to list what became data and what stayed text.

Contributions are very welcome, especially content (classes, feats, spells).
[CONTRIBUTING.md](CONTRIBUTING.md) explains how.

## License and attribution

The code is licensed under the [MIT License](LICENSE).

This work includes material taken from the System Reference Document 5.2.1 ("SRD 5.2.1") by
Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is
licensed under the Creative Commons Attribution 4.0 International License, available at
https://creativecommons.org/licenses/by/4.0/legalcode. [DATA-SOURCES.md](DATA-SOURCES.md)
lists where each piece of content comes from.

This project is not affiliated with, endorsed, sponsored, or approved by Wizards of the Coast.
