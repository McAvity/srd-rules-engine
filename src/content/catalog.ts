/**
 * Build a validated, immutable `Catalog` from one or more content packs.
 *
 * A pack is plain data (parsed YAML or JSON), so this module works everywhere: Node, Deno,
 * Bun, browsers, workers. Packs are layered in order: a later pack adds entities and replaces
 * any entity with the same id (that's how homebrew overrides or extends the SRD). An entity
 * without a `source` gets its pack's name. Loading packs from disk lives in `node.ts`.
 */

import { type ZodType, z } from "zod";
import {
  ABILITIES,
  type ArmorDef,
  ArmorSchema,
  type AutomationDef,
  AutomationSchema,
  type BackgroundDef,
  BackgroundSchema,
  type ClassDef,
  ClassSchema,
  type ConditionDef,
  ConditionSchema,
  type CreationRules,
  CreationSchema,
  DEFAULT_SOURCE,
  type FeatDef,
  FeatSchema,
  type GearDef,
  GearSchema,
  type Grants,
  type LanguageDef,
  LanguageSchema,
  type MagicItemDef,
  MagicItemSchema,
  type MasteryDef,
  MasterySchema,
  type MonsterDef,
  MonsterSchema,
  type SpeciesDef,
  SpeciesSchema,
  type SpellDef,
  SpellDefSchema,
  type SubclassDef,
  SubclassSchema,
  type ToolDef,
  ToolSchema,
  type WeaponDef,
  WeaponSchema,
} from "../models/content";
import {
  applyPatch,
  type PackManifest,
  PackManifestSchema,
  PatchError,
  PatchSchema,
} from "../models/pack";

export type Table<T> = Readonly<Record<string, T>>;
type Entity = { id: string; source: string };
export type Item = WeaponDef | ArmorDef | GearDef | ToolDef | MagicItemDef;

export interface Catalog {
  readonly creation: CreationRules;
  readonly classes: Table<ClassDef>;
  readonly species: Table<SpeciesDef>;
  readonly backgrounds: Table<BackgroundDef>;
  readonly feats: Table<FeatDef>;
  readonly weapons: Table<WeaponDef>;
  readonly armor: Table<ArmorDef>;
  readonly gear: Table<GearDef>;
  readonly tools: Table<ToolDef>;
  readonly languages: Table<LanguageDef>;
  readonly masteries: Table<MasteryDef>;
  readonly spells: Table<SpellDef>;
  readonly subclasses: Table<SubclassDef>;
  /** Selectable class features (Eldritch Invocations, Metamagic): feats in shape, not in kind. */
  readonly features: Table<FeatDef>;
  readonly magic_items: Table<MagicItemDef>;
  readonly conditions: Table<ConditionDef>;
  /** Monster and animal stat blocks. */
  readonly monsters: Table<MonsterDef>;
  /**
   * kenli F-002 T12: packs' play automation for features a character already has, in load order
   * (sources filtered like entities). Empty without such a pack.
   */
  readonly automation: readonly AutomationDef[];
  /** The loaded packs, in load order (a pack without `pack.yaml` gets a minimal manifest). */
  readonly packs: readonly PackManifest[];
}

/** Raw, unvalidated content: what a YAML/JSON content directory parses to. */
export interface ContentPack {
  /**
   * Used in error messages, e.g. `srd-5.2.1` or `my-homebrew`. Without a manifest, it's also
   * the pack id and the `source` of entities that don't declare one (`homebrew` without a name).
   */
  name?: string;
  /** `pack.yaml`: id, version, default source, required packs. */
  manifest?: unknown;
  /** `patches.yaml`: changes to entities loaded earlier, applied after this pack's entities. */
  patches?: unknown[];
  creation?: unknown;
  classes?: unknown[];
  species?: unknown[];
  backgrounds?: unknown[];
  feats?: unknown[];
  weapons?: unknown[];
  armor?: unknown[];
  gear?: unknown[];
  tools?: unknown[];
  languages?: unknown[];
  masteries?: unknown[];
  spells?: unknown[];
  subclasses?: unknown[];
  features?: unknown[];
  magic_items?: unknown[];
  conditions?: unknown[];
  monsters?: unknown[];
  /**
   * kenli F-002 T12: play automation for features a character already has (`AutomationDef`), a
   * pack-level list like `patches` (not a table): kept by `splitPack` in the manifest.
   */
  automation?: unknown[];
}

