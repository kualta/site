import { writeCube } from "../grade/color.mjs";

/*
 * The Archive tab's side of the mocked API: three shoot days offloaded to Cloudflare, one long enough to page through,
 * and the grade app's settings backup with its grades, export records and two stand-in looks whose colours a check can
 * work out: the default look turns a colour to its negative, and Velvia moves each channel its own way.
 */
export const hash = (n) => n.toString(16).padStart(64, "0");
export const LOOKS = {
  "opendrt-colorful": (r, g, b) => [1 - r, 1 - g, 1 - b],
  "fujifilm-velvia": (r, g, b) => [Math.sqrt(r), g * g, 1 - b * 0.5],
};
/** A look as the grade app backs it up: 33³, red fastest. */
export function lookCube(id, size = 33) {
  const data = new Float32Array(size ** 3 * 3);
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++)
        for (const v of LOOKS[id](r / (size - 1), g / (size - 1), b / (size - 1))) data[i++] = v;
  return writeCube(size, data, `${id === "fujifilm-velvia" ? "Velvia" : "Colorful"} · dlog2 · grade app`);
}
/** The clip the checks open: it's in the ledger, graded on Velvia with its white balance moved. */
export const OPENED = "DJI_20261108122204_0086_D.mp4";
export const GRADE = { base: "fujifilm-velvia", exposure: 0.5, saturation: 1.3, kelvin: 5000 };
export const CAMERA_KELVIN = 5600;
export const VTT = `WEBVTT

00:00.000 --> 00:01.200
Okay, rolling.

00:01.200 --> 00:02.400
This is the market at noon.

00:02.400 --> 00:03.000
Let's walk.
`;

const day8 = Array.from({ length: 30 }, (_, i) => {
  const n = 70 + i;
  const file =
    n === 86 ? OPENED : `DJI_2026110811${String(10 + i).padStart(2, "0")}00_${String(n).padStart(4, "0")}_D.mp4`;
  return { file, sha256: hash(n), size: 2_000_000_000 + n * 10_000_000, ...(n % 4 ? { vtt: hash(10_000 + n) } : {}) };
});
export const archiveDays = {
  "2026-11-21": [{ file: "DJI_20261121101500_0402_D.MP4", sha256: hash(402), size: 3_000_000_000, vtt: hash(10_402) }],
  "2026-11-11": [{ file: "DJI_20261111161230_0258_D.MP4", sha256: hash(258), size: 3_000_000_000 }],
  "2026-11-08": day8,
};
const files = {
  [hash(9001)]: {
    path: "looks/dlog2/opendrt-colorful.cube",
    body: () => lookCube("opendrt-colorful"),
    type: "text/plain",
  },
  [hash(9002)]: {
    path: "looks/dlog2/fujifilm-velvia.cube",
    body: () => lookCube("fujifilm-velvia"),
    type: "text/plain",
  },
  [hash(9003)]: {
    path: "grades.json",
    body: () => JSON.stringify({ version: 1, clips: { [OPENED]: GRADE } }),
    type: "application/json",
  },
  [hash(9004)]: {
    path: "exports.json",
    body: () => JSON.stringify({ version: 1, clips: { [OPENED]: { profile: "dlog2", cameraKelvin: CAMERA_KELVIN } } }),
    type: "application/json",
  },
};
export const archiveSettings = {
  at: "2026-11-21T09:00:00.000Z",
  files: Object.fromEntries(Object.entries(files).map(([sha256, file]) => [file.path, { sha256, size: 1 }])),
};

/** What the archive routes answer, or null for any other path. */
export function archiveAnswer(path) {
  if (path === "archive/days") return Response.json({ days: Object.keys(archiveDays) });
  const day = /^archive\/days\/(.+)$/.exec(path)?.[1];
  if (day) return Response.json({ day, at: archiveSettings.at, clips: archiveDays[day] ?? [] });
  if (path === "archive/settings") return Response.json(archiveSettings);
  const file = /^archive\/files\/([0-9a-f]{64})\/(.+)$/.exec(path);
  if (!file) return null;
  if (files[file[1]]) return new Response(files[file[1]].body(), { headers: { "Content-Type": files[file[1]].type } });
  if (file[2].endsWith(".vtt")) return new Response(VTT, { headers: { "Content-Type": "text/vtt" } });
  return Response.json({ error: "Not in the archive" }, { status: 404 });
}
