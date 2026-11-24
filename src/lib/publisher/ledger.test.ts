import { expect, test } from "bun:test";
import {
  atRisk,
  filmNumber,
  filmPosts,
  footageLine,
  type Ledger,
  type LedgerClip,
  ledgerKey,
  linkedClips,
  lost,
  pieceFootage,
  storage,
} from "./ledger";

const clip = (extra: Partial<LedgerClip> = {}): LedgerClip => ({
  name: "DJI_20261108122204_0086_D.MP4",
  recorded: "2026-11-08T12:22:04",
  profile: "dlog2",
  duration: 30,
  size: 3_000_000_000,
  original: { camera: false, mac: false, cloudflare: false },
  graded: null,
  gradePending: false,
  ...extra,
});
/** A graded copy everywhere it can be, as the ledger still records an old one. */
const graded = {
  look: "Umbra",
  at: null,
  size: 1_000_000_000,
  mac: true,
  cloudflare: "current" as const,
  youtube: { video: "v", at: "", current: true },
};

test("a clip named in an address is found by its key in any case, and nothing else is", () => {
  const ledger = {
    updatedAt: "",
    camera: { name: "Pocket 4P", mounted: false, seenAt: null },
    archiveAt: null,
    clips: { DJI_20261108122204_0086_D: clip(), IMG_4857: clip({ name: "IMG_4857.MOV" }) },
  } as Ledger;
  expect(ledgerKey(ledger, "DJI_20261108122204_0086_D")).toBe("DJI_20261108122204_0086_D");
  expect(ledgerKey(ledger, "img_4857")).toBe("IMG_4857");
  for (const missing of ["DJI_20261108122204_0087_D", "constructor", ""])
    expect(ledgerKey(ledger, missing)).toBeUndefined();
});

test("only an original is a copy of a clip: a graded copy on the Mac, in the cloud or on YouTube isn't", () => {
  const nowhere = clip({ graded });
  expect(lost(nowhere)).toBe(true);
  expect(atRisk(nowhere)).toBe(true);

  for (const where of ["camera", "mac"] as const) {
    const here = clip({ original: { camera: false, mac: false, cloudflare: false, [where]: true }, graded });
    expect(lost(here)).toBe(false);
    expect(atRisk(here)).toBe(true);
  }

  const cloud = clip({ original: { camera: false, mac: false, cloudflare: true } });
  expect(lost(cloud)).toBe(false);
  expect(atRisk(cloud)).toBe(false);
});

test("the footage is weighed by its originals; YouTube counts its videos", () => {
  const clips = [
    clip({ original: { camera: true, mac: false, cloudflare: true }, graded }),
    clip({ original: { camera: false, mac: true, cloudflare: false }, size: 2_000_000_000 }),
    clip({ graded: { ...graded, youtube: null } }),
  ];
  expect(storage(clips)).toEqual({
    camera: { clips: 1, bytes: 3_000_000_000 },
    mac: { clips: 1, bytes: 2_000_000_000 },
    cloudflare: { clips: 1, bytes: 3_000_000_000 },
    youtube: { videos: 1 },
  });
});

test("a piece's footage line counts as at risk what has no original in the cloud", () => {
  const clips = [
    clip({ original: { camera: false, mac: false, cloudflare: true } }),
    clip({ original: { camera: true, mac: false, cloudflare: false }, graded }),
    clip({ profile: "rec709", original: { camera: false, mac: true, cloudflare: false } }),
  ];
  expect(footageLine(clips)).toBe("3 clips · 1 graded · 2 at risk");
});

test("a piece's film is the one with its number, unless it was linked to a film by name", () => {
  const ledger = {
    updatedAt: "",
    camera: { name: "Pocket 4P", mounted: false, seenAt: null },
    archiveAt: null,
    clips: { DJI_20261108122204_0086_D: clip(), IMG_4857: clip({ name: "IMG_4857.MOV" }) },
    projects: {
      "013-maybe-later": { clips: ["IMG_4857"], local: false, archived: true },
      "017-big-cookie": { clips: ["DJI_20261108122204_0086_D"], local: true, archived: false },
      "instagram-stories": { clips: [], local: false, archived: true },
    },
  } as Ledger;
  const names = ["017-big-cookie", "1000-later", "17-short", "instagram-stories", "_originals-2026-11-08"];
  expect(names.map(filmNumber)).toEqual([17, 1000, null, null, null]);
  expect(pieceFootage(17, undefined, ledger)).toEqual({ project: "017-big-cookie" });
  expect(linkedClips(pieceFootage(17, undefined, ledger), ledger)?.map((c) => c.name)).toEqual([
    "DJI_20261108122204_0086_D.MP4",
  ]);
  // A link from before numbers still holds, and a shoot day holds until the film is made.
  expect(pieceFootage(17, { project: "013-maybe-later" }, ledger)).toEqual({ project: "013-maybe-later" });
  expect(pieceFootage(17, { day: "2026-11-08" }, ledger)).toEqual({ project: "017-big-cookie" });
  expect(pieceFootage(18, { day: "2026-11-08" }, ledger)).toEqual({ day: "2026-11-08" });
  expect(pieceFootage(null, undefined, ledger)).toBeUndefined();
  expect(pieceFootage(18, undefined, null)).toBeUndefined();
});

test("a film's post is its numbered piece's, or the post of a piece linked to it by name", () => {
  const piece = (id: string, number: number | null, job_id: string | null, stage = "posted") => ({
    id,
    number,
    job_id,
    stage,
  });
  const posts = filmPosts(
    [piece("a", 13, "job-13"), piece("b", 17, null, "edit"), piece("c", null, "job-old"), piece("d", 18, "job-18")],
    { c: { project: "004-filming-the-road" }, d: { day: "2026-11-21" } },
  );
  expect(posts.get("013-maybe-later")).toBe("job-13");
  expect(posts.get("004-filming-the-road")).toBe("job-old");
  expect(posts.get("018-walk")).toBe("job-18");
  // Not posted yet, or no piece with its number.
  expect(posts.get("017-big-cookie")).toBeUndefined();
  expect(posts.get("016-poof-launch")).toBeUndefined();
  expect(posts.get("instagram-stories")).toBeUndefined();
});