export const TABLE_SCHEMAS = {
  classes: ClassSchema,
  species: SpeciesSchema,
  backgrounds: BackgroundSchema,
  feats: FeatSchema,
  weapons: WeaponSchema,
  armor: ArmorSchema,
  gear: GearSchema,
  tools: ToolSchema,
  languages: LanguageSchema,
  masteries: MasterySchema,
  spells: SpellDefSchema,
  subclasses: SubclassSchema,
  features: FeatSchema,
  magic_items: MagicItemSchema,
  conditions: ConditionSchema,
  monsters: MonsterSchema,
} as const;

export type TableName = keyof typeof TABLE_SCHEMAS;
export const TABLE_NAMES = Object.keys(TABLE_SCHEMAS) as TableName[];

/**
 * What a character builder needs first: everything but spells, magic items and monsters (add
 * `spells` for spellcasters, `magic_items` for play).
 */
export const CORE_TABLES: readonly TableName[] = [
  "classes",
  "species",
  "backgrounds",
  "feats",
  "features",
  "subclasses",
  "weapons",
  "armor",
  "gear",
  "tools",
  "languages",
  "masteries",
  "conditions",
];

export class ContentError extends Error {
  override name = "ContentError";
}

/** Look up an id in a catalog table without tripping over prototype keys. */
export function lookup<T>(table: Table<T>, id: string | null | undefined): T | undefined {
  return id != null && Object.hasOwn(table, id) ? table[id] : undefined;
}

/** Any equipment item by id. Throws `ContentError` if the id is unknown. */
export function catalogItem(catalog: Catalog, itemId: string): Item {
  for (const table of [
    catalog.weapons,
    catalog.armor,
    catalog.gear,
    catalog.tools,
    catalog.magic_items,
  ] as Table<Item>[]) {
    if (!isLoaded(table)) continue;
    const item = lookup(table, itemId);
    if (item) return item;
  }
  throw new ContentError(`Unknown item '${itemId}'`);
}

export interface CatalogOptions {
  /**
   * Load only entities and patches whose `source` is in this list (say, the books a campaign
   * allows). Creation rules are always loaded. Entities that refer to a filtered-out one fail
   * the cross-reference check.
   */
  sources?: readonly string[];
  /**
   * Load only these tables (a character builder doesn't need monsters). Reading a table that
   * wasn't loaded throws a `ContentError` saying so; references into it aren't checked (they
   * were when its pack was compiled), and patches to it are skipped.
   */
  tables?: readonly TableName[];
}

/** Tables a catalog was built without: reading one throws (see `CatalogOptions.tables`). */
const UNLOADED = new WeakSet<object>();

function unloadedTable(name: TableName): Table<never> {
  const refuse = (): never => {
    throw new ContentError(
      `The table '${name}' isn't loaded in this catalog (createCatalog's \`tables\` option)`,
    );
  };
  const table = new Proxy(Object.freeze({}), {
    // Symbols (inspection, iteration checks) aren't content: only names refuse.
    get: (_, key) => (typeof key === "symbol" ? undefined : refuse()),
    has: refuse,
    ownKeys: refuse,
    getOwnPropertyDescriptor: refuse,
  });
  UNLOADED.add(table);
  return table;
}

/** Whether a catalog table was loaded (`false` for one left out by `CatalogOptions.tables`). */
export function isLoaded(table: Table<unknown>): boolean {
  return !UNLOADED.has(table);
}

/**
 * Validate and layer content packs, in order. Pass the packs as arguments, or as a list
 * followed by options: `createCatalog([srdPack, mine], { sources: ["srd-5.2.1", "mine"] })`.
 */
