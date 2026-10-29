import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishStory, readAccount, refreshAccount, saveAccount } from "./instagram-story.mjs";

async function withState(run) {
  const stateDir = await mkdtemp(join(tmpdir(), "story-test-"));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}
/** Answers Graph API calls in order and records them. */
function graph(replies) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? Object.fromEntries(init.body) : null });
    const reply = replies.shift();
    return Response.json(reply, { status: reply.error ? 400 : 200 });
  };
  return { calls, fetcher };
}

test("only Business accounts are kept for stories", async () => {
  await withState(async (stateDir) => {
    const creator = graph([{ user_id: "1", username: "kualta", account_type: "MEDIA_CREATOR" }]);
    await expect(saveAccount(stateDir, "token", { fetcher: creator.fetcher })).rejects.toThrow("Business");
    expect(await readAccount(stateDir)).toBeNull();
    const business = graph([{ user_id: "17841", username: "kualta", account_type: "BUSINESS" }]);
    await saveAccount(stateDir, "token", { fetcher: business.fetcher, now: 1 });
    expect(await readAccount(stateDir)).toEqual({ token: "token", userId: "17841", username: "kualta", refreshedAt: 1 });
  });
});
test("tokens are refreshed once they are a week old", async () => {
  await withState(async (stateDir) => {
    await saveAccount(stateDir, "old", { fetcher: graph([{ user_id: "1", username: "k", account_type: "Business" }]).fetcher, now: 0 });
    const early = graph([]);
    expect((await refreshAccount(stateDir, { fetcher: early.fetcher, now: 86_400_000 })).token).toBe("old");
    expect(early.calls).toHaveLength(0);
    const due = graph([{ access_token: "new", expires_in: 5_184_000 }]);
    expect((await refreshAccount(stateDir, { fetcher: due.fetcher, now: 8 * 86_400_000 })).token).toBe("new");
    expect(due.calls[0].url).toContain("grant_type=ig_refresh_token");
    expect((await readAccount(stateDir)).token).toBe("new");
  });
});
test("each file is parked, processed, published as a story, then removed", async () => {
  await withState(async (stateDir) => {
    await saveAccount(stateDir, "token", {
      fetcher: graph([{ user_id: "17841", username: "kualta", account_type: "Business" }]).fetcher,
    });
    const parked = [];
    const removed = [];
    const park = async (file, type) => {
      parked.push({ file, type });
      return { url: `https://post.example/public/${parked.length}`, remove: async () => removed.push(file) };
    };
    const { calls, fetcher } = graph([
      { id: "c1" },
      { status_code: "IN_PROGRESS" },
      { status_code: "FINISHED" },
      { id: "m1" },
      { id: "c2" },
      { status_code: "FINISHED" },
      { id: "m2" },
      { permalink: "https://www.instagram.com/stories/kualta/123/" },
    ]);
    const result = await publishStory(
      ["/a.jpg", "/b.jpg"],
      [
        { kind: "photo", contentType: "image/jpeg" },
        { kind: "photo", contentType: "image/jpeg" },
      ],
      { stateDir, park, fetcher, wait: async () => {} },
    );
    expect(result.url).toBe("https://www.instagram.com/stories/kualta/123/");
    expect(parked.map((p) => p.file)).toEqual(["/a.jpg", "/b.jpg"]);
    expect(removed).toEqual(["/a.jpg", "/b.jpg"]);
    expect(calls[0].url).toBe("https://graph.instagram.com/v26.0/17841/media");
    expect(calls[0].body).toEqual({ media_type: "STORIES", image_url: "https://post.example/public/1" });
    expect(calls[3].body).toEqual({ creation_id: "c1" });
  });
});
test("a story Instagram can't process is an error, and its media is still removed", async () => {
  await withState(async (stateDir) => {
    await saveAccount(stateDir, "token", {
      fetcher: graph([{ user_id: "1", username: "kualta", account_type: "Business" }]).fetcher,
    });
    let removed = false;
    const park = async () => ({ url: "https://post.example/public/1", remove: async () => (removed = true) });
    const { calls, fetcher } = graph([{ id: "c1" }, { status_code: "ERROR", status: "Video too short" }]);
    await expect(
      publishStory(["/clip.mp4"], [{ kind: "video", contentType: "video/mp4" }], { stateDir, park, fetcher }),
    ).rejects.toThrow("Video too short");
    expect(calls[0].body.video_url).toBe("https://post.example/public/1");
    expect(removed).toBe(true);
  });
});
