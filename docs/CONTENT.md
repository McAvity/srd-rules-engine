# Writing content

Rules content is YAML validated against the schemas in `src/models/content.ts` (published
as `schemas/*.schema.json`). A **content pack** is a folder, and every file in it is optional:

| File | Holds | Schema |
|---|---|---|
| `pack.yaml` | The manifest: pack id, version, default `source`, required packs | `pack.schema.json` |
| `patches.yaml` | Changes to entities loaded by earlier packs | `patches.schema.json` |
| `creation.yaml` | Standard array, point buy, base grants (languages) | `creation.schema.json` |
| `species.yaml` | Species | `species.schema.json` |
| `backgrounds.yaml` | Backgrounds | `backgrounds.schema.json` |
| `classes/<id>.yaml` (or `classes.yaml`) | Classes: core traits, multiclass grants, features by level 1–20, table columns | `classes.schema.json` |
| `subclasses.yaml` | Subclasses (`class: <id>`, features by class level) | `subclasses.schema.json` |
| `features.yaml` | Selectable class features: Eldritch Invocations, Metamagic | `features.schema.json` |
| `feats.yaml` | Feats | `feats.schema.json` |
| `weapons.yaml`, `armor.yaml`, `gear.yaml`, `tools.yaml` | Equipment | … |
| `languages.yaml`, `masteries.yaml` | Languages, weapon mastery properties | … |
| `spells.yaml` | Spells: level, school, class `lists`, ritual, concentration, text | `spells.schema.json` |
| `magic-items.yaml` | Magic items: base item, bonuses, Attunement, charges, grants while active | `magic_items.schema.json` |
| `conditions.yaml` | Conditions: `implies`, `speed_zero`, levels (Exhaustion) | `conditions.schema.json` |
| `monsters.yaml` | Monster stat blocks: AC, HP, speed, abilities and saves, defenses, CR, traits and actions | `monsters.schema.json` |

A file can hold a single entity or a list. `.yml` and `.json` work too.

Start each file with a schema comment to get autocompletion and inline errors:

```yaml
# yaml-language-server: $schema=../../schemas/feats.schema.json
```

## Entities

Every entity has a slug `id` (lowercase letters, digits and hyphens), a `name`, a `source`
(`srd-5.2.1`, `homebrew`, …) and an optional `description`. A pack loaded after another
replaces entities that have the same id.

`source` is optional: an entity without one gets its pack's name (the folder name when loaded
with `loadContentPack`, or `homebrew` for a pack without a name). Set it explicitly when the
content comes from a specific book, so it can be told apart from the SRD.

This repository only holds SRD 5.2.1 content and invented homebrew: `npm run check` fails if
`content/` has anything but `srd-5.2.1/`, or if an example or test pack has another `source`.

## Packs: manifest and patches

`pack.yaml` names the pack and says what it needs:

```yaml
id: my-homebrew              # lowercase slug; what builds and other packs refer to
version: 0.1.0
ruleset: "2024"              # informational
source: my-homebrew          # source of entities that don't declare one (default: id)
requires: [srd-5.2.1]        # packs that must be loaded before this one
```

Without a manifest, the folder name is the pack id and the default source. Loading a pack
twice, or before a pack it requires, is an error. `catalog.packs` lists the loaded manifests.

`patches.yaml` changes an entity from an earlier pack without copying it. Patches run in order,
after the pack's own entities, and the patched entity is validated again:

```yaml
- {target: spells/light, op: append, path: lists, value: warlock}
- {target: classes/fighter, op: set, path: grants.choices.skills.count, value: 3}
- {target: spells/fireball, op: remove, path: lists, value: [wizard]}
- {target: classes/fighter, op: remove, path: grants.choices.skills}
```

- `target` is `<table>/<id>`; `path` is dotted. In a list, a segment is an index (`0`) or the
  `id` of an element (`choices.skills`). Paths see the entity with its defaults filled in, so
  `grants.effects` exists even if the YAML left it out.
