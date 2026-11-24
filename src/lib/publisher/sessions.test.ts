import { expect, test } from "bun:test";
import { readSignedOut, saveSignedOut, signedOutOf } from "./sessions";

function bucket() {
  const objects = new Map<string, string>();
  return {
    objects,
    get: async (key: string) => {
      const text = objects.get(key);
      return text === undefined ? null : { body: new Response(text).body as ReadableStream };
    },
    put: async (key: string, body: ArrayBuffer | string) => {
      objects.set(key, String(body));
    },
  };
}

test("only accounts the composer knows are kept, each once, in its order", () => {
  expect(signedOutOf(["youtube-footage", "instagram", "instagram", "nope", 3])).toEqual([
    "instagram",
    "youtube-footage",
  ]);
  expect(signedOutOf("instagram")).toEqual([]);
  expect(signedOutOf(undefined)).toEqual([]);
});

test("what the laptop sends is kept in the media bucket and read back for the composer", async () => {
  const media = bucket();
  expect(await readSignedOut(media)).toEqual([]);
  expect(await saveSignedOut(media, { signedOut: ["tiktok", "instagram"] })).toEqual(["instagram", "tiktok"]);
  expect([...media.objects.keys()]).toEqual(["helper/sessions.json"]);
  expect(await readSignedOut(media)).toEqual(["instagram", "tiktok"]);
  // Signed in again, nothing is.
  expect(await saveSignedOut(media, { signedOut: [] })).toEqual([]);
  expect(await readSignedOut(media)).toEqual([]);
  expect(await saveSignedOut(media, null)).toEqual([]);
});

test("a copy that can't be read, or a bucket that fails, reads as nothing signed out", async () => {
  const media = bucket();
  media.objects.set("helper/sessions.json", "not json");
  expect(await readSignedOut(media)).toEqual([]);
  expect(
    await readSignedOut({
      get: async () => {
        throw new Error("R2 is down");
      },
    }),
  ).toEqual([]);
});
