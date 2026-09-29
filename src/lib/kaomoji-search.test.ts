import { describe, expect, test } from "bun:test";
import { searchKaomoji, type KaomojiIndex } from "./kaomoji-search";
import { allKaomoji, kaomojiSearchIndex } from "../data/kaomoji-library";
import { kaomoji } from "../data/kaomoji";

const fixture: KaomojiIndex = {
  tags: ["cat", "happy", "ねこ", "sad", "dog", "uncategorized"],
  entries: [
    ["(=^･ω･^=)", [0, 1, 2]],
    ["(= ; ｪ ; =)", [0, 2, 3]],
    ["U・ᴥ・U", [4, 1, 5]],
  ],
};

describe("kaomoji search", () => {
  test("matches multiple classifications on the same expression", () => {
    expect(searchKaomoji(fixture, "cat happy")).toEqual(["(=^･ω･^=)"]);
    expect(searchKaomoji(fixture, "happy sad")).toEqual([]);
  });

  test("matches label prefixes without matching cat inside uncategorized", () => {
    expect(searchKaomoji(fixture, "cat")).toEqual(["(=^･ω･^=)", "(= ; ｪ ; =)"]);
    expect(searchKaomoji(fixture, "hap")).toEqual(["(=^･ω･^=)", "U・ᴥ・U"]);
  });

  test("supports multilingual labels and width-insensitive queries", () => {
    expect(searchKaomoji(fixture, "ねこ")).toHaveLength(2);
    expect(searchKaomoji(fixture, " ＣＡＴ  HAPPY ")).toEqual(["(=^･ω･^=)"]);
  });

  test("searches literal glyphs while returning their original spacing and width", () => {
    expect(searchKaomoji(fixture, "ｪ")).toEqual(["(= ; ｪ ; =)"]);
    expect(searchKaomoji(fixture, "ᴥ")).toEqual(["U・ᴥ・U"]);
  });

  test("returns no matches for unknown labels and all entries for empty queries", () => {
    expect(searchKaomoji(fixture, "not-a-tag")).toEqual([]);
    expect(searchKaomoji(fixture, " ")).toEqual(fixture.entries.map(([text]) => text));
  });

  test("retains every existing expression and merges source classifications", () => {
    const originals = new Set(Object.values(kaomoji).flat().map((text) => text.trim().normalize("NFC")));
    const library = new Set(allKaomoji);
    expect([...originals].every((text) => library.has(text))).toBe(true);
    expect(library.size).toBe(allKaomoji.length);
    expect(library.size).toBeGreaterThan(originals.size);
    const cat = kaomojiSearchIndex.entries.find(([text]) => text === "(=^･ω･^=)");
    expect(cat).toBeDefined();
    const labels = cat![1].map((id) => kaomojiSearchIndex.tags[id]);
    expect(labels).toContain("cat");
    expect(labels.some((label) => /ねこ|猫/.test(label))).toBe(true);
  });
});