- `set` replaces a value (or adds a key); `append` adds one item or a list of items to a list;
  `remove` deletes what's at `path`, or, with a `value`, removes those items (or the elements
  with those ids) from the list.
- A patch can't create an entity or change its id. It has a `source` too (default: the pack's),
  so filtering by source drops it along with the pack's entities.

To use only some sources (the books a campaign allows), pass them to `createCatalog`:
`createCatalog([srdPack, mine], { sources: ["srd-5.2.1", "my-homebrew"] })`. Creation rules
always load; an entity that refers to a filtered-out one fails the cross-reference check.

A build can list the packs it needs (`packs: [my-homebrew]`); loading it without them gives
"Needs content pack 'my-homebrew', which isn't loaded". The CLI builder records the packs
loaded with `--content` when it saves.

## Grants

Species, classes, backgrounds, feats and choice options all give the character things
through `grants`:

```yaml
grants:
  size: medium
  skills: [perception]
  tools: [thieves-tools]
  languages: [elvish]
  saving_throws: [str, con]
  armor_training: [light, medium, heavy, shield]
  weapon_proficiencies: [simple, martial, "martial:light"]   # category, category:property, or weapon id
  feats: [{feat: magic-initiate, params: {spell_list: cleric}}]   # params pre-answer the feat's choices
  resistances: [poison]
  cantrips: [prestidigitation]
  spells: [hunters-mark]                # always prepared
  spellcasting: {list: wizard, ability: int, slots: [2]}   # slots per spell level; pact: true for Warlocks
  ac_calculations: [{name: Unarmored Defense, abilities: [dex, con], shield: true}]
  items: [{item: javelin, qty: 8}]
  gp: 15
  effects:
    - {target: speed, op: set, value: 35}
    - {target: ac, value: 1, when: wearing_armor}
    - {target: initiative, value: prof}   # "prof" = Proficiency Bonus
    - {target: skill.arcana, value: wis, min: 1}   # an ability = its modifier; min = floor
  traits: [{name: Trance, text: "You don't need to sleep."}]
  choices: [...]
```

### Effects

| `target` | Ops used | Example |
|---|---|---|
| `ac` | `add` | Defense: `+1` while `wearing_armor` |
| `initiative` | `add` | Alert: `prof` |
| `speed` | `set`, `max` | Wood Elf: `max 35` |
| `darkvision` | any (highest wins) | Drow: `120` |
| `hp_per_level` | `add` | Dwarven Toughness: `1` |
| `attack.ranged` | `add` | Archery: `2` |
| `skill.<skill id>` | `add` | Thaumaturge: `wis`, `min: 1` |
| `martial_arts.die` | `max` | Monk: `6` (a d6), `8` at level 5… |
| `attacks` | `max` | Extra Attack: `2`; Fighter 11: `3` |
| `attack.critical` | `min` | Champion: `19` |
| `saves` / `save.<ability>` | `add` | Aura of Protection: `cha`, `min: 1` |
| `skill.unproficient` | `add` | Jack of All Trades: `half_prof` |
| `hp_per_class_level` | `add` | Draconic Resilience: `1` × Sorcerer level |
| `checks` | `add` | Stone of Good Luck: `1` (ability checks) |
| `score.<ability>` | `max` | Gauntlets of Ogre Power: Strength `19` |

Conditions for `when`: `wearing_armor`, `wielding_shield`, `wearing_heavy_armor`,
`not_wearing_heavy_armor`, `unarmored` (no armor and no Shield). Armor Class alternatives such as
Unarmored Defense go in `ac_calculations`, not effects, because they don't stack.

These targets and conditions are the complete list: anything else is rejected when the pack
loads ("unknown effect target 'speeed'"), and the JSON Schemas offer them for autocompletion.

### Damage riders, Advantage and toggles

