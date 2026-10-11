# SRD Rules Engine — Claude Guide

## Stack
- TypeScript (strict, `noUncheckedIndexedAccess`), Node ≥ 22.18 for development, ESM-first
- **Zod v4** for all schemas (content, builds, API payloads); types are inferred from schemas
- **vitest** for tests, **Biome** for lint + format, **tsdown** for the build (ESM + CJS + d.ts)
- No runtime dependencies besides `zod` and `yaml`

## Project layout

```
src/
  index.ts         # public API (platform-neutral: no node:* imports, no bundled SRD data)
  srd.ts           # `srd-rules-engine/srd`: srdCatalog/srdPack (the bundled SRD JSON)
  node.ts          # index + srd + loadContentPack/loadCatalog + serveNode
  models/          # Zod schemas + types: content, pack (manifest, patches), build, state (play),
                   #   encounter, options (computed), character, combat, spell
  content/         # catalog.ts (createCatalog, lookup, `tables`), load.ts (fs, Node only),
                   #   srd.ts (bundled SRD), split.ts (splitPack/loadPack: per-table JSON)
  content/data/    # GENERATED srd-5.2.1.json — do not edit, run `npm run content`
  rules/           # pure logic: dice, rng, ability-scores, casting, combat, combatant, damage, spells,
                   #   areas, grid (map: steps, walls, paths), build-resolution, build-validation, sheet
  services/        # builder.ts (setters + normalize + evaluate), play.ts (play state actions),
                   #   encounter.ts (initiative, turns, action economy, effects on combatants),
                   #   options.ts (what a combatant can do now: combatantOptions, checkAction),
                   #   previews.ts (reachableSquares, previewMove, previewArea), events.ts
                   #   (result events by diffing), refusals.ts (refusal codes), history.ts (undo),
                   #   combat.ts (HP, attacks, spells)
  http/            # index.ts: fetch handler (platform-neutral); node-server.ts: node:http adapter
  cli/             # srd-rules bin: build (interactive builder), play, fight, serve, validate
content/srd-5.2.1/ # rules content as YAML (source of truth)
schemas/           # GENERATED JSON Schemas for content files and builds
scripts/           # compile-content.ts; check-sources.ts (leak guard: SRD/homebrew only);
                   #   import-srd-spells.ts (SRD Markdown → spells.yaml);
                   #   import-srd-items.ts (→ magic-items.yaml, conditions.yaml);
                   #   import-srd-gear.ts (→ gear.yaml, prices in tools.yaml);
                   #   import-srd-monsters.ts (→ monsters.yaml; FIXES for garbled values);
                   #   import-srd-classes.py (Python: class levels 2–20, subclasses, features, feats;
                   #   level-2+ mechanics live in its OVERLAY tables, not in the generated YAML)
examples/          # homebrew-pack (tested in tests/content.test.ts); battle-demo.ts (`npm run demo`,
                   #   a seeded battle; tests/demo.test.ts snapshots its story)
docs/              # ARCHITECTURE.md (design, flagged interpretations), CONTENT.md (authoring
                   #   guide), ROADMAP.md (done, decisions, next steps)
  srd-5.2.1/       # SRD 5.2.1 Markdown: authoritative rules reference (git-ignored)
tests/             # vitest; classes.test.ts: every class × species × background completes;
                   #   levels.test.ts: every class to 20, seeded random multiclass paths to 20
```

## Key conventions

- **Inform, don't decide policy.** The engine is for any client, so it's as general as possible:
  it reports everything the rules say (every refusal reason with its code and category, rolls,
  costs) and the caller chooses what to enforce. Play by hand, GM overrides, table settings are
  the client's policies: no app-specific modes or flags threaded through the reducers. Answer a
  mode-shaped request with general information or primitives (see the workspace CLAUDE.md).