export function createCatalog(...packs: ContentPack[]): Catalog;
export function createCatalog(packs: readonly ContentPack[], options: CatalogOptions): Catalog;
export function createCatalog(...args: unknown[]): Catalog {
  const [packs, options] = Array.isArray(args[0])
    ? [args[0] as readonly ContentPack[], (args[1] ?? {}) as CatalogOptions]
    : [args as ContentPack[], {}];
  const enabled = (source: string) => !options.sources || options.sources.includes(source);
  const wanted = (table: TableName) => !options.tables || options.tables.includes(table);
  const errors: string[] = [];
  let creation: CreationRules | undefined;
  const manifests: PackManifest[] = [];
  const automation: AutomationDef[] = [];
  const tables = Object.fromEntries(TABLE_NAMES.map((t) => [t, {}])) as Record<
    TableName,
    Record<string, unknown>
  >;

  packs.forEach((pack, i) => {
    let manifest: PackManifest;
    if (pack.manifest !== undefined) {
      const where = `${pack.name ?? `pack ${i + 1}`}/pack`;
      const parsed = parse(PackManifestSchema, pack.manifest, where, errors);
      if (!parsed) return;
      manifest = parsed;
    } else {
      manifest = { ...PackManifestSchema.parse({ id: "pack" }), id: pack.name ?? `pack-${i + 1}` };
    }
    const packName = manifest.id;
    if (manifests.some((m) => m.id === packName)) {
      errors.push(`${packName}: the pack is loaded twice`);
      return;
    }
    for (const id of manifest.requires) {
      if (!manifests.some((m) => m.id === id)) {
        errors.push(`${packName}: needs pack '${id}', loaded before it`);
      }
    }
    manifests.push(manifest);
    const defaultSource =
      pack.manifest !== undefined
        ? (manifest.source ?? manifest.id)
        : (pack.name ?? DEFAULT_SOURCE);
    const withSource = (entry: unknown): unknown =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry) && !("source" in entry)
        ? { ...entry, source: defaultSource }
        : entry;
    if (pack.creation !== undefined) {
      const where = `${packName}/creation`;
      const parsed = parse(CreationSchema, withSource(pack.creation), where, errors);
      if (parsed) creation = parsed;
    }
    for (const table of TABLE_NAMES) {
      const entries = pack[table];
      if (entries === undefined || !wanted(table)) continue;
      const seen = new Set<string>();
      entries.forEach((entry, j) => {
        const where = `${packName}/${table}[${j}]`;
        const schema = TABLE_SCHEMAS[table] as ZodType<Entity>;
        const parsed = parse(schema, withSource(entry), where, errors);
        if (!parsed) return;
        if (seen.has(parsed.id)) {
          errors.push(`${packName}/${table}: duplicate id '${parsed.id}'`);
          return;
        }
        seen.add(parsed.id);
        if (enabled(parsed.source)) tables[table][parsed.id] = parsed;
      });
    }
    (pack.automation ?? []).forEach((entry, j) => {
      const where = `${packName}/automation[${j}]`;
      const parsed = parse(AutomationSchema, withSource(entry), where, errors);
      if (!parsed) return;
      if (automation.some((a) => a.id === parsed.id)) {
        errors.push(`${where}: duplicate automation id '${parsed.id}'`);
        return;
      }
      if (enabled(parsed.source)) automation.push(parsed);
    });
    (pack.patches ?? []).forEach((entry, j) => {
      const where = `${packName}/patches[${j}]`;
      const patch = parse(PatchSchema, entry, where, errors);
      if (!patch || !enabled(patch.source ?? defaultSource)) return;
      const [table, id] = patch.target.split("/") as [string, string];
      if (!(TABLE_NAMES as string[]).includes(table)) {
        errors.push(`${where}: unknown table '${table}'`);
        return;
      }
      if (!wanted(table as TableName)) return;
      const rows = tables[table as TableName];
      if (!Object.hasOwn(rows, id)) {
        errors.push(`${where}: no ${table} '${id}' loaded before this pack`);
        return;
      }
      let patched: unknown;
      try {
        patched = applyPatch(rows[id], patch);
      } catch (e) {
        if (!(e instanceof PatchError)) throw e;
        errors.push(`${where} (${patch.target}): ${e.message}`);
        return;
      }
      const schema = TABLE_SCHEMAS[table as TableName] as ZodType<Entity>;
      const parsed = parse(schema, patched, `${where} (${patch.target})`, errors);
      if (parsed && parsed.id !== id) {
        errors.push(`${where}: a patch can't change the id`);
      } else if (parsed) {
        rows[id] = parsed;
      }
    });
  });

  if (!creation) errors.push("No pack provides the character creation rules (`creation`)");
  if (errors.length) throw new ContentError(errors.join("\n"));

  deepFreeze(tables);
  const loaded = Object.fromEntries(
    TABLE_NAMES.map((t) => [t, wanted(t) ? tables[t] : unloadedTable(t)]),
  );
  const catalog = Object.freeze({
    creation: deepFreeze(creation),
    ...loaded,
    automation: deepFreeze(automation),
    packs: deepFreeze(manifests),
  } as unknown as Catalog);
  validateReferences(catalog);
  return catalog;
}