Extra damage on some attacks goes in `damage_riders`; `advantages` gives Advantage on saves or
checks (`save.str`, `check.dex`), Initiative (`initiative`), attack rolls using Strength
(`attack.str`) or attack rolls against you (`attacked`), optionally `unless` you have a condition
(`{target: save.dex, unless: [incapacitated]}`: Danger Sense); a feature you switch on in play is a
`toggle`, whose grants apply while it's active:

```yaml
toggles:
- id: rage                      # key in play: "barbarian:rage", like resources
  name: Rage
  uses: rage                    # the resource spent to switch it on
  blocked_when: [wearing_heavy_armor]   # an effect condition: can't start, and ends
  ends_on: [incapacitated]      # conditions (implied ones count) that end it
  no_spells: true               # no Concentration or spellcasting while active
  extends_each_turn: true       # in an encounter: ends at the end of a turn it wasn't extended in
                                # (ends_at_turn_start: true ends it at your next turn: Reckless Attack)
  rounds: 100                   # in an encounter: lasts at most this many rounds (10 minutes)
  grants:
    resistances: [bludgeoning, piercing, slashing]
    advantages: [check.str, save.str]
    damage_riders:
    - id: rage-damage
      name: Rage Damage
      damage: {progression: Rage Damage}   # a class table column, or dice (1d8), or a flat +2
      applies_to: {ability: str}           # also weapon: true, any_of: [finesse, ranged]
      automatic: true                      # part of every matching attack's damage
```

Payments, free casts and d20 floors (all optional, absent = none). The bundled SRD doesn't use
them (its data stays byte for byte, since documents can pin a pack by its hash); a pack adds them
to SRD entities with patches, e.g.
`{target: classes/bard, op: append, path: features.5.actions, value: {id: font-of-inspiration, …}}`
or `{target: feats/magic-initiate, op: append, path: grants.free_casts, value: {uses: free-cast,
choice: spell}}`:

```yaml
actions:
- id: font-of-inspiration       # a pack's patch on the SRD Bard (`features.5.actions`)
  name: Font of Inspiration
  economy: free
  restores: bardic-inspiration  # gives one use of this resource (same source) back
  slot_payment: required        # always paid with a spell slot; `instead`: a slot may replace `uses`
- id: taunt                   # a pack's feature with a die the user rolls (by hand: `rolls.die`)
  name: Taunt
  economy: bonus_action
  uses: bardic-inspiration
  roll: {progression: Bardic Die}   # a class table column, or {dice: 1d6}
resources:
- id: fortune
  name: Fortune
  max: {proficiency: true}
  recharge: long
  spend_for: [d20_advantage, impose_disadvantage]   # what else a use can be spent on
free_casts:                     # cast without a slot by spending a use of the same source
- {uses: free-cast, choice: spell}          # the spells picked in this source's `spell` choice
- {uses: misty, spells: [misty-step]}       # or named
d20_floors:                     # a d20 of min - 1 or lower counts as min (each die, before keeping)
- {min: 10, kind: check, skills: [persuasion, deception], abilities: [cha], label: Honeyed Words}
```

A rider that isn't `automatic` (Sneak Attack, Divine Strike) is listed on matching attack lines
and added when `makeAttack` is asked to; `type` is `weapon` (the default), a damage type, or a
list to choose from. `requires` (`advantage_or_ally`: Sneak Attack; `target_damaged`: Colossus
Slayer) is checked by `makeAttack`; `once_per_turn` is enforced in encounters (outside one, the
caller tracks it), and `own_turn` only on the attacker's turns (Divine Strike).
`while_active: [rage, reckless-attack]` offers it only while those toggles are
on (Frenzy), and `damage: {progression: Rage Damage, die: 6}` rolls that many dice. A later rider
with the same `id` replaces an earlier one (Divine Strike at Cleric 14: `at_class_level` gives the
2d8 version).

