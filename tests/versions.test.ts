import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CUSTOM_STATE_VERSION,
  createBuild,
  createEncounter,
  createState,
  DOCUMENT_VERSION,
  parseBuild,
  parseEncounter,
  parseState,
  STORED_STATE_VERSION,
} from "../src/index";
import { catalog, fighterBuild } from "./helpers";

// Saved documents carry a format version: missing means 1, newer than this engine is refused.
// Format 2 exists only for play states with a stored item (kenli F-005 DEC-01), format 3 only for
// play states with a custom item (kenli F-011); everything else is written as version 1.

describe("document versions", () => {
  it("new documents are written as version 1; 3 is the newest format read (a state with a custom item)", () => {
    expect(DOCUMENT_VERSION).toBe(3);
    expect(STORED_STATE_VERSION).toBe(2);
    expect(CUSTOM_STATE_VERSION).toBe(3);
    expect(createBuild().version).toBe(1);
    expect(createState(fighterBuild(), catalog).version).toBe(1);
    expect(createEncounter().version).toBe(1);
  });

  it("only a play state may be version 2; a build or an encounter of version 2 is refused", () => {
    expect(() => parseBuild({ version: 2 })).toThrow(/saved by a newer srd-rules-engine/);
    expect(() => parseEncounter({ version: 2 })).toThrow(/saved by a newer srd-rules-engine/);
    expect(() => parseBuild({ version: 3 })).toThrow(/saved by a newer srd-rules-engine/);
    expect(() => parseEncounter({ version: 3 })).toThrow(/saved by a newer srd-rules-engine/);
  });

  it("a document without a version is version 1", () => {
    const python = JSON.parse(
      readFileSync(join(import.meta.dirname, "fixtures/python-builder-save.json"), "utf-8"),
    );
    expect(python.version).toBeUndefined();
    expect(parseBuild(python).version).toBe(1);
    expect(parseState({}).version).toBe(1);
    expect(parseEncounter({}).version).toBe(1);
  });

  it("a document from a newer engine is refused with a clear message", () => {
    const newer = { version: DOCUMENT_VERSION + 1 };
    for (const parse of [parseBuild, parseState, parseEncounter]) {
      expect(() => parse(newer)).toThrow(/saved by a newer srd-rules-engine/);
    }
  });
});