/** Throw `ContentError` if any id referenced by content doesn't exist. */
export function validateReferences(full: Catalog): void {
  const errors: string[] = [];
  // Tables that weren't loaded: nothing to walk, and references into them aren't checked.
  const view = Object.fromEntries(
    TABLE_NAMES.map((t) => [t, isLoaded(full[t]) ? full[t] : null]),
  ) as { [K in TableName]: Catalog[K] | null };
  const catalog = Object.fromEntries(
    TABLE_NAMES.map((t) => [t, view[t] ?? {}]),
  ) as unknown as Catalog;
  const merged = (...tables: (Table<unknown> | null)[]): Table<unknown> | null =>
    tables.every((t) => t !== null) ? Object.assign({}, ...tables) : null;
  const check = (
    ids: Iterable<string>,
    table: Table<unknown> | null,
    what: string,
    where: string,
  ) => {
    if (table === null) return;
    for (const id of ids) {
      if (!lookup(table, id)) errors.push(`${where}: unknown ${what} '${id}'`);
    }
  };
  const items = merged(view.weapons, view.armor, view.gear, view.tools);
  const spellLists = view.spells
    ? new Set(Object.values(view.spells).flatMap((s) => s.lists))
    : null;
  const creation = full.creation;
  const tags = new Set<string>();
  for (const [, grants] of allGrants(catalog, creation)) {
    for (const choice of grants.choices) if (choice.tag) tags.add(choice.tag);
  }
  for (const [where, grants] of allGrants(catalog, creation)) {
    check(
      grants.feats.map((f) => f.feat),
      view.feats,
      "feat",
      where,
    );
    check(grants.tools, view.tools, "tool", where);
    check(grants.languages, view.languages, "language", where);
    check(
      grants.items.map((i) => i.item),
      items,
      "item",
      where,
    );
    check(grants.cantrips, view.spells, "spell", where);
    check(grants.spells, view.spells, "spell", where);
    const siblings = new Set(grants.choices.map((c) => c.id));
    const ref = (value: string | null, what: string, known: (v: string) => boolean): void => {
      if (value === null) return;
      if (value.startsWith("$")) {
        if (!siblings.has(value.slice(1)))
          errors.push(`${where}: ${what} refers to unknown choice '${value}'`);
      } else if (!known(value)) {
        errors.push(`${where}: unknown ${what} '${value}'`);
      }
    };
    const isList = (list: string) => spellLists === null || spellLists.has(list);
    if (grants.spellcasting) {
      ref(grants.spellcasting.list, "spell list", isList);
      ref(grants.spellcasting.ability, "spellcasting ability", (a) =>
        (ABILITIES as readonly string[]).includes(a),
      );
    }
    for (const choice of grants.choices) {
      for (const list of choice.spell_list ?? []) ref(list, "spell list", isList);
      if (choice.subset_of !== null && !tags.has(choice.subset_of)) {
        errors.push(`${where}.${choice.id}: subset_of refers to unknown tag '${choice.subset_of}'`);
      }
      if (choice.kind === "spell" && choice.allowed) {
        check(choice.allowed, view.spells, "spell", where);
      }
      if (choice.kind === "language" && choice.allowed) {
        check(choice.allowed, view.languages, "language", where);
      }
      if (choice.kind === "tool" && choice.allowed) {
        check(choice.allowed, view.tools, "tool", where);
      }
    }
  }
  for (const cls of Object.values(catalog.classes)) {
    const core = new Set([...cls.grants.choices, ...cls.multiclass.choices].map((c) => c.id));
    for (const choice of cls.features["1"]?.choices ?? []) {
      if (core.has(choice.id)) {
        errors.push(
          `${cls.id}: choice id '${choice.id}' is used by both core traits and level 1 features`,
        );
      }
    }
  }
  for (const item of Object.values(catalog.magic_items)) {
    const ids = [...(item.base?.ids ?? []), ...(item.base?.except ?? [])];
    check(ids, merged(view.weapons, view.armor, view.gear), "base item", item.id);
    check(item.attunement_classes, view.classes, "class", item.id);
  }
  for (const condition of Object.values(catalog.conditions)) {
    check(condition.implies, view.conditions, "condition", condition.id);
  }
  for (const monster of Object.values(catalog.monsters)) {
    const applied = [
      ...monster.actions,
      ...monster.bonus_actions,
      ...monster.legendary_actions,
    ].flatMap((a) => a.save?.conditions ?? []);
    check([...monster.condition_immunities, ...applied], view.conditions, "condition", monster.id);
  }
  for (const spell of Object.values(catalog.spells)) {
    const applied = (spell.mechanics?.conditions ?? []).map((c) => c.condition);
    check(applied, view.conditions, "condition", spell.id);
  }
  check(
    Object.values(catalog.subclasses).map((s) => s.class),
    view.classes,
    "class",
    "subclasses",
  );
  for (const table of [catalog.feats, catalog.features]) {
    for (const feat of Object.values(table)) {
      const pre = feat.prerequisite;
      if (!pre) continue;
      check(pre.requires, merged(view.feats, view.features), "feat or feature", feat.id);
      if (pre.class_level) check([pre.class_level.class], view.classes, "class", feat.id);
    }
  }
  check(
    Object.values(catalog.weapons).map((w) => w.mastery),
    view.masteries,
    "mastery",
    "weapons",
  );
  if (errors.length) throw new ContentError(errors.join("\n"));
}