`spell_damage` adds an ability modifier to the damage of matching spells (every filter given must
match), to each damage roll or, with `one_roll`, to the first:

```yaml
spell_damage:
- {name: Potent Spellcasting, ability: wis, cantrip: true, list: cleric}
- {name: Empowered Evocation, ability: int, list: wizard, school: evocation, one_roll: true}
- {name: Elemental Affinity, ability: cha, damage_type: fire, one_roll: true}
```

A feature used in a turn is an `action` (the encounter action `feature` resolves it; the play
action `use_feature` spends its resource and heals you, for a self-healing one):

```yaml
actions:
- id: second-wind
  name: Second Wind
  economy: bonus_action        # action | bonus_action | reaction | free (no action, on your turn)
  uses: second-wind            # the resource it spends (cost: 1 by default; pool: true → the caller's amount)
  heal: {dice: 1d10, bonus: class_level}   # or an ability, a number, or {pooled: true}
- id: flurry-of-blows
  name: Flurry of Blows
  economy: bonus_action
  uses: focus-points
  attacks: {attack: Unarmed Strike, count: 2}   # also: extra_action, also: [dash, disengage, dodge]
- id: stunning-strike
  name: Stunning Strike
  economy: free
  uses: focus-points
  target: other                # self (default) | creature | other
  after_hit: true              # needs a hit on the target this turn
  once_per_turn: true
  save: {ability: con, dc_ability: wis, conditions: [stunned],   # until the start of your next turn
         on_success: [speed_halved, advantage_against]}
- id: turn-undead
  name: Turn Undead
  economy: action
  uses: channel-divinity
  many: true                   # several creatures: the encounter action's `targets`
  range: 30                    # feet, checked with positions
  creature_types: [undead]
  save: {ability: wis, dc_ability: spell,      # spell: the class's spell save DC
         conditions: [frightened, incapacitated], rounds: 10,
         ends_on: [damage, source_incapacitated]}
- id: divine-spark
  name: Divine Spark (harm)
  economy: action
  uses: channel-divinity
  target: other
  save: {ability: con, dc_ability: spell,
         damage: {dice: 1d8, bonus: wis, types: [necrotic, radiant], half: true,
                  scaling: [{level: 7, dice: 2d8}]}}   # heal takes `scaling` too
- id: lay-on-hands-cure
  name: Lay On Hands (cure Poisoned)
  economy: bonus_action
  uses: lay-on-hands
  cost: 5
  target: creature
  removes: [poisoned]
```

`inspiration: {progression: Bardic Die}` gives the target a die for its next failed D20 Test, and
`halves_attack_damage: true` is a reaction to being hit (Uncanny Dodge, offered when an attack
hits), as is `reduces_attack_damage: {dice: 1d10, abilities: [dex], class_level: true, types:
[bludgeoning, piercing, slashing]}` (Deflect Attacks). They're decisions the encounter asks for or
takes automatically (`decisions`). The effect target `spell.save_dc` and the Advantage target
`attack.spell` change spells (Innate Sorcery, a toggle).

`rules` switches on a rule written in code, from a closed list: `evasion` (Dexterity saves that
halve damage: none on a success, half on a failure, not while Incapacitated), `reliable_talent`
(a d20 of 9 or lower counts as 10 on checks with a proficient skill), `potent_cantrip` (a cantrip
that misses or is saved against deals half damage), `indomitable` (a failed save can be rerolled
with the Fighter level, a decision, spending the `indomitable` resource), `cunning_strike` and
`improved_cunning_strike`, `brutal_strike` and `improved_brutal_strike` (the encounter `attack`
options `cunning` and `brutal`), `relentless_rage` (with the `relentless-rage` resource counting
its uses). The effect target `attack.weapon` adds to every weapon attack roll (Sacred Weapon), and
a `spell_damage` grant's `spell` limits it to one spell (`$cantrip`: Agonizing Blast's choice).

