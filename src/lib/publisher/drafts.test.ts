import { describe, expect, test } from "bun:test";
import { checkDraftText, draftKey, readDraft, saveDraft, validateDraft } from "./drafts";

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
});
