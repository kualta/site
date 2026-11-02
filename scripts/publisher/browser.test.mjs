import { expect, test } from "bun:test";
import { closestPlace } from "./browser.mjs";

test("picks the place itself over places in it, ignoring accents and case", () => {
  const offered = [
    ["Habitaciones económicas x días, Teusaquillo, Bogotá.", "Cra. 30 #45, Bogotá"],
    ["波哥大市中心", "Bogota Centro"],
    ["波哥大", "Bogota"],
    ["Residence Inn by Marriott Bogota", "Cl. 90 #16-30, Bogotá, Colombia"],
  ];
  expect(closestPlace(offered, "Bogotá, Colombia")).toBe(2);
  expect(closestPlace(offered, "波哥大")).toBe(2);
});

test("prefers a name that starts with the place, then the shortest containing it", () => {
  expect(closestPlace([["Hotel Bogota Plaza"], ["Bogota DC"], ["Bogota, Colombia"]], "Bogota")).toBe(1);
  expect(closestPlace([["Monserrate bogota"], ["Norte De Bogota"]], "bogota")).toBe(1);
});

test("picks nothing when no offer is the place, rather than a nearby one", () => {
  expect(closestPlace([["Male Bathroom"], ["Cali"]], "Bogotá")).toBe(-1);
  // A nearby place's address names the city: that isn't the city.
  expect(closestPlace([["Male Bathroom", "Cra. 7 #45, Chapinero, Bogotá, Colombia"]], "Bogotá, Colombia")).toBe(-1);
  expect(closestPlace([], "Bogotá")).toBe(-1);
});

test("named: only a place called that, never one whose name mentions it", () => {
  const offered = [["Habitaciones económicas, Teusaquillo, Bogotá."], ["Bogota Bar"], ["波哥大", "Bogota"]];
  expect(closestPlace(offered, "Bogotá", { named: true })).toBe(2);
  expect(closestPlace([["Bogota Bar"]], "Bogotá", { named: true })).toBe(-1);
  expect(closestPlace([["Hostal en Bogotá"]], "Bogotá", { named: true })).toBe(-1);
  expect(closestPlace([["Hostal en Bogotá"]], "Bogotá")).toBe(0);
});
