import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { importer, midi, Settings } from "@coderline/alphatab";

// Real MuseScore export: protect the grand staff and alternate-ending timeline
// that the MP3 cursor depends on when upgrading the notation library.
describe("Dialogue score", () => {
  const settings = new Settings();
  const score = importer.ScoreLoader.loadScoreFromBytes(
    new Uint8Array(readFileSync(new URL("../../public/music/scores/dialogue.mxl", import.meta.url))),
    settings,
  );
  test("retains both piano staves and the written tempo", () => {
    expect(score.tracks[0].staves).toHaveLength(2);
    expect(score.masterBars).toHaveLength(42);
    expect(score.tempo).toBe(105);
  });
  test("plays repeats with first endings skipped on the second pass", () => {
    const generator = new midi.MidiFileGenerator(
      score,
      settings,
      new midi.AlphaSynthMidiFileHandler(new midi.MidiFile()),
    );
    generator.generate();
    const bars = generator.tickLookup.masterBars.map((bar) => bar.masterBar.index + 1);
    expect(bars).toHaveLength(49);
    expect(bars.slice(6, 16)).toEqual([7, 8, 9, 10, 11, 7, 8, 9, 10, 12]);
    expect(bars.slice(33, 41)).toEqual([30, 31, 32, 33, 30, 31, 32, 34]);
  });
});
