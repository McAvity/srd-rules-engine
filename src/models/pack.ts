/**
 * Content pack metadata (`pack.yaml`) and patches (`patches.yaml`).
 *
 * A manifest names a pack, gives the default `source` of its entities and lists the packs it
 * needs. A patch changes one field of an entity loaded earlier (usually from another pack)
 * without copying the whole entity.
 */

import { z } from "zod";

const slug = z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, "pack ids are lowercase slugs");

export const PackManifestSchema = z
  .strictObject({
    id: slug,
    /** Free-form, e.g. `5.2.1` or `0.3.0`. */
    version: z.string().nullable().default(null),
    /** Informational: the rules edition the content targets (`2024`). */
    ruleset: z.string().nullable().default(null),
    /** `source` of the pack's entities and patches that don't declare one (default: `id`). */
    source: z.string().nullable().default(null),
    /** Pack ids that must be loaded before this one. */
    requires: z.array(slug).default([]),
    description: z.string().default(""),
  })
  .meta({ id: "PackManifest" });
export type PackManifest = z.infer<typeof PackManifestSchema>;

export const PATCH_OPS = ["set", "append", "remove"] as const;

/**
 * A change to one entity: `target` is `<table>/<id>` (`spells/fireball`), `path` a dotted path
 * into it (`lists`, `features.3.choices.subclass.count`). In a list, a path segment is an index
 * or the `id` of an element.
 *
 * - `set`: replace the value at `path` (the last segment may be a new key).
 * - `append`: add `value` (one item or a list of items) to the list at `path`.
 * - `remove`: without `value`, delete what's at `path`; with `value`, remove those items (or
 *   the elements with those ids) from the list at `path`.
 *
 * The patched entity is validated again, so a patch can't leave it invalid.
 */
export const PatchSchema = z
  .strictObject({
    target: z
      .string()
      .regex(/^[a-z_]+\/[a-z0-9][a-z0-9-]*$/, "target is <table>/<id>, e.g. spells/fireball"),
    op: z.enum(PATCH_OPS),
    path: z.string().min(1),
    value: z.unknown().optional(),
    /** For filtering by source; defaults to the pack's source. */
    source: z.string().optional(),
  })
  .meta({ id: "Patch" });
export type Patch = z.infer<typeof PatchSchema>;

export class PatchError extends Error {
  override name = "PatchError";
}

/**
 * Apply a patch to a copy of `entity` and return the copy. Throws `PatchError` if the path
 * doesn't exist or the op doesn't fit what's there. The result isn't validated.
 */
export function applyPatch(entity: unknown, patch: Patch): unknown {
  const copy = structuredClone(entity);
  const segments = patch.path.split(".");
  const last = segments.pop() as string;
  let parent: unknown = copy;
  const walked: string[] = [];
  for (const segment of segments) {
    parent = child(parent, segment, walked);
    walked.push(segment);
  }
  const container = parent;
  if (container === null || typeof container !== "object") {
    throw new PatchError(`'${walked.join(".")}' isn't an object or a list`);
  }

  if (patch.op === "set") {
    if (patch.value === undefined) throw new PatchError("set needs a value");
    if (Array.isArray(container)) container[indexOf(container, last, walked)] = patch.value;
    else (container as Record<string, unknown>)[last] = patch.value;
    return copy;
  }

  if (patch.op === "remove" && patch.value === undefined) {
    if (Array.isArray(container)) container.splice(indexOf(container, last, walked), 1);
    else if (Object.hasOwn(container, last)) delete (container as Record<string, unknown>)[last];
    else throw new PatchError(`no '${[...walked, last].join(".")}'`);
    return copy;
  }

  // append, or remove items: the target is a list (a missing or null one counts as empty).
  const record = container as Record<string, unknown>;
  const current = Array.isArray(container)
    ? container[indexOf(container, last, walked)]
    : record[last];
  if (current != null && !Array.isArray(current)) {
    throw new PatchError(`'${patch.path}' isn't a list`);
  }
  const list = (current ?? []) as unknown[];
  const items = Array.isArray(patch.value) ? patch.value : [patch.value];
  let next: unknown[];
  if (patch.op === "append") {
    next = [...list, ...items];
  } else {
    next = list.filter((x) => !items.some((item) => sameItem(x, item)));
    if (next.length === list.length) {
      throw new PatchError(`'${patch.path}' has none of ${JSON.stringify(patch.value)}`);
    }
  }
  if (Array.isArray(container)) container[indexOf(container, last, walked)] = next;
  else record[last] = next;
  return copy;
}

function child(node: unknown, segment: string, walked: string[]): unknown {
  if (Array.isArray(node)) return node[indexOf(node, segment, walked)];
  if (node !== null && typeof node === "object" && Object.hasOwn(node, segment)) {
    return (node as Record<string, unknown>)[segment];
  }
  throw new PatchError(`no '${[...walked, segment].join(".")}'`);
}

/** A list element by index (`0`) or by `id` (`subclass`). */
function indexOf(list: unknown[], segment: string, walked: string[]): number {
  const index = /^\d+$/.test(segment)
    ? Number(segment)
    : list.findIndex((x) => idOf(x) === segment);
  if (index < 0 || index >= list.length) {
    throw new PatchError(`no '${[...walked, segment].join(".")}'`);
  }
  return index;
}

function idOf(value: unknown): unknown {
  return value !== null && typeof value === "object" ? (value as { id?: unknown }).id : undefined;
}

/** An item to remove matches equal primitives, or an element with that `id`. */
function sameItem(element: unknown, item: unknown): boolean {
  if (element === item) return true;
  if (typeof item === "string" && idOf(element) === item) return true;
  return JSON.stringify(element) === JSON.stringify(item);
}
