// Colour math shared by the grade app's browser preview and its export. A clip's grade becomes one 3D LUT from the
// camera's code values (D-Log, D-Log2, HLG or Rec.709) to Rec.709 display values, built by the same function in both
// places, so what you see while grading is what gets baked.
//
// Order per pixel: decode the profile's curve to scene linear → white balance (CAT02, in the profile's own gamut) →
// exposure → saturation → contrast → encode back to the profile's curve → the base look (a .cube that takes that
// profile's code values, e.g. the ACES conversion or a P4P look).

export const D65 = [0.3127, 0.329];

// ---- 3×3 matrices, row-major arrays of nine -------------------------------------------------------------------

export function mul(a, b) {
  const o = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
}

export function inv(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error("singular matrix");
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(
    (v) => v / det,
  );
}

export const apply3 = (m, [r, g, b]) => [
  m[0] * r + m[1] * g + m[2] * b,
  m[3] * r + m[4] * g + m[5] * b,
  m[6] * r + m[7] * g + m[8] * b,
];

const diag = ([a, b, c]) => [a, 0, 0, 0, b, 0, 0, 0, c];
const xyToXYZ = ([x, y]) => [x / y, 1, (1 - x - y) / y];

/** RGB → XYZ for primaries [[x,y]×3] and a white point. */
export function rgbToXyz(prims, white) {
  const cols = prims.map(xyToXYZ);
  const P = [cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]];
  return mul(P, diag(apply3(inv(P), xyToXYZ(white))));
}

const CAT02 = [0.7328, 0.4296, -0.1624, -0.7036, 1.6975, 0.0061, 0.003, 0.0136, 0.9834];

/** CAT02 von Kries adaptation in XYZ, from one white point to another. */
export function cat02(src, dst) {
  const s = apply3(CAT02, xyToXYZ(src));
  const d = apply3(CAT02, xyToXYZ(dst));
  return mul(inv(CAT02), mul(diag([d[0] / s[0], d[1] / s[1], d[2] / s[2]]), CAT02));
}

// ---- white points along the Planckian locus -------------------------------------------------------------------

