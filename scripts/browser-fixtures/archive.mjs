import { writeCube } from "../grade/color.mjs";

/*
 * The archive's side of the mocked API, which the Footage tab's player reads: the shoot days the ledger's clips in the
 * cloud are filed under, one of thirty clips, and the grade app's settings backup with its grades, export records and
 * two stand-in looks whose colours a check can work out: the default look turns a colour to its negative, and Velvia
 * moves each channel its own way.
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

/** The clip the checks play off the Mac: the ledger has it there alone, graded there and not backed up yet. */
export const ON_MAC = "DJI_20261120183012_0399_D";
export const MAC_GRADE = { base: "fujifilm-velvia", exposure: -0.3, kelvin: 5000 };
export const MAC_KELVIN = 5400;
const macClips = {
  [ON_MAC]: {
    name: `${ON_MAC}.MP4`,
    on: "mac",
    day: "2026-11-20",
    size: 3_000_000_000,
    recorded: "2026-11-20T18:30:12",
    profile: "dlog2",
    duration: 4,
    cameraKelvin: MAC_KELVIN,
    grade: MAC_GRADE,
    transcript: true,
  },
};

/**
 * What the grade app on the Mac answers the composer's player (scripts/grade/server.mjs), to a Playwright route: what a
 * clip it has is, its original (`original`, a { mimeType, buffer } to play) and its transcript, allowed to the page
 * asking. As the app does, it refuses a request that names no origin, and says it hasn't any other clip.
 */
export async function macAnswer(route, original) {
  const request = route.request();
  const origin = await request.headerValue("origin");
  if (!origin) return route.fulfill({ status: 403, contentType: "application/json", body: '{"error":"no origin"}' });
  const headers = { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  const asked = /^\/footage\/([^/]+?)(?:\/(original|transcript\.vtt))?$/.exec(new URL(request.url()).pathname);
  const clip = asked && macClips[decodeURIComponent(asked[1])];
  if (!clip)
    return route.fulfill({ status: 404, headers, contentType: "application/json", body: '{"error":"not here"}' });
  if (asked[2] === "original") return route.fulfill({ headers, contentType: original.mimeType, body: original.buffer });
  if (asked[2]) return route.fulfill({ headers, contentType: "text/vtt", body: VTT });
  return route.fulfill({ headers, contentType: "application/json", body: JSON.stringify(clip) });
}

/**
 * A posted film, archived since: its render and its Chinese render beside film.html, its clips' copies and the Chinese
 * version's folder under it, and Studio's history. The ledger's other film is still on the Mac, and isn't archived.
 */
export const FILM = "013-maybe-later";
export const FILM_OUTPUTS = { render: hash(13_001), zh: hash(13_002) };
export const filmManifest = {
  name: FILM,
  archivedAt: "2026-11-20T10:00:00.000Z",
  files: [
    { path: `${FILM}-zh.mp4`, sha256: FILM_OUTPUTS.zh, size: 78_400_000, mtime: 1 },
    { path: `${FILM}.mp4`, sha256: FILM_OUTPUTS.render, size: 77_100_000, mtime: 1 },
    { path: "film.html", sha256: hash(13_003), size: 9_000, mtime: 1 },
    { path: `assets/${OPENED}`, sha256: hash(13_004), size: 410_000_000, mtime: 1 },
    { path: `zh/assets/${OPENED}`, sha256: hash(13_004), size: 410_000_000, mtime: 1 },
    { path: "zh/film.html", sha256: hash(13_005), size: 9_100, mtime: 1 },
    ...Array.from({ length: 40 }, (_, i) => ({
      path: `.film/history/objects/${String(i).padStart(2, "0")}/x`,
      sha256: hash(13_100 + i),
      size: 120,
      mtime: 1,
    })),
  ],
  folders: [],
};

/** What the archive routes answer, or null for any other path. */
export function archiveAnswer(path) {
  const day = /^archive\/days\/(.+)$/.exec(path)?.[1];
  if (day) return Response.json({ day, at: archiveSettings.at, clips: archiveDays[day] ?? [] });
  if (path === "archive/settings") return Response.json(archiveSettings);
  const project = /^archive\/projects\/(.+)$/.exec(path)?.[1];
  if (project)
    return project === FILM
      ? Response.json(filmManifest)
      : Response.json({ error: "Not in the archive" }, { status: 404 });
  const file = /^archive\/files\/([0-9a-f]{64})\/(.+)$/.exec(path);
  if (!file) return null;
  if (files[file[1]]) return new Response(files[file[1]].body(), { headers: { "Content-Type": files[file[1]].type } });
  if (file[2].endsWith(".vtt")) return new Response(VTT, { headers: { "Content-Type": "text/vtt" } });
  return Response.json({ error: "Not in the archive" }, { status: 404 });
}