Anything effects, riders, Advantage and toggles can't express goes in a trait's text, or in a
feat's `unsupported` note, which the builder shows to the player.

### Choices

```yaml
choices:
  - id: skills               # choice key becomes "<source key>#skills"
    label: Fighter skills
    kind: skill              # option | ability | skill | tool | skill_or_tool | language | feat |
                             # weapon_mastery | spell | expertise | subclass | ability_increase | feature
    count: 2
    allowed: [athletics, perception]   # optional whitelist
    category: standard       # optional filter (language/tool/feat/weapon category); a string or a list
    step: proficiencies      # optional; defaults by kind
    hint: Shown under the options.
```

Spell choices add filters:

```yaml
  - id: prepared
    label: Wizard prepared spells
    kind: spell
    count: 4
    spell_level: 1           # 0 = cantrips
    spell_list: wizard       # or "$spell_list": the answer to a sibling choice
    ritual: false            # true: Ritual spells only
    subset_of: spellbook     # only spells a sibling choice picked
    always_prepared: false   # true: doesn't count against the class's prepared spells
```

Weapon Mastery choices accept `weapon_kind: melee` (Barbarian). `kind: expertise` offers the
skills you're proficient in.

`kind: option` takes inline `options`, each with its own `grants`. Picking an option
activates those grants, which can include further choices (Human → Versatile → Skilled →
"choose 3 skills or tools").

## Classes and levels

```yaml
id: fighter
hit_die: 10
primary_abilities: [str, dex]       # multiclassing needs 13+ in these (any; all with primary_mode: all)
subclass_level: 3
progression:                         # class table columns, 20 values; shown as class resources
  Second Wind: [2, 2, 2, 3, …]
grants: {…}                          # core traits: only for a character's first class
multiclass: {weapon_proficiencies: [martial], armor_training: [light, medium, shield]}
features:
  "1": {…}                           # level 1 features (starting or multiclass)
  "3":
    choices: [{id: subclass, label: Fighter subclass, kind: subclass}]
  "4":
    choices: [{id: feat, label: Ability Score Improvement or feat, kind: feat}]
  "5":
    effects: [{target: attacks, op: max, value: 2}]     # Extra Attack
```

A subclass lists its features by class level, and `at_class_level` switches grants on later:

```yaml
- id: life-domain
  class: cleric
  features:
    "3":
      spells: [aid, bless, cure-wounds, lesser-restoration]
      at_class_level:
        - {level: 5, grants: {spells: [mass-healing-word, revivify]}}
```

Spell choices grow with the class: `max_spell_level` (spells of level 1 up to it), `spell_list`
(one list or several: Magical Secrets), `tag` and `subset_of` (the Wizard's spellbook: every
`spellbook` choice has `tag: wizard-spellbook`, prepared choices use `subset_of:
wizard-spellbook`), `school` (Evoker), `known_only` (Agonizing Blast: one of your cantrips).

Choices that can change later:

```yaml
  - id: cantrips                  # "Whenever you gain a Bard level, you can replace one…"
    kind: spell
    tag: bard-cantrips            # the family: every Bard cantrip choice shares it
    swap: class_level             # one replacement per Bard level (any_level: per character level)
    same_level: false             # true: the replacement must be the same spell level
  - id: prepared                  # "After a Long Rest, you can change your list…"
    kind: spell
    scaling:                      # one list that grows; count and max spell level by class level
      count: [4, 5, 6, 7, 9, …]
      max_spell_level: [1, 1, 2, 2, 3, …]
    rest_change: long             # changeable in play after a rest (short | long): the play
                                  # state keeps today's picks, the build keeps the starting ones
```

Limited-use features declare `resources` in their grants; the play sheet lists them with their
maximum and the state tracks what's spent:

