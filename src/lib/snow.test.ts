import { describe, expect, test } from "bun:test";
import { FLAKE_SVGS, makeFlakes, poseAt, snowSeconds } from "./snow";

const WIDTH = 1440;
const HEIGHT = 900;
const CHRISTMAS_EVE = Date.UTC(2026, 11, 24, 18, 30);

describe("snow", () => {
  test("the same flakes every time", () => {
    expect(makeFlakes(75)).toEqual(makeFlakes(75));
  });

  test("a phone's flakes are the first of the desktop's", () => {
    expect(makeFlakes(35)).toEqual(makeFlakes(75).slice(0, 35));
  });

  test("a reload at the same moment puts every flake where it was", () => {
    const seconds = snowSeconds(CHRISTMAS_EVE);
    const before = makeFlakes(75).map((flake) => poseAt(flake, seconds, WIDTH, HEIGHT));
    const after = makeFlakes(75).map((flake) => poseAt(flake, seconds, WIDTH, HEIGHT));
    expect(after).toEqual(before);
  });

  test("the first frame already has snow top to bottom", () => {
    const flakes = makeFlakes(75);
    for (let minute = 0; minute < 60; minute += 7) {
      const seconds = snowSeconds(CHRISTMAS_EVE + minute * 60_000);
      const ys = flakes.map((flake) => poseAt(flake, seconds, WIDTH, HEIGHT).y);
      for (let band = 0; band < 3; band++) {
        const top = (band * HEIGHT) / 3;
        const inBand = ys.filter((y) => y >= top && y < top + HEIGHT / 3).length;
        expect(inBand).toBeGreaterThan(8);
      }
    }
  });

  test("flakes fall smoothly from one frame to the next", () => {
    const seconds = snowSeconds(CHRISTMAS_EVE);
    for (const flake of makeFlakes(75)) {
      const now = poseAt(flake, seconds, WIDTH, HEIGHT);
      const next = poseAt(flake, seconds + 1 / 60, WIDTH, HEIGHT);
      const dy = next.y - now.y;
      // a flake that just left the bottom wraps to above the top
      if (dy < -HEIGHT / 2) continue;
      expect(dy).toBeGreaterThan(0);
      expect(dy).toBeLessThan(5);
      expect(Math.abs(next.x - now.x)).toBeLessThan(5);
    }
  });

  test("every design is in the sky", () => {
    expect(new Set(makeFlakes(75).map((flake) => flake.design)).size).toBe(FLAKE_SVGS.length);
  });
});
