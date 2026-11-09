import { expect, test } from "bun:test";
import {
  PROFILES,
  adjuster,
  composeLut,
  gradeKey,
  normalizeGrade,
  parseCube,
  planckXy,
  profileOf,
  sampleTetra,
  whiteBalance,
  writeCube,
} from "./color.mjs";

const close = (a, b, eps) => expect(Math.abs(a - b)).toBeLessThan(eps);

// D-Log's published linear and log segments meet a hair apart at code 0.14 (under 1/1000 of a 10-bit code value),
// so values on the seam come back within 1e-5 rather than exactly.
test("each profile's curve round-trips its code values", () => {
  for (const p of Object.values(PROFILES)) {
    for (let i = 0; i <= 1000; i++) {
      const x = i / 1000;
      close(p.encode(p.decode(x)), x, 1e-5);
    }
  }
});

test("the log curves put 18% grey and black where DJI publishes them", () => {
  close(PROFILES.dlog.encode(0.18) * 1023, 408, 0.5);
  close(PROFILES.dlog.encode(0) * 1023, 95, 0.5);
  close(PROFILES.dlog2.encode(0.18) * 1023, 312, 0.5);
  close(PROFILES.dlog2.decode(64 / 1023), 0, 1e-6);
  close(PROFILES.hlg.encode(0.18), 0.38, 1e-9);
});

test("the camera's own tag picks the profile", () => {
  expect(profileOf("D-Log2")).toBe("dlog2");
  expect(profileOf("D-Log")).toBe("dlog");
  expect(profileOf("Rec.2100 HLG")).toBe("hlg");
  expect(profileOf(undefined, "arib-std-b67")).toBe("hlg");
  expect(profileOf("Rec.709")).toBe("rec709");
});

test("the Planckian locus passes through illuminant A", () => {
  const [x, y] = planckXy(2856);
  close(x, 0.4476, 0.001);
  close(y, 0.4074, 0.001);
});

test("white balance is identity at the camera's setting, warms above it, and tint goes magenta", () => {
  const prims = PROFILES.dlog2.prims;
  expect(whiteBalance(prims, 5180, 5180, 0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const warm = whiteBalance(prims, 5180, 6100, 0);
  const neutralWarm = [warm[0] + warm[1] + warm[2], warm[3] + warm[4] + warm[5], warm[6] + warm[7] + warm[8]];
  expect(neutralWarm[0]).toBeGreaterThan(neutralWarm[1]);
  expect(neutralWarm[2]).toBeLessThan(neutralWarm[1]);
  const magenta = whiteBalance(PROFILES.rec709.prims, 5600, 5600, 40);
  const n = [magenta[0] + magenta[1] + magenta[2], magenta[3] + magenta[4] + magenta[5], magenta[6] + magenta[7] + magenta[8]];
  expect(n[1]).toBeLessThan(n[0]);
  expect(n[1]).toBeLessThan(n[2]);
});

test("exposure doubles scene light per stop and the neutral grade changes nothing", () => {
  const p = PROFILES.dlog2;
  const code = p.encode(0.18);
  const up = adjuster("dlog2", { exposure: 1 }, 5600)(code, code, code);
  close(p.decode(up[0]), 0.36, 1e-9);
  expect(adjuster("dlog", {}, 5180)(0.3, 0.4, 0.5)).toEqual([0.3, 0.4, 0.5]);
});

test("saturation 0 makes neutrals and contrast keeps 18% grey", () => {
  const p = PROFILES.rec709;
  const grey = adjuster("rec709", { saturation: 0 }, 5600)(0.8, 0.4, 0.2);
  close(grey[0], grey[1], 1e-9);
  close(grey[1], grey[2], 1e-9);
  const g = p.encode(0.18);
  const kept = adjuster("rec709", { contrast: 1.4 }, 5600)(g, g, g);
  close(kept[0], g, 1e-9);
});

test("grades are clamped and keyed stably", () => {
  const g = normalizeGrade({ base: "aces", exposure: 9, tint: -500 });
  expect(g).toEqual({ base: "aces", exposure: 3, kelvin: null, tint: -100, contrast: 1, saturation: 1 });
  expect(gradeKey({ b: 1, a: 2 })).toBe(gradeKey({ a: 2, b: 1 }));
});

// A smooth, non-linear stand-in for a base look.
function syntheticBase(size) {
  const data = new Float32Array(size ** 3 * 3);
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const [x, y, z] = [r, g, b].map((v) => v / (size - 1));
        data[i++] = x ** 0.8;
        data[i++] = 0.5 * y + 0.5 * y * y;
        data[i++] = Math.sin(z * 1.4) / Math.sin(1.4);
      }
  return { size, data, min: [0, 0, 0], max: [1, 1, 1] };
}

test("tetrahedral sampling is exact for affine LUTs and at grid points", () => {
  const size = 5;
  const data = new Float32Array(size ** 3 * 3);
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const [x, y, z] = [r, g, b].map((v) => v / (size - 1));
        data[i++] = 0.2 + 0.5 * x + 0.1 * y;
        data[i++] = 0.3 * y + 0.4 * z;
        data[i++] = 0.9 * z - 0.2 * x + 0.1;
      }
  const lut = { size, data, min: [0, 0, 0], max: [1, 1, 1] };
  for (const [x, y, z] of [[0.13, 0.77, 0.42], [0.9, 0.1, 0.5], [0.33, 0.33, 0.95], [1, 1, 1], [0, 0, 0]]) {
    const v = sampleTetra(lut, x, y, z);
    close(v[0], 0.2 + 0.5 * x + 0.1 * y, 1e-6);
    close(v[1], 0.3 * y + 0.4 * z, 1e-6);
    close(v[2], 0.9 * z - 0.2 * x + 0.1, 1e-6);
  }
});

test("a neutral grade composes to the base look itself", () => {
  const base = syntheticBase(17);
  const out = composeLut({ profile: "dlog2", grade: {}, shotK: 5180, base, size: 17 });
  for (let i = 0; i < out.length; i++) close(out[i], base.data[i], 1e-6);
});

test(".cube files round-trip", () => {
  const base = syntheticBase(5);
  const parsed = parseCube(`# made by a test\n${writeCube(5, base.data, "round trip")}`);
  expect(parsed.size).toBe(5);
  expect(parsed.title).toBe("round trip");
  for (let i = 0; i < base.data.length; i++) close(parsed.data[i], base.data[i], 1e-6);
  expect(() => parseCube("LUT_1D_SIZE 4\n0 0 0\n")).toThrow();
});
