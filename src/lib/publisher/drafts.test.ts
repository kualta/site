import { describe, expect, test } from "bun:test";
import { checkDraftText, DRAFT_LIFETIME, draftKey, listDrafts, readDraft, saveDraft, validateDraft } from "./drafts";

const text = () => ({
  title: "A film",
  caption: "About films",
  alt: "Titles over a dark stage",
  tags: ["film", "motion"],
  zh: { title: "短片", text: "一部短片。", topics: ["短片"] },
});
const video = "00000000-0000-4000-8000-000000000001";
function bucket(existing: string[] = [video]) {
  const objects = new Map<string, string>(existing.map((key) => [key, ""]));
  return {
    objects,
    head: async (key: string) => (objects.has(key) ? {} : null),
    put: async (key: string, body: ArrayBuffer | string) => objects.set(key, String(body)),
    get: async (key: string) => {
      const body = objects.get(key);
      return body === undefined ? null : { body: new Response(body).body as ReadableStream };
    },
    uploaded: new Map<string, Date>(),
    /** One object a page, so a listing has to follow the cursor. */
    async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const at = cursor ? keys.indexOf(cursor) + 1 : 0;
      const key = keys[at];
      const objects_ = key ? [{ key, uploaded: this.uploaded.get(key) ?? new Date(0) }] : [];
      return { objects: objects_, truncated: at + 1 < keys.length, cursor: key };
    },
  };
}

describe("drafts", () => {
  test("keep what the composer fills in and drop everything else", () => {
    const draft = validateDraft({ ...text(), video, preset: "short", visibility: "PUBLIC", platforms: ["bluesky"] });
    expect(draft).toEqual({ video, preset: "short", ...text() });
  });

  test("must publish as written on every video destination", () => {
    const long = "word ".repeat(70);
    expect(() => validateDraft({ ...text(), video, caption: long })).toThrow("Bluesky: text is 350/300");
    expect(validateDraft({ ...text(), video, caption: long, short: "Short enough" }).short).toBe("Short enough");
    expect(() => validateDraft({ ...text(), video, title: "" })).toThrow("Add a title");
    expect(() => validateDraft({ ...text(), video, title: "a <b> title" })).toThrow("YouTube");
    expect(() => validateDraft({ ...text(), video, zh: undefined })).toThrow("Chinese version");
    expect(() => validateDraft({ ...text(), video, zh: { ...text().zh, title: "很".repeat(21) } })).toThrow(
      "Xiaohongshu",
    );
  });

  test("reject a video that isn't a media id and a malformed preset", () => {
    expect(() => validateDraft({ ...text(), video: "../secret" })).toThrow("one video");
    expect(() => validateDraft(null)).toThrow();
    expect(() => validateDraft({ ...text(), video, preset: "../x" })).toThrow("Invalid preset");
  });

  test("text can be checked before the video is uploaded", () => {
    expect(() => checkDraftText(text())).not.toThrow();
    expect(() => checkDraftText({ ...text(), title: "" })).toThrow("Add a title");
  });

  test("are stored apart from media ids and read back", async () => {
    const store = bucket();
    const id = await saveDraft(store, { ...text(), video, preset: "short" });
    expect(store.objects.has(draftKey(id))).toBe(true);
    expect(store.objects.has(id)).toBe(false);
    expect(await readDraft(store, id)).toEqual({ id, video, preset: "short", ...text() });
    expect(await readDraft(store, crypto.randomUUID())).toBeNull();
  });

  test("need their video to have been uploaded", async () => {
    await expect(saveDraft(bucket([]), { ...text(), video })).rejects.toThrow("video is missing");
  });

  test("can carry a Chinese version, which must have been uploaded too", async () => {
    const chinese = "00000000-0000-4000-8000-000000000002";
    const draft = { ...text(), video, zh: { ...text().zh, video: chinese } };
    await expect(saveDraft(bucket([video]), draft)).rejects.toThrow("video is missing");
    const store = bucket([video, chinese]);
    const id = await saveDraft(store, draft);
    expect((await readDraft(store, id))?.zh?.video).toBe(chinese);
  });

  test("are listed newest first until they're posted, with when the bucket removes them", async () => {
    const chinese = "00000000-0000-4000-8000-000000000002";
    const posted = "00000000-0000-4000-8000-000000000004";
    const second = "00000000-0000-4000-8000-000000000005";
    const store = bucket([video, second, chinese, posted]);
    const older = await saveDraft(store, { ...text(), video });
    const newer = await saveDraft(store, { ...text(), video: second, zh: { ...text().zh, video: chinese } });
    const lost = await saveDraft(store, { ...text(), video: posted });
    store.uploaded.set(draftKey(older), new Date(1_000));
    store.uploaded.set(draftKey(newer), new Date(2_000));
    store.uploaded.set(draftKey(lost), new Date(3_000));
    const asked: string[][] = [];
    const drafts = await listDrafts(store, async (videos) => {
      asked.push(videos);
      return new Set([posted]);
    });
    expect(drafts.map((d) => d.id)).toEqual([newer, older]);
    expect(drafts[0]).toEqual({
      id: newer,
      title: "A film",
      caption: "About films",
      video: second,
      chinese: true,
      created: 2_000,
      expires: 2_000 + DRAFT_LIFETIME,
    });
    expect(drafts[1].chinese).toBe(false);
    expect(asked[0].sort()).toEqual([posted, second, video].sort());
    // Media ids aren't drafts, even though they share the bucket.
    expect(drafts.some((d) => d.id === video)).toBe(false);
  });

  test("can carry a cover, which must have been uploaded too, and a location", async () => {
    const cover = "00000000-0000-4000-8000-000000000003";
    const draft = { ...text(), video, cover, location: "Bogotá" };
    await expect(saveDraft(bucket([video]), draft)).rejects.toThrow("cover is missing");
    const store = bucket([video, cover]);
    const saved = await readDraft(store, await saveDraft(store, draft));
    expect(saved?.cover).toBe(cover);
    expect(saved?.location).toBe("Bogotá");
  });
});
