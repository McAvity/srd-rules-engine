import { describe, expect, it } from "vitest";
import {
  type CharacterBuild,
  type ContentPack,
  computePlaySheet,
  computeSheet,
  createCatalog,
  createState,
} from "../src/index";
import * as svc from "../src/services/builder";
import { srdPack } from "../src/srd";
import { apply, autocomplete, catalog, classBuild } from "./helpers";

// kenli F-011 (review03 R03-09): which source instances grant a spell — read-only provenance on the
// sheet. The same spell from two sources keeps both; two features with one name (a repeatable
// Magic Initiate) stay apart by their keys. Existing fields (`source`, `spellcasting`, casting and
// payment identity) are unchanged.

/** An invented pack (`source: test`) giving Mage Hand through both the Elf species and Sage. */
const twice: ContentPack = {
  name: "grants-twice",
  manifest: { id: "grants-twice", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
  patches: [
    { target: "backgrounds/sage", op: "append", path: "grants.cantrips", value: "mage-hand" },
    { target: "species/elf", op: "append", path: "grants.cantrips", value: "mage-hand" },
  ],
};
/** Magic Initiate's free cast, as a pack gives it (the F-005 test pack does the same). */
const freeCast: ContentPack = {
  name: "free-cast",
  manifest: { id: "free-cast", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
  patches: [
    {
      target: "feats/magic-initiate",
      op: "append",
      path: "grants.free_casts",
      value: { uses: "free-cast", choice: "spell" },
    },
  ],
};

describe("spell grants (provenance)", () => {
  it("the same spell from Elf and Sage: one line, both grants, the first one's fields as before", () => {
    const cat = createCatalog(srdPack, twice);
    const build = autocomplete(classBuild("wizard", { species: "elf", background: "sage" }), cat);
    const sheet = computeSheet(build, cat);
    const lines = sheet.spells.filter((s) => s.id === "mage-hand");
    expect(lines).toHaveLength(1);
    const line = lines[0] as (typeof lines)[number];
    expect(line.source).toBe("Elf"); // unchanged: the first grant's name
    expect(line.grants.map((g) => g.source)).toEqual(["Elf", "Sage"]);
    expect(new Set(line.grants.map((g) => g.key)).size).toBe(2);
    const [elf, sage] = line.grants;
    expect(elf?.spellcasting).toBe("Elf");
    expect(elf?.spellcasting_key).toBe(
      sheet.spellcasting.find((l) => l.source === "Elf")?.key ?? null,
    );
    expect(sage).toMatchObject({ source: "Sage", spellcasting: null, spellcasting_key: null });
    expect(line.spellcasting).toEqual(["Elf"]); // unchanged
  });

  it("two Magic Initiates (Human Versatile and Sage): same name, two keys and origins; their spells and free casts point at their own", () => {
    const cat = createCatalog(srdPack, freeCast);
    let build: CharacterBuild = classBuild("wizard", { species: "human", background: "sage" });
    build = apply(build, svc.setChoice, "species:human#versatile", ["magic-initiate"]);
    build = apply(build, svc.setChoice, "feat:magic-initiate@species:human#versatile#spell_list", [
      "cleric",
    ]);
    build = autocomplete(build, cat);
    const sheet = computePlaySheet(build, createState(build, cat), cat);
    const mi = sheet.spellcasting.filter((l) => l.source === "Magic Initiate");
    expect(mi).toHaveLength(2);
    expect(mi.map((l) => l.key).sort()).toEqual(
      ["feat:magic-initiate@background:sage", "feat:magic-initiate@species:human#versatile"].sort(),
    );
    expect(mi.map((l) => l.granted_by).sort()).toEqual(["Human", "Sage"]);
    // Each MI's level 1 spell: granted through its own feat, cast with its own spellcasting line,
    // its free cast from that same source (one use each).
    for (const line of mi) {
      const spells = sheet.spells.filter((s) =>
        s.grants.some((g) => g.spellcasting_key === line.key),
      );
      expect(spells.length).toBeGreaterThanOrEqual(3); // two cantrips and a level 1 spell
      const first = spells.find((s) => s.level === 1);
      expect(first?.free.map((f) => f.source_key)).toContain(line.key);
      expect(first?.free.find((f) => f.source_key === line.key)?.use).toBe(`${line.key}:free-cast`);
    }
    // Existing identity unchanged: the line still names the feature by its source.
    expect(sheet.free_casts.every((f) => f.spellcasting === "Magic Initiate")).toBe(true);
  });

  it("an ordinary single-source character: one grant per spell, its key the spellcasting's", () => {
    const build = autocomplete(classBuild("wizard"));
    const sheet = computeSheet(build, catalog);
    const wizard = sheet.spellcasting.find((l) => l.source === "Wizard");
    expect(wizard?.key).toBeTruthy();
    for (const s of sheet.spells.filter((x) => x.source === "Wizard")) {
      expect(s.grants).toHaveLength(1);
      expect(s.grants[0]?.spellcasting_key).toBe(wizard?.key);
    }
  });
});