- **rules/** is pure logic: no I/O. `src/index.ts` and `src/http/` must stay platform-neutral.
  `src/index.ts` never imports `content/srd.ts` (the bundled data): import `srdCatalog` from
  `src/srd.ts` (tests: `../src/srd`).
- Data is **immutable** and **snake_case** (shared wire/file format); functions are camelCase.
  Builds change via `updateBuild(build, {...})`; setters return `{ build, notes }`.
- Look up catalog ids with `lookup(table, id)` (never `table[id]` / `id in table`).
- All dice functions take an optional `Rng` (`{ rng }` options bag); tests use
  `seededRng`, `scriptedRng`, `fixedRng`.
- D&D 5e rule: critical hits double all dice (not the modifier); nat-1 always misses; nat-20 always hits.
- Saving throw damage: half (rounded down) on success, full on failure.
- Combat works on `Combatant`s (`rules/combatant.ts`: a read-only view; `combatantFromCharacter`
  in `services/play.ts`). `makeAttack` returns rolls + damage `instances`; the caller applies
  them (play action `{ type: "damage", instances, critical }`).
- Public API: `src/index.ts` exports by name (no `export *`); add a new public function there
  and update `tests/__snapshots__/api.test.ts.snap`. Saved documents (build, state, encounter)
  have `version` (`DOCUMENT_VERSION`): a breaking format change raises it and migrates older
  documents on parse.
- Spells: `mechanics` on catalog spells, written by import-srd-spells.ts (never hand-edited in
  spells.yaml): parser drafts used only for ids in `REVIEWED` (each checked against the SRD
  text), `REJECTED` drafts with a reason, hand-written `MECHANICS` (win). `--report` lists drafts
  and skips. `castSpell` in `rules/casting.ts`; `tests/casting.test.ts` snapshots all mechanics.
- Encounters: `Encounter` is its own document (monsters inside, characters by key); change it only
  via `applyEncounterAction` (JSON actions, `EncounterError`); character changes come back in
  `states` and go through `applyAction`. Turn hooks (`endTurn`/`startTurn` in
  `services/encounter.ts`) run timed effects, Rage's extension, recharges and once-per-turn
  resets; `sweep()` ends Concentration effects after every action. Choices made after a roll
  (Bardic Inspiration, Legendary Resistance, Uncanny Dodge) go through the `decide` callback
  (`Decision`); `ask` mode stops the action (`encounter.pending`) and `decide` replays it with
  the recorded dice, so an action must roll only through `rng` (undo replays histories the same
  way). Results carry `events` (diffed, `services/events.ts`) and `rolls`; a new refusal message
  may need a pattern in `services/refusals.ts`.
- Conditions change rolls through data (`attack_rolls`, `attacked`, `fail_saves`… in
  conditions.yaml, from the CONDITIONS overlay in import-srd-items.ts) merged into
  `Combatant.condition_rolls`; `attackMode` / `resolveMode` combine them, never ad hoc checks.
- Taking damage always goes through `takeDamage` in `rules/damage.ts` (Resistance, temp HP,
  0 HP, death); attack damage is `DamagePart[]` (`rollDamage`), never parsed from display text.
- Rules content is data: every entity has a slug `id` and a `source` (default: the pack's name).
  After editing `content/`, run `npm run content` and commit the generated files.
- This repo holds only SRD 5.2.1 content and invented homebrew (`source: homebrew` or `test`),
  including examples and test fixtures; `npm run check:sources` enforces it. Non-SRD content
  belongs in a separate private pack.
- Packs: `pack.yaml` (id, `requires`, default `source`) + `patches.yaml` (edit earlier packs'
  entities by path; never copy an SRD entity to tweak it). `catalog.packs` = loaded manifests.
  Changing a public export updates `tests/__snapshots__/api.test.ts.snap`: note it in CHANGELOG.
- Effect `target`/`when` values are closed lists in `src/models/content.ts`: a new target needs
  an entry there and a consumer in `rules/sheet.ts`. Extra attack damage = `damage_riders`
  (automatic → in `damage_parts`; optional → `AttackLine.riders`, applied by `makeAttack`);
  Advantage = `advantages`; features switched on in play = `toggles` (`state.active`,
  `activate`/`deactivate`), whose grants apply while active.
- A new class feature should be data first (grants, choice kinds, effects, `ac_calculations`);
  add a named rule in `rules/sheet.ts` only when it can't be expressed declaratively, and list
  it under "Named rules in code" in `docs/ARCHITECTURE.md`.
- Levels: `build.levels` = `[{ class_id, hp }]` for levels 2+ (build level 1, then level up
  one level at a time). Class content = `grants` (core) + `multiclass` + `features` by level; sources are
  `class:<id>` (first level in it), `class:<id>:<n>`, `subclass:<id>:<n>`. Every source/choice
  has `level` (character level); use `choicesForLevel(n)` / `issuesForLevel`.
- Changing choices: "gain a level → replace one" families = same `tag` + `swap`; the engine adds
  optional `#replace:<scope>:<tag>` choices answered `[old, new]`. "After a rest" lists use
  `scaling`. Aggregations must use `Resolution.contributed()`, not `selected()`.
- Override: choices are judged as of their own level (`at(choice)` in option views); every
  setter returns through `commit()` (refuses new validation errors); `previewChange` diffs.
- Play state: `CharacterState` (separate JSON) stores only what's spent/chosen at the table;
  maxima come from the build. Change it only via `applyAction` (JSON actions, `PlayError` on
  refusal); every result goes through `reconcileState`. `rest_change` choices can be re-picked
  in play (`state.choices`, overlaid by `playBuild`). Limited uses = `resources` in grants.
- Character builder: a `CharacterBuild` stores only choices, keyed by choice key
  (`<source key>#<choice id>`, e.g. `class:fighter#skills`). Derived values are always
  recomputed by `rules/sheet.ts`, never stored. See `docs/ARCHITECTURE.md`.
- Docs: a rules reading the SRD doesn't settle goes under "Interpretations (flagged, not
  invented)" in `docs/ARCHITECTURE.md` (by area); something left for later goes in
  `docs/ROADMAP.md` ("Next steps"). Behaviour changes update README (usage, status table,
  routes), ARCHITECTURE, CONTENT and CHANGELOG.

## Common commands

```bash
npm test                 # run tests
npm run check            # content up to date + leak guard + lint + typecheck + tests (CI)
npm run format           # biome format + safe fixes
npm run content          # YAML → bundled JSON + JSON Schemas
npm run build            # dist/
npm run builder          # interactive builder from source (-- --load x.json --seed N --no-color)
npx tsx src/cli/main.ts validate examples/homebrew-pack   # validate a content pack
npx tsx src/cli/main.ts play --load characters/x.json [--state x.state.json]   # play mode
npx tsx src/cli/main.ts fight --load a.json --load b.json --monster goblin-warrior [--ask]  # encounter
npm run serve            # HTTP API on localhost:8000
npx tsx scripts/import-srd-spells.ts --report     # spell mechanics: drafts (NEW), reviewed, skips
npx tsx scripts/import-srd-monsters.ts --report   # monsters: what became data, what stayed text
```

## Where things go

- New rules logic → `src/rules/` (pure functions, optional `{ rng }`), exported from `src/index.ts`.
- New content (class, feat, species…) → YAML in `content/srd-5.2.1/` (SRD only; homebrew needs its
  own `source` and folder), then `npm run content` and a concrete-character test in `tests/sheet.test.ts`.
- New content field or table → Zod schema in `src/models/content.ts` (+ `TABLE_SCHEMAS` in
  `src/content/catalog.ts` for a new table), then `npm run content` to regenerate `schemas/`.
- New HTTP route → `routes` in `src/http/index.ts` (validate the body with a Zod schema) + a test
  in `tests/http.test.ts` + the route table in README.md.
- Node-only code (fs, `node:*`) → `src/content/load.ts`, `src/http/node-server.ts` or `src/cli/`;
  export it from `src/node.ts`, never from `src/index.ts`.

## Generated files (don't edit by hand)

- `src/content/data/srd-5.2.1.json` and `schemas/*.schema.json`: from `npm run content`.
  CI fails (`npm run content -- --check`) if they're out of date, so commit them. It also reports
  the bundle's size and fails over `MAX_GZIP_KB` (whole) or `MAX_CORE_GZIP_KB` (`CORE_TABLES`),
  gzipped, in `scripts/compile-content.ts`.
- `dist/srd-5.2.1.json` and `dist/srd-5.2.1/*.json` (split by table) are written minified by
  the build (`tsdown.config.ts`).
- `dist/`: from `npm run build` (git-ignored).

## API base

`GET /health` — liveness check  
`GET /v1/content` — table names and counts; `/v1/content/{table}`, `/v1/content/{table}/{id}`;
`/v1/content/packs` — loaded pack manifests  
`POST /v1/builds/evaluate` — build → `{ report, sheet, levels, level_up_options, choices (with options) }`  
`POST /v1/builds/set-choice` · `/level-up` · `/remove-level` · `/set-level-class` · `/set-level-hp` — workflow setters  
`POST /v1/builds/preview` — effect of a set-choice / set-level-class change, without applying it  
`POST /v1/state/new` · `/apply` · `/sheet` · `/reconcile` — play state (HP, slots, conditions, inventory)
`POST /v1/state/cast` — cast a catalog spell (slot spent, effects applied to targets' states)
`POST /v1/state/roll` — roll an attack, spell or feature by hand (`rollByHand`): dice + costs, nothing spent
`POST /v1/encounters/apply` — encounter actions (initiative, turns, economy, effects on combatants)
`POST /v1/encounters/options` — what a combatant can do now (`combatantOptions`);
`/v1/encounters/check` — would the engine take an action (dry run, `checkAction`)  
`POST /v1/encounters/reachable` · `/preview-move` · `/preview-area` — map previews  
`POST /v1/state/attack` — one character attacks another (combatants); damage applied to the target's state  
`POST /v1/characters/` — validate a `Character`  
`POST /v1/characters/{name}/alive` — is the character above 0 HP  
`POST /v1/characters/{name}/passive-perception` — passive Perception (`?proficient=true`)  
`POST /v1/combat/roll` — roll any dice expression (`{"expression": "2d6+3"}`)  
`POST /v1/combat/saving-throw` — saving throw  
`POST /v1/spells/stats` — spell save DC + attack bonus (`Character`)

Errors: 422 invalid body (Zod), 400 bad JSON, dice expression, or a refused setter/action (`detail`: messages), 404 unknown route/entity,
405 wrong method. `createHandler({ catalog, rng, basePath, cors })` configures it.
