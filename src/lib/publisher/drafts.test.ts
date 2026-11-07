import { describe, expect, test } from "bun:test";
import {
  checkDraftText,
  DRAFT_LIFETIME,
  deleteDraft,
  draftKey,
  listDrafts,
  readDraft,
  saveComposerDraft,
  saveDraft,
  validateComposerDraft,
  validateDraft,
} from "./drafts";

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
    delete: async (keys: string | string[]) => {
      for (const key of [keys].flat()) objects.delete(key);
    },
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

  test("go with the uploads no job holds", async () => {
    const chinese = "00000000-0000-4000-8000-000000000002";
    const cover = "00000000-0000-4000-8000-000000000003";
    const store = bucket([video, chinese, cover]);
    const id = await saveDraft(store, { ...text(), video, cover, zh: { ...text().zh, video: chinese } });
    let offered: string[] = [];
    // A job already holds the cover, so only the two videos are released.
    await deleteDraft(store, id, async (uploads) => {
      offered = uploads;
      return uploads.filter((upload) => upload !== cover);
    });
    expect(offered.sort()).toEqual([chinese, cover, video].sort());
    expect([...store.objects.keys()]).toEqual([cover]);
    // One already gone is simply gone.
    await deleteDraft(store, id, async () => {
      throw new Error("nothing to release");
    });
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

describe("drafts saved from the composer", () => {
  const cover = "00000000-0000-4000-8000-000000000003";
  const newCover = "00000000-0000-4000-8000-000000000006";
  const edited = () => ({ ...text(), video, tagsText: "film motion half-typed", zhTopicsText: "短片" });

  test("keep half-written text that couldn't be published yet", async () => {
    const store = bucket();
    const draft = { ...edited(), title: "", caption: "word ".repeat(70), zh: { ...text().zh, title: "很".repeat(21) } };
    const { id } = await saveComposerDraft(store, draft, undefined, 5_000);
    expect(await readDraft(store, id)).toEqual({ id, ...draft, created: 5_000 });
  });

  test("still have to be shaped like a draft", () => {
    expect(() => validateComposerDraft({ ...edited(), video: "../secret" })).toThrow("can't be saved");
    expect(() => validateComposerDraft({ ...edited(), title: "t".repeat(101) })).toThrow("can't be saved");
    expect(() => validateComposerDraft({ ...edited(), cover: video })).toThrow("can't be saved");
    expect(() => validateComposerDraft({ ...edited(), zh: { ...text().zh, cover } })).toThrow("can't be saved");
    expect(validateComposerDraft({ ...edited(), coverAt: 2 })).not.toHaveProperty("coverAt");
    expect(validateComposerDraft({ ...edited(), cover, coverAt: 2 }).coverAt).toBe(2);
  });

  test("save over a draft from the terminal, keeping when its video went up, and let go of a replaced cover", async () => {
    const store = bucket([video, cover, newCover]);
    const id = await saveDraft(store, { ...text(), video, cover });
    const get = store.get;
    // The bucket says when the terminal's draft went up.
    store.get = async (key: string) => {
      const object = await get(key);
      return object && { ...object, uploaded: new Date(3_000) };
    };
    const saved = await saveComposerDraft(
      store,
      { ...edited(), caption: "Edited", cover: newCover, coverAt: 4.2 },
      id,
      9_000,
    );
    expect(saved).toEqual({ id, released: [cover] });
    const draft = await readDraft(store, id);
    expect(draft).toMatchObject({ caption: "Edited", cover: newCover, coverAt: 4.2, created: 3_000 });
    expect(draft?.tagsText).toBe("film motion half-typed");
  });

  test("count their week again once the video is replaced", async () => {
    const second = "00000000-0000-4000-8000-000000000005";
    const store = bucket([video, second]);
    const { id } = await saveComposerDraft(store, edited(), undefined, 1_000);
    expect(await saveComposerDraft(store, { ...edited(), video: second }, id, 7_000)).toEqual({
      id,
      released: [video],
    });
    expect((await readDraft(store, id))?.created).toBe(7_000);
  });

  test("need new uploads in the bucket and a draft that's still there", async () => {
    await expect(saveComposerDraft(bucket([]), edited())).rejects.toThrow("video is missing");
    const store = bucket();
    const { id } = await saveComposerDraft(store, edited());
    await expect(saveComposerDraft(store, { ...edited(), cover })).rejects.toThrow("cover is missing");
    await expect(saveComposerDraft(store, edited(), crypto.randomUUID())).rejects.toThrow("expired");
    expect(await readDraft(store, id)).not.toBeNull();
  });

  test("leave the list when their week is up, by the video's clock rather than the draft's", async () => {
    const store = bucket();
    const { id } = await saveComposerDraft(store, edited(), undefined, 1_000);
    store.uploaded.set(draftKey(id), new Date(1_000 + DRAFT_LIFETIME));
    const none = async () => new Set<string>();
    expect((await listDrafts(store, none, 2_000)).map((d) => [d.id, d.created])).toEqual([[id, 1_000]]);
    expect(await listDrafts(store, none, 1_000 + DRAFT_LIFETIME)).toEqual([]);
  });
});