/** Planckian locus chromaticity (Kim et al. 2002 cubic splines, 1667–25000 K). */
export function planckXy(kelvin) {
  const T = Math.min(25000, Math.max(1667, kelvin));
  const x =
    T <= 4000
      ? -0.2661239e9 / T ** 3 - 0.2343589e6 / T ** 2 + 0.8776956e3 / T + 0.17991
      : -3.0258469e9 / T ** 3 + 2.1070379e6 / T ** 2 + 0.2226347e3 / T + 0.24039;
  let y;
  if (T <= 2222) y = -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683;
  else if (T <= 4000) y = -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867;
  else y = 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

const toUv = ([x, y]) => {
  const d = -2 * x + 12 * y + 3;
  return [(4 * x) / d, (6 * y) / d];
};
const fromUv = ([u, v]) => {
  const d = 2 * u - 8 * v + 4;
  return [(3 * u) / d, (2 * v) / d];
};

/** A white point: on the Planckian locus at `kelvin`, moved `duv` off it in CIE 1960 uv (positive = greener). */
export function whiteXy(kelvin, duv = 0) {
  if (!duv) return planckXy(kelvin);
  const uv = toUv(planckXy(kelvin));
  const a = toUv(planckXy(kelvin * 0.998));
  const b = toUv(planckXy(kelvin * 1.002));
  let n = [-(b[1] - a[1]), b[0] - a[0]];
  const len = Math.hypot(n[0], n[1]);
  n = [n[0] / len, n[1] / len];
  if (n[1] < 0) n = [-n[0], -n[1]];
  return fromUv([uv[0] + duv * n[0], uv[1] + duv * n[1]]);
}

/** Tint slider units (−100…100, positive = magenta picture) → Δuv. ±100 is ±0.02, a strong cast. */
export const TINT_DUV = 0.0002;

/**
 * White balance in linear RGB of `prims` (D65 encoding): re-balance footage the camera set to `shotK` as if it had
 * been set to `targetK`, with `tint` added. Undo the camera's adaptation, redo it from the new white. The picture
 * moves opposite to the white it is balanced to: a higher target than shot warms it, as on the camera, and a
 * greener white (positive tint) turns it magenta.
 */
export function whiteBalance(prims, shotK, targetK, tint = 0) {
  if (targetK === shotK && !tint) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const P = rgbToXyz(prims, D65);
  const M = mul(cat02(whiteXy(targetK, tint * TINT_DUV), D65), cat02(D65, whiteXy(shotK)));
  return mul(inv(P), mul(M, P));
}

// ---- profiles: gamut and curve ----------------------------------------------------------------------------------

const DLOG2 = { H: 475, a: 16.285770761945304, k1: 0.059439938321493, b1: 0.304985337243402, k2: 2.96093524549225, b2: 0.148314799066323, l2: 0.028961695254132 };
const HLG = { a: 0.17883277, b: 0.28466892, c: 0.55991073, scale: 0.18 / ((0.38 * 0.38) / 3) };
const spow = (x, p) => Math.sign(x) * Math.abs(x) ** p;

export const PROFILES = {
  // DJI's D-Log2 DCTL constants (as quoted in aces-aswf/aces-input-and-colorspaces#36), D-Gamut2 primaries.
  dlog2: {
    name: "D-Log2",
    prims: [[0.7347, 0.2653], [0.16, 0.84], [0.09, -0.08]],
    decode(x) {
      const { H, a, k1, b1, k2, b2, l2 } = DLOG2;
      if (x >= b1) return (H / (2 ** a - 1)) * (2 ** (a * x) - 1);
      if (x >= b2) return 2 ** ((x - b1) / k1 + Math.log2(0.18));
      return (x - b2) / k2 + l2;
    },
    encode(l) {
      const { H, a, k1, b1, k2, b2, l2 } = DLOG2;
      if (l >= 0.18) return Math.log2((l * (2 ** a - 1)) / H + 1) / a;
      if (l >= l2) return k1 * Math.log2(l / 0.18) + b1;
      return k2 * (l - l2) + b2;
    },
  },
  // DJI's D-Log / D-Gamut white paper (rev 1.0, 2017).
  dlog: {
    name: "D-Log",
    prims: [[0.71, 0.31], [0.21, 0.88], [0.09, -0.08]],
    decode: (x) => (x <= 0.14 ? (x - 0.0929) / 6.025 : (10 ** (3.89616 * x - 2.27752) - 0.0108) / 0.9892),
    encode: (l) => (l <= 0.0078 ? 6.025 * l + 0.0929 : Math.log10(l * 0.9892 + 0.0108) * 0.256663 + 0.584555),
  },
  // BT.2100 HLG, scene light scaled so a 38% signal (BT.2408's 18% grey) is 0.18.
  hlg: {
    name: "HLG",
    prims: [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]],
    decode(x) {
      const { a, b, c, scale } = HLG;
      return (x <= 0.5 ? spow(x, 2) / 3 : (Math.exp((x - c) / a) + b) / 12) * scale;
    },
    encode(l) {
      const { a, b, c, scale } = HLG;
      const e = l / scale;
      return e <= 1 / 12 ? spow(3 * e, 0.5) : a * Math.log(12 * e - b) + c;
    },
  },
  // Rec.709 as shot: adjustments in display light (BT.1886, gamma 2.4).
  rec709: {
    name: "Rec.709",
    prims: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]],
    decode: (x) => spow(x, 2.4),
    encode: (l) => spow(l, 1 / 2.4),
  },
};

/** The camera's profile tag (com.dji.camera.ColorGammaSxS) or its transfer → a profile id. */
export function profileOf(gammaTag, transfer) {
  const t = String(gammaTag ?? "").toLowerCase();
  if (t === "d-log2" || t === "d-log 2") return "dlog2";
  if (t === "d-log") return "dlog";
  if (t.includes("hlg") || transfer === "arib-std-b67") return "hlg";
  return "rec709";
}

// ---- grades -----------------------------------------------------------------------------------------------------

export const NEUTRAL = Object.freeze({ exposure: 0, kelvin: null, tint: 0, contrast: 1, saturation: 1 });

export const LIMITS = {
  exposure: [-3, 3],
  kelvin: [2000, 12000],
  tint: [-100, 100],
  contrast: [0.5, 1.6],
  saturation: [0, 2],
};

/** A grade with every field present and in range; `base` is kept as given. */
export function normalizeGrade(g = {}) {
  const out = { base: g.base ?? null };
  for (const [k, def] of Object.entries(NEUTRAL)) {
    let v = g[k] ?? def;
    if (v !== null && LIMITS[k]) v = Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], Number(v)));
    out[k] = v;
  }
  return out;
}

/** Stable text of a grade, for telling whether an export is up to date. */
export function gradeKey(g) {
  const sorted = {};
  for (const k of Object.keys(g).sort()) sorted[k] = g[k];
  return JSON.stringify(sorted);
}

/**
 * A clip's grade as it will actually be applied: every field in range and a base that exists for its profile
 * (`baseIds`). An unknown or missing base falls back to the ACES conversion, or to none where there is no ACES base.
 */
