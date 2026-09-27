import { expect, test } from "bun:test";
import { stripPngMetadata, sanitizeImage, uploadMedia } from "./media";
import { stripMp4Metadata } from "./video";
import type { Agent } from "@atproto/api";
function concat(...arrays: Uint8Array[]) {
  const result = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}
function pngChunk(type: string, data = new Uint8Array()) {
  const out = new Uint8Array(data.length + 12);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  return out;
}
function box(type: string, data = new Uint8Array()) {
  const out = new Uint8Array(data.length + 8);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  return out;
}
const secret = new TextEncoder().encode("GPS=1,2 original-name.mov private-camera");
test("PNG strips all ancillary metadata and trailing bytes but retains pixel chunks", () => {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const pixels = pngChunk("IDAT", new Uint8Array([1, 2, 3]));
  const end = pngChunk("IEND");
  expect(
    stripPngMetadata(concat(signature, pngChunk("eXIf", secret), pngChunk("tEXt", secret), pixels, end, secret)),
  ).toEqual(concat(signature, pixels, end));
  expect(() => stripPngMetadata(signature)).toThrow();
  expect(() => stripPngMetadata(secret)).toThrow();
});
test("MP4 removes nested metadata without shifting sample offsets", () => {
  const input = concat(
    box("ftyp"),
    box("moov", concat(box("udta", secret), box("trak", box("meta", secret)))),
    box("mdat", new Uint8Array([1, 2, 3])),
  );
  const result = stripMp4Metadata(input);
  expect(result.length).toBe(input.length);
  expect(new TextDecoder().decode(result)).not.toContain("private-camera");
  expect(result.slice(-11)).toEqual(input.slice(-11));
  expect(() => stripMp4Metadata(input.slice(0, -1))).toThrow();
});
test("unsupported original files and unprepared videos cannot reach upload", async () => {
  await expect(sanitizeImage(new File([secret], "original.svg", { type: "image/svg+xml" }))).rejects.toThrow();
  let calls = 0;
  const agent = {
    uploadBlob: () => {
      calls++;
    },
  } as unknown as Agent;
  await expect(
    uploadMedia(agent, [
      { file: new File([secret], "private.mp4", { type: "video/mp4" }), alt: "", width: 0, height: 0 },
    ]),
  ).rejects.toThrow("Prepare");
  expect(calls).toBe(0);
});

test("MP4 clears creation/modification timestamps while retaining playback timing", () => {
  const payload = new Uint8Array(24).fill(42);
  payload[0] = 0;
  const result = stripMp4Metadata(box("moov", box("mvhd", payload)));
  expect([...result.slice(20, 28)]).toEqual(Array(8).fill(0));
  expect(result[28]).toBe(42);
});
