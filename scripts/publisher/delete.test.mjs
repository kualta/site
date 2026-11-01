import { expect, test } from "bun:test";
import { deletePublication, deletionDestination, deletionResponse } from "./delete.mjs";
import { recordKey } from "../lib/atproto-content.mjs";
const owner = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
const post = { id: "fixture", media: ["one", "two"] };
function fixture(platform) {
  const key = recordKey(`publisher:${platform}:${post.id}`);
  return {
    post,
    target: {
      platform,
      state: "succeeded",
      url:
        platform === "grain"
          ? `https://grain.social/profile/${owner}/gallery/${key}`
          : `https://bsky.app/profile/${owner}/post/${key}`,
    },
  };
}
test("Grain deletion atomically removes only this job's gallery, photos and links", async () => {
  const batches = [];
  const result = await deletePublication(
    { ...fixture("grain"), post: { ...post, datesTaken: ["2020-07-18T06:30:10.000Z", null] } },
    {
      oauth: {
        agent: async () => ({
          agent: {
            did: owner,
            com: { atproto: { repo: { applyWrites: async (data) => batches.push(data) } } },
          },
        }),
      },
    },
  );
  expect(result.state).toBe("deleted");
  expect(batches).toHaveLength(1);
  expect(batches[0].writes).toHaveLength(6);
  expect(batches[0].writes.filter((w) => w.collection === "social.grain.photo.exif")).toEqual([
    {
      $type: "com.atproto.repo.applyWrites#delete",
      collection: "social.grain.photo.exif",
      rkey: recordKey("publisher:grain:fixture:0"),
    },
  ]);
  expect(batches[0].writes.every((w) => w.$type.endsWith("#delete"))).toBe(true);
  expect(batches[0].writes[1].rkey).toBe(recordKey("publisher:grain:fixture:0"));
});
test("Bluesky deletion uses the exact published record and does not retry failures", async () => {
  let calls = 0;
  const result = await deletePublication(fixture("bluesky"), {
    oauth: {
      agent: async () => ({
        agent: {
          did: owner,
          com: {
            atproto: {
              repo: {
                deleteRecord: async (args) => {
                  calls++;
                  expect(args.rkey).toBe(recordKey("publisher:bluesky:fixture"));
                  throw Error("Network lost");
                },
              },
            },
          },
        },
      }),
    },
  });
  expect(result.state).toBe("uncertain");
  expect(calls).toBe(1);
});
test("wrong URLs and account identities cannot trigger deletion", async () => {
  let called = false;
  const request = fixture("bluesky");
  request.target.url += "other";
  expect(
    (
      await deletePublication(request, {
        oauth: {
          agent: async () => {
            called = true;
          },
        },
      })
    ).state,
  ).toBe("failed");
  expect(called).toBe(false);
  expect(
    (
      await deletePublication(fixture("grain"), {
        oauth: { agent: async () => ({ agent: { did: "other" } }) },
      })
    ).state,
  ).toBe("failed");
  for (const url of [
    "http://x.com/me/status/12345",
    "https://x.com.evil/me/status/12345",
    "https://x.com/home",
    "https://user@x.com/me/status/12345",
  ])
    expect(() => deletionDestination("twitter", url, post)).toThrow();
});
test("browser deletion receipts require platform success, not just an HTTP response", () => {
  const url = "https://x.com/i/api/graphql/hash/DeleteTweet";
  expect(
    deletionResponse("twitter", url, "POST", { data: { delete_tweet: {} } }, '{"tweet_id":"12345"}', "12345"),
  ).toBe(true);
  expect(deletionResponse("twitter", url, "POST", { errors: [{}] }, "12345", "12345")).toBe(false);
  expect(deletionResponse("twitter", url, "GET", { data: { delete_tweet: {} } }, "12345", "12345")).toBe(false);
  expect(deletionResponse("twitter", url, "POST", { data: { delete_tweet: {} } }, "different", "12345")).toBe(false);
  expect(
    deletionResponse(
      "instagram",
      "https://www.instagram.com/api/v1/web/create/12345/delete/",
      "POST",
      { status: "ok" },
      "",
      "shortcode",
    ),
  ).toBe(true);
  expect(
    deletionResponse(
      "tiktok",
      "https://www.tiktok.com/api/item/delete/?item_id=12345",
      "POST",
      { status_code: 0 },
      "",
      "12345",
    ),
  ).toBe(true);
  expect(
    deletionResponse(
      "xiaohongshu",
      "https://creator.xiaohongshu.com/api/note/delete",
      "POST",
      { code: 0 },
      "12345",
      "12345",
    ),
  ).toBe(true);
  expect(
    deletionResponse(
      "xiaohongshu",
      "https://creator.rednote.com/api/note/delete",
      "POST",
      { code: 0 },
      "12345",
      "12345",
    ),
  ).toBe(true);
  expect(
    deletionResponse(
      "youtube",
      "https://studio.youtube.com/youtubei/v1/video_manager/delete_video",
      "POST",
      {},
      "12345",
      "12345",
    ),
  ).toBe(false);
});