function* allGrants(catalog: Catalog, creation: CreationRules): Generator<[string, Grants]> {
  yield* walk("creation", creation.base_grants);
  for (const table of [catalog.species, catalog.backgrounds, catalog.feats, catalog.features]) {
    for (const entity of Object.values(table)) yield* walk(entity.id, entity.grants);
  }
  for (const item of Object.values(catalog.magic_items)) {
    yield* walk(item.id, item.grants);
    for (const v of item.variants) yield* walk(`${item.id}.${v.id}`, v.grants);
  }
  for (const cls of Object.values(catalog.classes)) {
    yield* walk(cls.id, cls.grants);
    yield* walk(`${cls.id}.multiclass`, cls.multiclass);
    for (const [level, grants] of Object.entries(cls.features)) {
      yield* walk(`${cls.id}.${level}`, grants);
    }
  }
  for (const sub of Object.values(catalog.subclasses)) {
    for (const [level, grants] of Object.entries(sub.features)) {
      yield* walk(`${sub.id}.${level}`, grants);
    }
  }
}

function* walk(where: string, grants: Grants): Generator<[string, Grants]> {
  yield [where, grants];
  for (const gate of grants.at_class_level) yield* walk(`${where}@${gate.level}`, gate.grants);
  for (const choice of grants.choices) {
    for (const option of choice.options) {
      yield* walk(`${where}.${choice.id}.${option.id}`, option.grants);
    }
  }
}

function parse<T>(schema: ZodType<T>, input: unknown, where: string, errors: string[]): T | null {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const id = (input as { id?: unknown } | null)?.id;
  const label = typeof id === "string" ? `${where} (${id})` : where;
  errors.push(`${label}:\n${indent(z.prettifyError(result.error))}`);
  return null;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
