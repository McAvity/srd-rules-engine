/**
 * A content pack as separate JSON files, one per table plus a manifest, so a browser can fetch
 * (and cache) only the tables it needs. The build publishes the SRD this way under
 * `srd-rules-engine/srd-5.2.1/`; `loadPack` reads it back with any fetch-like loader.
 */

import { type ContentPack, TABLE_NAMES, type TableName } from "./catalog";

/** `manifest.json`: everything but the tables, and which table files there are. */
export interface SplitManifest {
  readonly name?: string;
  readonly manifest?: unknown;
  readonly creation?: unknown;
  readonly patches?: unknown[];
  /** kenli F-002 T12: the pack's play automation (`ContentPack.automation`). */
  readonly automation?: unknown[];
  /** Table name → its file (`monsters.json`) and how many entities it has. */
  readonly tables: Readonly<Partial<Record<TableName, { file: string; count: number }>>>;
}

/** The files of a split pack, by file name: `manifest.json` and one `<table>.json` per table. */
export function splitPack(pack: ContentPack): Record<string, unknown> {
  const files: Record<string, unknown> = {};
  const tables: Partial<Record<TableName, { file: string; count: number }>> = {};
  for (const table of TABLE_NAMES) {
    const entries = pack[table];
    if (entries === undefined) continue;
    const file = `${table}.json`;
    files[file] = entries;
    tables[table] = { file, count: entries.length };
  }
  const manifest: SplitManifest = {
    ...(pack.name !== undefined ? { name: pack.name } : {}),
    ...(pack.manifest !== undefined ? { manifest: pack.manifest } : {}),
    ...(pack.creation !== undefined ? { creation: pack.creation } : {}),
    ...(pack.patches !== undefined ? { patches: pack.patches } : {}),
    ...(pack.automation !== undefined ? { automation: pack.automation } : {}),
    tables,
  };
  return { "manifest.json": manifest, ...files };
}

export interface LoadPackOptions {
  /** Only these tables (default: every table in the manifest). */
  readonly tables?: readonly TableName[];
}

/**
 * Read a split pack back: `fetchJson` gets a file name relative to the pack's folder
 * (`manifest.json`, `classes.json`) and returns its parsed JSON, so the caller chooses how
 * (`fetch`, a cache, a dynamic `import()`). Table files are fetched in parallel. Pass the result
 * to `createCatalog` with the same `tables`.
 */
export async function loadPack(
  fetchJson: (path: string) => Promise<unknown>,
  { tables }: LoadPackOptions = {},
): Promise<ContentPack> {
  const manifest = (await fetchJson("manifest.json")) as SplitManifest;
  const { tables: files, ...rest } = manifest;
  const wanted = (Object.keys(files) as TableName[]).filter((t) => !tables || tables.includes(t));
  const loaded = await Promise.all(
    wanted.map(async (t) => [t, await fetchJson(files[t]?.file ?? `${t}.json`)] as const),
  );
  return { ...rest, ...Object.fromEntries(loaded) } as ContentPack;
}