test("browser deletion confirms the exact post and closes its profile", async () => {
  let closed = false,
    visited,
    confirmed = false;
  const locator = {
    filter: () => locator,
    getByTestId: () => locator,
    getByRole: () => locator,
    waitFor: async () => {},
    click: async () => {
      confirmed = true;
    },
  };
  const response = {
    ok: () => true,
    url: () => "https://x.com/i/api/graphql/hash/DeleteTweet",
    json: async () => ({ data: { delete_tweet: {} } }),
    request: () => ({ method: () => "POST", postData: () => '{"tweet_id":"12345"}' }),
  };
  const page = {
    setDefaultTimeout() {},
    goto: async (url) => {
      visited = url;
    },
    locator: () => locator,
    getByRole: () => locator,
    on() {},
    waitForResponse: async (predicate) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(await predicate(response)).toBe(true);
      return response;
    },
  };
  const result = await deletePublication(
    {
      post,
      target: { platform: "twitter", state: "succeeded", url: "https://x.com/kualta/status/12345" },
    },
    {
      stateDir: "/unused",
      open: async () => ({
        pages: () => [page],
        close: async () => {
          closed = true;
        },
      }),
    },
  );
  expect(visited).toBe("https://x.com/kualta/status/12345");
  expect(confirmed).toBe(true);
  expect(closed).toBe(true);
  expect(result.state).toBe("deleted");
});
test("RedNote note links are Xiaohongshu publications", () => {
  const post = { id: crypto.randomUUID() };
  expect(deletionDestination("xiaohongshu", "https://www.rednote.com/explore/65f1a2b3c4d5e6f7a8b9c0d1", post)).toEqual({
    id: "65f1a2b3c4d5e6f7a8b9c0d1",
    url: "https://www.rednote.com/explore/65f1a2b3c4d5e6f7a8b9c0d1",
  });
  expect(() => deletionDestination("xiaohongshu", "https://www.rednote.example/explore/65f1a2b3", post)).toThrow(
    "Unexpected publication host",
  );
});
test("YouTube Shorts links identify their video", () => {
  expect(deletionDestination("youtube", "https://www.youtube.com/shorts/abcdefghijk", { id: "fixture" })).toEqual({
    id: "abcdefghijk",
    url: "https://studio.youtube.com/video/abcdefghijk/edit",
  });
});

function browserPage({ goneAfter = Number.POSITIVE_INFINITY, reply = true } = {}) {
  const clicks = [];
  let checks = 0;
  const locator = {
    filter: () => locator,
    getByTestId: () => locator,
    getByRole: () => locator,
    first: () => locator,
    waitFor: async () => {},
    click: async () => clicks.push("click"),
  };
  const page = {
    setDefaultTimeout() {},
    goto: async () => {},
    locator: () => locator,
    getByRole: () => locator,
    // Each check of the post's page reads its text; it says "gone" from the given check on.
    getByText: () => ({
      first: () => ({
        waitFor: async () => {
          if (++checks < goneAfter) throw new Error("still there");
        },
      }),
    }),
    on() {},
    waitForResponse: async () => {
      if (!reply) throw new Error("timeout");
    },
  };
  return { page, clicks };
}
const twitterTarget = { platform: "twitter", state: "succeeded", url: "https://x.com/kualta/status/12345" };
const opened = (page) => async () => ({ pages: () => [page], close: async () => {} });

test("a post already gone from the platform is marked deleted without touching it", async () => {
  const { page, clicks } = browserPage({ goneAfter: 1 });
  const result = await deletePublication({ post, target: twitterTarget }, { stateDir: "/unused", open: opened(page) });
  expect(result).toEqual({ state: "deleted", message: "Already removed from the platform" });
  expect(clicks).toEqual([]);
});

test("without a recognised reply, the post's own page confirms the deletion", async () => {
  const { page } = browserPage({ goneAfter: 2, reply: false });
  const result = await deletePublication({ post, target: twitterTarget }, { stateDir: "/unused", open: opened(page) });
  expect(result).toEqual({ state: "deleted", message: "Removed: the post's page no longer exists" });
});

test("an unconfirmed deletion whose post is still up stays uncertain", async () => {
  const { page } = browserPage({ reply: false });
  const result = await deletePublication({ post, target: twitterTarget }, { stateDir: "/unused", open: opened(page) });
  expect(result.state).toBe("uncertain");
});

