import { z } from "zod";

/**
 * The format version of saved documents (builds, play states, encounters). A document without
 * one is version 1; when the format changes, older versions are migrated on parse and newer
 * ones are refused.
 *
 * `DOCUMENT_VERSION` is the newest format this engine reads: 2, for a play state with an item
 * put away (`ItemInstance.location: "stored"`). Such a state is written as version 2 so that an
 * older engine (which would drop `location` and count the item as carried) refuses it with its
 * message instead; every other state, and every build and encounter, stays version 1, byte for
 * byte as before.
 *
 * Version 3 (kenli F-011) is a play state with a custom item (`ItemInstance.item: null` and
 * `custom`): an older engine refuses it instead of dropping the item. A state without one keeps
 * version 2 or 1.
 */
export const DOCUMENT_VERSION = 3;

/** The format of a play state with a stored item (`stateVersion`). */
export const STORED_STATE_VERSION = 2;

/** The format of a play state with a custom item (`stateVersion`). */
export const CUSTOM_STATE_VERSION = 3;

const versionUpTo = (newest: number) =>
  z
    .int()
    .min(1)
    .max(newest, {
      error: `this document was saved by a newer srd-rules-engine (format ${newest} is the newest this one reads)`,
    })
    .default(1);

/** A build's or an encounter's format: version 1 (newer ones refused). */
export const DocumentVersionSchema = versionUpTo(1);

/** A play state's format: 1, 2 with a stored item, 3 with a custom item (newer ones refused). */
export const StateVersionSchema = versionUpTo(DOCUMENT_VERSION);