```yaml
resources:
  - id: rage                      # key in play: "barbarian:rage" (class) or "<source key>:rage"
    name: Rage
    max: {progression: [2, 2, 3, 3, 3, 4, …]}   # or value, ability (+ min), proficiency,
                                                #   per_class_level (Lay on Hands: 5)
    recharge: long                # short | long
    short_rest_regain: 1          # regain this many on a Short Rest (Rage, Channel Divinity)
on_long_rest: [heroic_inspiration]   # Human: Resourceful
```

### Spell mechanics

A spell's `mechanics` says what it does, so `castSpell` can resolve it; anything it doesn't
cover stays in the text. For the SRD, `scripts/import-srd-spells.ts` writes them (edit it, not
`spells.yaml`):

- `parseMechanics` drafts mechanics from the common phrasings ("makes a Dexterity saving
  throw, taking 8d6 Fire damage on a failed save or half as much…", "Make a ranged spell
  attack… On a hit…", "regains Hit Points equal to…", upcasting, Cantrip Upgrade, conditions,
  areas). It skips, with a reason, anything that happens after casting, several saves, damage
  outside the sentence that resolves the save or hit, tables and fixed DCs.
- A draft is used only if its id is in `REVIEWED`, after a check against the spell's text;
  `REJECTED` records drafts the review found wrong, and `MECHANICS` holds hand-written ones
  (they win over drafts).
- `npx tsx scripts/import-srd-spells.ts --report` lists every draft (`NEW` = not reviewed yet)
  and every skip. `tests/casting.test.ts` snapshots all mechanics, so a change shows in review.

The same approach suits your own packs: transcribe the text, draft mechanics with a parser or by
hand, validate with `srd-rules validate`, and pin the result with a test.

```yaml
id: fireball
mechanics:
  save: {ability: dex, on_success: half}     # or none; `attack: ranged | melee` instead
  damage: [{dice: 8d6, type: fire}]          # add_modifier: true adds the spellcasting modifier
  upcast: {damage: [{dice: 1d6, type: fire}]}   # per slot level above; also heal, targets
  area: {shape: sphere, size: 20}          # radius, length or side in feet; a line's width: 5
# Others: heal: {dice: 2d8, add_modifier: true}; targets: 1; cantrip_scaling: dice | beams;
#         conditions: [{condition: paralyzed, on: failed_save}]   # or on: hit
#         conditions: [{condition: poisoned, on: hit, until: end_of_your_next_turn}]  # or start_…
#         damage: [{dice: 1d4, type: force, bonus: 1}]          # Magic Missile's 1d4 + 1
#         projectiles: {count: 3, upcast: 1}    # darts (no attack) or rays (attack), +1 per slot
#         follow_up: {save: {ability: dex}, damage: [{dice: 2d6, type: cold}],
#                     upcast: [{dice: 1d6, type: cold}], radius: 5}   # after the attack (Ice Knife)
#         on_hit: [advantage_against]           # Guiding Bolt
#         damage_types: [radiant, necrotic]     # the caster picks one (Spirit Guardians)
#         conditions: [{condition: restrained, on: failed_save, escape: athletics}]
#         zone: {triggers: [enter, end_turn], once_per_turn: true, on_cast: true, designate: false}
#                                               # an area that lasts (needs save and area)
#         zone: {triggers: [move]}              # damage per 5 feet moved in it, no save
#         zone: {..., optional: true, anchor: point, space: 2, ram: false,
#                on_fail: [no_actions, lose_concentration],
#                difficult: true,               # its area is Difficult Terrain (Web)
#                speed_halved: true}            # others' Speed is halved in it (Spirit Guardians)
#         mark: {dice: 1d6, type: force}        # extra damage on the caster's hits (Hunter's Mark)
#         after_hit: true                       # cast right after a melee hit (Divine Smite)
#         bonus_vs: {creature_types: [fiend, undead], dice: 1d8}
#         conditions: [{condition: charmed, on: failed_save, ends_on_damage: true}]
#         wall: {length: 100, between: true}    # a wall on grid lines (Wall of Force); or squares:
#         wall: {length: 100, cover: three_quarters, difficult: true}   # Blade Barrier
#         wall: {length: 60, cost: 4, later_type: slashing}             # Wall of Thorns
#         wall: {length: 60, side: 10, later: damage}                   # Wall of Fire
```

