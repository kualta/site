import { expect, test } from "bun:test";
import { between, mousePath, spotIn } from "./human.mjs";

/** The same "random" numbers every run. */
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("a mouse path ends exactly on the spot, in many small steps, without straying far", () => {
  for (let seed = 1; seed <= 50; seed++) {
    const from = { x: 100, y: 700 };
    const to = { x: 900, y: 200 };
    const path = mousePath(from, to, seeded(seed));
    expect(path.at(-1)).toEqual(to);
    expect(path.length).toBeGreaterThanOrEqual(12);
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    for (let i = 1; i < path.length; i++)
      expect(Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)).toBeLessThan(distance / 4);
    for (const point of path) {
      expect(point.x).toBeGreaterThan(0);
      expect(point.x).toBeLessThan(1000);
    }
  }
});

test("a mouse path curves rather than running straight", () => {
  const from = { x: 0, y: 0 };
  const to = { x: 600, y: 0 };
  const off = mousePath(from, to, seeded(7)).map((point) => Math.abs(point.y));
  expect(Math.max(...off)).toBeGreaterThan(10);
});

test("a move of a pixel or two is a single step", () => {
  expect(mousePath({ x: 10, y: 10 }, { x: 11, y: 10 })).toEqual([{ x: 11, y: 10 }]);
});

test("clicks land inside a control, away from its edges", () => {
  const random = seeded(3);
  for (let i = 0; i < 200; i++) {
    const spot = spotIn({ width: 120, height: 40 }, random);
    expect(spot.x).toBeGreaterThanOrEqual(24);
    expect(spot.x).toBeLessThanOrEqual(96);
    expect(spot.y).toBeGreaterThanOrEqual(8);
    expect(spot.y).toBeLessThanOrEqual(32);
  }
});

test("between stays in its range", () => {
  const random = seeded(9);
  for (let i = 0; i < 100; i++) {
    const value = between(55, 170, random);
    expect(value).toBeGreaterThanOrEqual(55);
    expect(value).toBeLessThan(170);
  }
});