export function resolveGrade(grade, baseIds) {
  const g = normalizeGrade(grade);
  if (!g.base || !baseIds.includes(g.base)) g.base = baseIds.includes("aces") ? "aces" : "none";
  return g;
}

/**
 * The per-pixel adjustment for one clip as a function of code values, plus everything it needs precomputed.
 * `shotK` is the white balance the camera recorded (Kelvin); a grade's `kelvin: null` keeps it.
 */
export function adjuster(profileId, grade, shotK) {
  const p = PROFILES[profileId];
  if (!p) throw new Error(`unknown profile ${profileId}`);
  const g = normalizeGrade(grade);
  const camK = Number(shotK) > 0 ? Number(shotK) : 5600;
  const M = whiteBalance(p.prims, camK, g.kelvin ?? camK, g.tint);
  const gain = 2 ** g.exposure;
  const P = rgbToXyz(p.prims, D65);
  const w = [P[3], P[4], P[5]];
  const sat = g.saturation;
  const con = g.contrast;
  const identity = M.every((v, i) => v === [1, 0, 0, 0, 1, 0, 0, 0, 1][i]) && gain === 1 && sat === 1 && con === 1;
  return function adjust(r, gr, b) {
    if (identity) return [r, gr, b];
    let lin = apply3(M, [p.decode(r), p.decode(gr), p.decode(b)]);
    lin = [lin[0] * gain, lin[1] * gain, lin[2] * gain];
    if (sat !== 1) {
      const Y = w[0] * lin[0] + w[1] * lin[1] + w[2] * lin[2];
      lin = lin.map((v) => Y + sat * (v - Y));
    }
    if (con !== 1) lin = lin.map((v) => (v > 0 ? 0.18 * (v / 0.18) ** con : v));
    return lin.map((v) => Math.min(1, Math.max(0, p.encode(v))));
  };
}

// ---- .cube LUTs -------------------------------------------------------------------------------------------------

/** Parse a 3D .cube file. Data is red-fastest, as the format stores it. */
export function parseCube(text) {
  let size = 0;
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  let title = "";
  const values = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const c = line.charCodeAt(0);
    if ((c >= 48 && c <= 57) || c === 45 || c === 46) {
      const parts = line.split(/\s+/);
      values.push(+parts[0], +parts[1], +parts[2]);
    } else if (line.startsWith("LUT_3D_SIZE")) size = Number(line.split(/\s+/)[1]);
    else if (line.startsWith("LUT_1D_SIZE")) throw new Error("1D .cube LUTs are not supported");
    else if (line.startsWith("DOMAIN_MIN")) min = line.split(/\s+/).slice(1).map(Number);
    else if (line.startsWith("DOMAIN_MAX")) max = line.split(/\s+/).slice(1).map(Number);
    else if (line.startsWith("TITLE")) title = line.replace(/^TITLE\s+/, "").replace(/^"|"$/g, "");
  }
  if (!size || values.length !== size ** 3 * 3) throw new Error(`bad .cube: size ${size}, ${values.length / 3} entries`);
  return { size, data: Float32Array.from(values), min, max, title };
}

/** Serialise LUT data (red-fastest, size³×3) as a .cube file. */
export function writeCube(size, data, title = "grade") {
  const lines = [`TITLE "${title.replace(/"/g, "'")}"`, `LUT_3D_SIZE ${size}`, "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"];
  for (let i = 0; i < data.length; i += 3) lines.push(`${data[i].toFixed(6)} ${data[i + 1].toFixed(6)} ${data[i + 2].toFixed(6)}`);
  return `${lines.join("\n")}\n`;
}

/** Tetrahedral interpolation into a parsed LUT, as ffmpeg's lut3d interp=tetrahedral does. */
export function sampleTetra(lut, r, g, b) {
  const { size, data, min, max } = lut;
  const n = size - 1;
  const f = (v, i) => Math.min(n, Math.max(0, ((v - min[i]) / (max[i] - min[i])) * n));
  const fr = f(r, 0);
  const fg = f(g, 1);
  const fb = f(b, 2);
  const r0 = Math.min(n - 1, Math.floor(fr));
  const g0 = Math.min(n - 1, Math.floor(fg));
  const b0 = Math.min(n - 1, Math.floor(fb));
  const dr = fr - r0;
  const dg = fg - g0;
  const db = fb - b0;
  const at = (ri, gi, bi) => ((b0 + bi) * size + (g0 + gi)) * size + (r0 + ri);
  const c000 = at(0, 0, 0) * 3;
  const c111 = at(1, 1, 1) * 3;
  let p1;
  let p2;
  let w1;
  let w2;
  let w3;
  if (dr > dg) {
    if (dg > db) [p1, p2, w1, w2, w3] = [at(1, 0, 0), at(1, 1, 0), dr, dg, db];
    else if (dr > db) [p1, p2, w1, w2, w3] = [at(1, 0, 0), at(1, 0, 1), dr, db, dg];
    else [p1, p2, w1, w2, w3] = [at(0, 0, 1), at(1, 0, 1), db, dr, dg];
  } else if (db > dg) [p1, p2, w1, w2, w3] = [at(0, 0, 1), at(0, 1, 1), db, dg, dr];
  else if (db > dr) [p1, p2, w1, w2, w3] = [at(0, 1, 0), at(0, 1, 1), dg, db, dr];
  else [p1, p2, w1, w2, w3] = [at(0, 1, 0), at(1, 1, 0), dg, dr, db];
  p1 *= 3;
  p2 *= 3;
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const a = data[c000 + k];
    const x = data[p1 + k];
    const y = data[p2 + k];
    const z = data[c111 + k];
    out[k] = a + w1 * (x - a) + w2 * (y - x) + w3 * (z - y);
  }
  return out;
}

