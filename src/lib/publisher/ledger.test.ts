import { expect, test } from "bun:test";
import { atRisk, footageLine, type Ledger, type LedgerClip, ledgerKey, lost, storage } from "./ledger";

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
