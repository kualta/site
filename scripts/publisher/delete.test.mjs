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
  const result = await deletePublication(fixture("grain"), {
    oauth: {
      agent: async () => ({
        agent: {
          did: owner,
          com: { atproto: { repo: { applyWrites: async (data) => batches.push(data) } } },
        },
      }),
    },
  });
  expect(result.state).toBe("deleted");
  expect(batches).toHaveLength(1);
  expect(batches[0].writes).toHaveLength(5);
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
    deletionResponse(
      "twitter",
      url,
      "POST",
      { data: { delete_tweet: {} } },
      '{"tweet_id":"12345"}',
      "12345",
    ),
  ).toBe(true);
  expect(deletionResponse("twitter", url, "POST", { errors: [{}] }, "12345", "12345")).toBe(false);
  expect(
    deletionResponse("twitter", url, "GET", { data: { delete_tweet: {} } }, "12345", "12345"),
  ).toBe(false);
  expect(
    deletionResponse("twitter", url, "POST", { data: { delete_tweet: {} } }, "different", "12345"),
  ).toBe(false);
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