// ---- decoder calibration ----------------------------------------------------------------------------------------

/** The calibration clip's layout: 256 grey steps in a 16×16 grid of 80×45 blocks, 1280×720 like a proxy. */
export const CALIBRATION = { steps: 256, cols: 16, block: [80, 45], size: [1280, 720] };

/** Mean colour (0–1) of the middle of each calibration block, from interleaved pixels with `channels` per pixel. */
export function blockMeans(px, channels) {
  const { steps, cols, block, size } = CALIBRATION;
  const out = [];
  for (let i = 0; i < steps; i++) {
    const x0 = (i % cols) * block[0] + 20;
    const y0 = Math.floor(i / cols) * block[1] + 12;
    const s = [0, 0, 0];
    let n = 0;
    for (let y = y0; y < y0 + block[1] - 24; y++)
      for (let x = x0; x < x0 + block[0] - 40; x++) {
        const k = (y * size[0] + x) * channels;
        s[0] += px[k];
        s[1] += px[k + 1];
        s[2] += px[k + 2];
        n++;
      }
    out.push(s.map((v) => v / n / 255));
  }
  return out;
}

/**
 * Per-channel tables (256 entries) taking what this browser decoded to what ffmpeg decodes, from the calibration
 * ramp: `measured` and `expected` are [r,g,b] per step. Kept monotonic; outside the measured range it holds level.
 */
export function inputCurves(measured, expected) {
  return [0, 1, 2].map((k) => {
    const pts = measured.map((m, i) => [m[k], expected[i][k]]).sort((a, b) => a[0] - b[0]);
    const xs = [];
    const ys = [];
    for (const [x, y] of pts) {
      if (xs.length && Math.abs(x - xs[xs.length - 1]) < 1e-6) ys[ys.length - 1] = (ys[ys.length - 1] + y) / 2;
      else {
        xs.push(x);
        ys.push(y);
      }
    }
    for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1]);
    const table = new Float32Array(256);
    let j = 0;
    for (let v = 0; v < 256; v++) {
      const x = v / 255;
      while (j < xs.length - 2 && xs[j + 1] < x) j++;
      if (x <= xs[0]) table[v] = ys[0] + (x - xs[0]);
      else if (x >= xs[xs.length - 1]) table[v] = ys[ys.length - 1] + (x - xs[xs.length - 1]);
      else table[v] = ys[j] + ((x - xs[j]) / (xs[j + 1] - xs[j])) * (ys[j + 1] - ys[j]);
    }
    return table;
  });
}

const curveAt = (table, x) => {
  const f = Math.min(255, Math.max(0, x * 255));
  const i = Math.min(254, Math.floor(f));
  return table[i] + (f - i) * (table[i + 1] - table[i]);
};

/**
 * One clip's whole grade as a LUT of `size`³ (red-fastest): adjust in scene linear, then the base look.
 * `base` is a parsed .cube taking the profile's code values, or null for none (the adjusted code values themselves).
 * `input`, the browser's decoder correction (inputCurves), is applied to the grid first; the export leaves it out.
 */
export function composeLut({ profile, grade, shotK, base, size = 33, input = null }) {
  const adjust = adjuster(profile, grade, shotK);
  const out = new Float32Array(size ** 3 * 3);
  const step = 1 / (size - 1);
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const code = input
          ? adjust(curveAt(input[0], r * step), curveAt(input[1], g * step), curveAt(input[2], b * step))
          : adjust(r * step, g * step, b * step);
        const v = base ? sampleTetra(base, code[0], code[1], code[2]) : code;
        out[i++] = v[0];
        out[i++] = v[1];
        out[i++] = v[2];
      }
  return out;
}