A spell has an attack roll or a save, not both; a `follow_up` save comes after an attack. Damage from a save is rolled once for every
target; each damage type is halved separately on a successful save (`on_success: half`).

### Monsters

A stat block keeps the SRD's layout: `armor_class`, `initiative`, `hit_points` and `hit_dice`
(`19d12+133`), `speed` by mode (`{walk: 40, fly: 80}`, `hover`, `speed_note` for "bear form
only"), `abilities` and `saving_throws`, `skills`, damage `resistances`/`vulnerabilities`/
`immunities`, `condition_immunities` (`defenses_note` for qualified entries), `senses`,
`passive_perception`, `languages`, `cr`, `xp`, `proficiency_bonus`, and `traits`, `actions`,
`bonus_actions`, `reactions`, `legendary_actions` (with `legendary_text`), `multiattack`
(how many attacks its Multiattack makes), `legendary_uses` and `legendary_resistance`
(`{uses: 3, in_lair: 4}`). A legendary action also has `once_per_round`, `attacks` (the actions
whose attack it makes, one of them) and `uses` (another action it uses). Each action has its
`text`, a `recharge` (`5–6`), `per_day` ("(2/Day)" in its name), `casts` for an action that
casts spells (`{ability, save_dc, attack_bonus, spells: [{spell, level, per_day, note}]}`; `level`
is the "level N version" it's always cast at), and, when combat can resolve it:

```yaml
attack: {kind: melee, bonus: 14, reach: 10, range: null,
         damage: [{average: 13, dice: 1d10, bonus: 8, type: slashing}, {average: 5, dice: 2d4, bonus: 0, type: fire}]}
save: {ability: dex, dc: 21, damage: [{average: 59, dice: 17d6, bonus: 0, type: fire}],
       on_success: half, conditions: [],   # conditions on a failed save
       area: {shape: cone, size: 60, width: 5},   # "each creature in a 60-foot Cone"
       range: null}                        # "within 90 feet": its target's or point's range
```

Damage that depends on something ("plus 2 (1d4) if the attack roll had Advantage"), later
effects (swallowed, a second failure) and size-dependent conditions stay in the text.
`combatantFromMonster(monster, { hp, conditions })` makes a combatant: attacks for
`makeAttack`, saving throw effects for `useSaveAction`. Who can be targeted (size, range) is the
caller's to decide.

### Gear and tools

`gear.yaml` is generated by `scripts/import-srd-gear.ts` from the Adventuring Gear tables (it
also prices `tools.yaml`): `cost` (`2 GP`, `5 SP`), `weight` (`5 lb.`), `bundle` (how many one
price buys: Arrows 20), `ammunition` (`true` for the Ammunition table's five kinds: what an
ammunition magic item is made from). Entries it doesn't list (starting-equipment placeholders) are kept.

### Monster traits

`import-srd-monsters.ts` reads a few trait sentences into data: `trigger: death` (Death Burst,
with its `save` and Emanation), `aura: {size, damage, choice, not_incapacitated}` (Fire Aura),
`regeneration: {amount, stopped_by}` (Troll) and `advantage_aura: {size}` (Aura of Authority).
`--report` counts them.

### Magic items and conditions

`magic-items.yaml` and `conditions.yaml` are generated by `scripts/import-srd-items.ts`
(mechanics in its overlay tables). A magic item's fields:

```yaml
id: weapon-1
category: weapon                  # armor | potion | ring | rod | scroll | staff | wand | weapon | wondrous
rarity: Uncommon
attunement: false                 # attunement_classes: [paladin]; attunement_spellcaster: true
base: {kind: weapon, categories: [simple, martial]}   # made from a mundane item (ids, except…)
bonus: {attack: 1, damage: 1}     # also ac, spell_attack
grants: {effects: [{target: score.str, op: max, value: 19}]}   # while active; any grants
active_when: equipped             # or carried
charges: 7
consumable: true                  # with heal: 2d4+2 for potions
variants: [{id: fire, name: Fire, grants: {resistances: [fire]}}]   # Ring of Resistance
```

A magic item's grants apply while it's active: worn or held (or carried, for `active_when:
carried`), and attuned if it needs Attunement. Effect targets only items use: `score.<ability>`
(`op: max` sets a floor, like Gauntlets of Ogre Power) and `checks` (Stone of Good Luck).
Conditions have `speed_zero`, `implies` (Unconscious → Incapacitated, Prone), `levels`
(Exhaustion), and their effects on rolls:

```yaml
id: prone
attack_rolls: disadvantage          # its own attack rolls
attacked: advantage                 # attack rolls against it from within 5 feet…
attacked_beyond_5ft: disadvantage   # …and from farther
critical_within_5ft: false          # Paralyzed, Unconscious: a hit within 5 feet is a Critical Hit
fail_saves: []                      # Paralyzed: [str, dex]
save_disadvantage: []               # Restrained: [dex]
initiative: null                    # Invisible: advantage; Incapacitated: disadvantage
ability_checks: null                # Poisoned, Frightened: disadvantage
except_against_source: false        # Grappled: not against the grappler
```

Feats and features can have a `prerequisite`:

```yaml
prerequisite:
  level: 4                              # character level
  class_level: {class: warlock, level: 5}
  abilities: {any_of: [str, dex], min: 13}
  requires: [pact-of-the-blade]         # feats or features you have
  trait: Fighting Style                 # a feature, by name
  spellcasting: true
  spells: [eldritch-blast]              # know one of these
```

`kind: ability_increase` choices raise scores by 1 per pick (pick the same ability twice for +2)
up to `max_score` (default 20); `ability_bonuses` gives fixed increases with their own cap.

## Checking your work

```bash
npx srd-rules validate path/to/pack     # schema + cross-reference check, layered over the SRD
npx srd-rules build --content path/to/pack
```

The errors say exactly where the problem is:

```
my-pack/feats[0] (Bad_ID):
  ✖ ids are lowercase slugs
    → at id
```

## Writing your own pack, step by step

For content from a book you own (kept in its own, private pack: this repository only holds the
SRD and invented homebrew), the same steps the SRD importers follow work by hand:

1. **Start the pack.** A folder with `pack.yaml` (`id`, `version`, `source` naming the book,
   `requires: [srd-5.2.1]`) and one file per table, each with its `$schema` comment.
2. **Transcribe the text** into `description` / `text` fields, and the fixed data into fields
   (a spell's level, school, lists, casting time…; a monster's stat block).
3. **Draft the mechanics** from the text: grants and choices for classes, feats and species
   (selectable options such as maneuvers or infusions go in `features.yaml` with a `category`,
   picked by `kind: feature` choices, like Eldritch Invocations); `mechanics` for spells; `attack`
   and `save` for monster actions. Leave anything you can't express as text.
4. **Review each entity against the book**, as the SRD importers' `REVIEWED` lists do: a draft
   that isn't checked shouldn't drive the rules.
5. **Change SRD entities with patches**, not copies (add your classes to a spell's `lists`,
   adjust a choice's count), so SRD fixes keep reaching you.
6. **Validate and pin it:** `srd-rules validate my-pack/`, then tests with concrete characters
   ("a level 3 Battle Master has 4 superiority dice") and, for spells or monsters, a snapshot of
   their mechanics, so a later change shows up in review.

If you have many entities in a regular format, a script that drafts YAML from your transcription
(like `scripts/import-srd-spells.ts`, with its `--report` of drafts and skips) saves time; the
review step stays the same.