function rednotePage({ present = true } = {}) {
  const visited = [];
  const clicks = [];
  const control = (name) => ({
    click: async () => clicks.push(name),
    hover: async () => {},
    filter: () => control(name),
    last: () => control(name),
  });
  const card = { first: () => card, count: async () => (present ? 1 : 0), hover: async () => {}, locator: control };
  const cards = { first: () => ({ waitFor: async () => {} }), count: async () => 3 };
  const page = {
    on() {},
    off() {},
    setDefaultTimeout() {},
    goto: async (url) => visited.push(url),
    locator: (selector) => {
      if (selector === "div.note-card") return cards;
      if (selector.startsWith("div.note-card[")) return card;
      return control(selector);
    },
    mouse: { wheel: async () => {} },
    waitForTimeout: async () => {},
    waitForResponse: async (predicate) => {
      const response = {
        ok: () => true,
        url: () => "https://webapi.rednote.com/web_api/sns/capa/postgw/note/delete",
        json: async () => ({ code: 0, success: true }),
        request: () => ({ method: () => "POST", postData: () => '{"note_id":"6ae261940000000013033800"}' }),
      };
      if (!(await predicate(response))) throw new Error("not the receipt");
      return response;
    },
  };
  return { page, visited, clicks };
}
const rednoteTarget = {
  platform: "xiaohongshu",
  state: "succeeded",
  url: "https://www.rednote.com/explore/6ae261940000000013033800",
};

test("Xiaohongshu notes are deleted from the creator center, never their public page", async () => {
  const { page, visited, clicks } = rednotePage();
  const result = await deletePublication({ post, target: rednoteTarget }, { stateDir: "/unused", open: opened(page) });
  expect(result).toEqual({ state: "deleted", message: "Platform confirmed deletion" });
  expect(visited).toEqual(["https://creator.rednote.com/new/note-manager"]);
  expect(clicks[0]).toBe(".note-card__action-btn--del");
  expect(clicks).toHaveLength(2);
});

test("a note missing from the fully loaded note manager is already removed", async () => {
  const { page, clicks } = rednotePage({ present: false });
  const result = await deletePublication({ post, target: rednoteTarget }, { stateDir: "/unused", open: opened(page) });
  expect(result).toEqual({ state: "deleted", message: "Already removed from the platform" });
  expect(clicks).toEqual([]);
});
const FULL = "0xb379b21f150211f01be6796ad87879d3a9b74579";
test("Farcaster and Lens links identify their posts, however they were written", () => {
  for (const link of [
    `https://farcaster.xyz/~/conversations/${FULL}`,
    `https://farcaster.xyz/kualta.eth/${FULL}`,
    `https://warpcast.com/kualta.eth/${FULL}`,
  ])
    expect(deletionDestination("farcaster", link, post).id).toBe(FULL);
  expect(deletionDestination("farcaster", "https://farcaster.xyz/kualta.eth/0xb379b21f", post).id).toBe("0xb379b21f");
  expect(deletionDestination("lens", "https://hey.xyz/posts/zhz5az596s29qzvqca", post).id).toBe("zhz5az596s29qzvqca");
});
test("anything else isn't taken for a post", () => {
  expect(() => deletionDestination("farcaster", "https://evil.example/kualta.eth/0xb379b21f", post)).toThrow("host");
  expect(() => deletionDestination("farcaster", "https://farcaster.xyz/kualta.eth", post)).toThrow("identify");
  expect(() => deletionDestination("farcaster", "https://farcaster.xyz/kualta.eth/notahash", post)).toThrow("identify");
  expect(() => deletionDestination("lens", "https://hey.xyz/u/kualta", post)).toThrow("identify");
  expect(() => deletionDestination("lens", "https://evil.example/posts/abc123", post)).toThrow("host");
});
test.each([
  ["farcaster", `https://farcaster.xyz/~/conversations/${FULL}`, FULL],
  ["lens", "https://hey.xyz/posts/abc123", "abc123"],
])("%s deletes through its adapter, without opening a browser", async (platform, url, id) => {
  const calls = [];
  const remove = async (...args) => {
    calls.push(args);
    return { state: "deleted", message: "Deleted" };
  };
  const result = await deletePublication(
    { post, target: { platform, state: "succeeded", url } },
    {
      stateDir: "/state",
      farcaster: remove,
      lens: remove,
      open: async () => {
        throw new Error("must not open a browser");
      },
    },
  );
  expect(result).toEqual({ state: "deleted", message: "Deleted" });
  expect(calls[0]).toEqual([id, { stateDir: "/state", publication: post.id }]);
});
test("a refused deletion says why; an unclear one asks to check", async () => {
  const run = (error) =>
    deletePublication(
      { post, target: { platform: "lens", state: "succeeded", url: "https://hey.xyz/posts/abc123" } },
      {
        stateDir: "/state",
        lens: async () => {
          throw error;
        },
      },
    );
  expect(await run(Object.assign(new Error("Connect Lens again."), { rejected: true }))).toEqual({
    state: "failed",
    message: "Connect Lens again.",
  });
  expect((await run(new Error("socket hang up"))).state).toBe("uncertain");
});
