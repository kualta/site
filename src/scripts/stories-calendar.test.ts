import { expect, test } from "bun:test";
import { gapFor, nearestStep, zoomStep, zoomSteps } from "./stories-calendar";

test("the zoom steps on offer keep squares between 18 and 480 pixels", () => {
  expect(zoomSteps(960)).toEqual([2, 3, 4, 5, 7, 9, 12, 16, 22, 30, 40]);
  expect(zoomSteps(358)).toEqual([1, 2, 3, 4, 5, 7, 9, 12, 16]);
  expect(zoomSteps(0)).toEqual([1]);
});

test("a calendar opens near 140-pixel squares and keeps a remembered zoom where it fits", () => {
  expect(nearestStep(960, 960 / 140)).toBe(7);
  expect(nearestStep(358, 358 / 140)).toBe(3);
  // remembered on a wide screen, then opened on a phone, where 40 to a row would be too small
  expect(nearestStep(358, 40)).toBe(16);
});

test("zooming in takes fewer, larger squares to a row, zooming out more, and either end stays put", () => {
  expect(zoomStep(960, 7, "in")).toBe(5);
  expect(zoomStep(960, 7, "out")).toBe(9);
  expect(zoomStep(960, 2, "in")).toBe(2);
  expect(zoomStep(960, 40, "out")).toBe(40);
  expect(zoomStep(358, 16, "out")).toBe(16);
});

test("squares sit further apart while they are large", () => {
  expect([1, 3, 5, 7, 9, 16, 22, 40].map(gapFor)).toEqual([6, 6, 4, 4, 2, 2, 1, 1]);
});
