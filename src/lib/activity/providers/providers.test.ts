import { describe, expect, test } from "bun:test";
import type { ActivityEvent, ProviderContext } from "../types";
import { normalizeBlueskyFeed } from "./bluesky";
import { githubProvider, normalizeGitHubEvents } from "./github";

const EVENT_TIME = "2026-08-30T12:00:00Z";
const BLUESKY_DID = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
const BLUESKY_CID = "bafyreid3l3mpwbadpafmoajnc2ukaaf42cmnti6shcomrrqnqq4ctap5xy";

function blueskyPost(rkey: string, text: string, indexedAt: string, extra: Record<string, unknown> = {}) {
  return {
    uri: `at://${BLUESKY_DID}/app.bsky.feed.post/${rkey}`,
    cid: BLUESKY_CID,
    indexedAt,
    author: {
      did: BLUESKY_DID,
      handle: "kualta.dev",
      displayName: "ku",
    },
    record: {
      $type: "app.bsky.feed.post",
      createdAt: indexedAt,
      text,
    },
    ...extra,
  };
}

function githubEvent(type: string, id: string, payload: object = {}, isPublic = true) {
  return {
    id,
    type,
    public: isPublic,
    created_at: EVENT_TIME,
    repo: {
      name: "kualta/site",
      url: "https://api.github.com/repos/kualta/site",
    },
    payload,
  };
}

async function expectRejection(promise: Promise<unknown>, message: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

describe("GitHub normalization", () => {
  test("accepts every event family without requiring provider-specific rendering", async () => {
    const eventTypes = [
      "CommitCommentEvent",
      "CreateEvent",
      "DeleteEvent",
      "DiscussionEvent",
      "ForkEvent",
      "GollumEvent",
      "IssueCommentEvent",
      "IssuesEvent",
      "MemberEvent",
      "PublicEvent",
      "PullRequestEvent",
      "PullRequestReviewEvent",
      "PullRequestReviewCommentEvent",
      "PushEvent",
      "ReleaseEvent",
      "WatchEvent",
    ];
    const events = await normalizeGitHubEvents(eventTypes.map((type, index) => githubEvent(type, String(index + 1))));

    expect(
      events.map((event) => (event.source === "github" && event.kind === "event" ? event.eventType : null)),
    ).toEqual(eventTypes);
  });

  test("discards all private metadata before returning an event", async () => {
    const privateEvent = githubEvent(
      "PullRequestEvent",
      "raw-private-event-id",
      {
        action: "merged",
        ref: "refs/heads/secret-launch",
        pull_request: {
          title: "Secret project title",
          html_url: "https://github.com/secret-org/secret-repo/pull/7",
        },
      },
      false,
    );
    privateEvent.repo.name = "secret-org/secret-repo";

    const [event] = await normalizeGitHubEvents([privateEvent]);
    const serialized = JSON.stringify(event);

    expect(event).toMatchObject({
      source: "github",
      visibility: "private",
      eventType: "PullRequestEvent",
      action: "merged",
    });
    expect(event.id).not.toContain("raw-private-event-id");
    expect(serialized).not.toContain("secret-org");
    expect(serialized).not.toContain("secret-repo");
    expect(serialized).not.toContain("Secret project title");
    expect(serialized).not.toContain("secret-launch");
    expect(serialized).not.toContain("raw-private-event-id");
  });

  test("retains whitelisted public links and drops unsafe links", async () => {
    const [safe, unsafe] = await normalizeGitHubEvents([
      githubEvent("PushEvent", "1", { head: "a".repeat(40) }),
      githubEvent("IssuesEvent", "2", {
        action: "opened",
        issue: { title: "Public issue", html_url: "https://example.com/not-github" },
      }),
    ]);

    const publicEvent = (event: ActivityEvent) =>
      event.source === "github" && event.kind === "event" && event.visibility === "public" ? event : undefined;

    expect(publicEvent(safe)).toBeDefined();
    expect(publicEvent(safe)?.target?.url).toBe(`https://github.com/kualta/site/commit/${"a".repeat(40)}`);
    expect(publicEvent(unsafe)?.target).toBeUndefined();
  });

  test("fails closed when the token belongs to another account", async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ login: "someone-else" }), {
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const context: ProviderContext = {
      fetch: fetchMock,
      signal: new AbortController().signal,
      now: new Date("2026-08-30T12:00:00.000Z"),
      secrets: { githubToken: "test-token" },
    };

    await expectRejection(githubProvider.fetch(context), "wrong account");
  });

  test("fails closed when the token is missing", async () => {
    const context: ProviderContext = {
      fetch: (() => {
        throw new Error("fetch should not run");
      }) as unknown as typeof fetch,
      signal: new AbortController().signal,
      now: new Date("2026-08-30T12:00:00.000Z"),
      secrets: {},
    };

    await expectRejection(githubProvider.fetch(context), "token is missing");
  });

  test("rejects malformed events instead of inferring inactivity", async () => {
    await expectRejection(normalizeGitHubEvents([githubEvent("PushEvent", "1"), {}]), "malformed event");
  });
});

describe("Bluesky normalization", () => {
  test("uses network timestamps for posts, quotes, and reposts, and drops replies", () => {
    const quotedUri = `at://${BLUESKY_DID}/app.bsky.feed.post/quoted`;
    const quoteEmbed = {
      $type: "app.bsky.embed.record#view",
      record: {
        $type: "app.bsky.embed.record#viewRecord",
        uri: quotedUri,
        cid: BLUESKY_CID,
        indexedAt: "2026-08-29T10:00:00Z",
        author: {
          did: BLUESKY_DID,
          handle: "kualta.dev",
          displayName: "ku",
        },
        value: {
          $type: "app.bsky.feed.post",
          createdAt: "2026-08-29T10:00:00Z",
          text: "quoted post",
        },
      },
    };
    const feed = normalizeBlueskyFeed({
      feed: [
        {
          post: blueskyPost("post1", "post", "2026-08-30T12:00:00Z"),
        },
        {
          post: blueskyPost("reply1", "reply", "2026-08-30T11:00:00Z", {
            record: {
              $type: "app.bsky.feed.post",
              createdAt: "2026-08-30T11:00:00Z",
              text: "reply",
              reply: {
                parent: { uri: quotedUri, cid: BLUESKY_CID },
                root: { uri: quotedUri, cid: BLUESKY_CID },
              },
            },
          }),
        },
        {
          post: blueskyPost("quote1", "quote", "2026-08-30T10:30:00Z", {
            record: {
              $type: "app.bsky.feed.post",
              createdAt: "2026-08-30T10:30:00Z",
              text: "quote",
              embed: {
                $type: "app.bsky.embed.record",
                record: { uri: quotedUri, cid: BLUESKY_CID },
              },
            },
            embed: quoteEmbed,
          }),
        },
        {
          reason: {
            $type: "app.bsky.feed.defs#reasonRepost",
            indexedAt: "2026-08-30T10:00:00Z",
          },
          post: blueskyPost("original", "original post", "2026-07-01T00:00:00Z"),
        },
      ],
    });

    // the reply is dropped: it reads as a fragment of someone else's thread
    expect(feed.map(({ action }) => action)).toEqual(["post", "post", "repost"]);
    expect(feed.map(({ occurredAt }) => occurredAt)).toEqual([
      "2026-08-30T12:00:00.000Z",
      "2026-08-30T10:30:00.000Z",
      "2026-08-30T10:00:00.000Z",
    ]);
    expect(feed[1].post.embed?.$type).toBe("app.bsky.embed.record#view");
    expect(feed[2].url).toBe(`https://bsky.app/profile/${BLUESKY_DID}/post/original`);
  });

  test("rejects malformed author feeds", () => {
    expect(() => normalizeBlueskyFeed({ feed: "not-an-array" })).toThrow("invalid author feed");
  });

  test("rejects malformed feed items instead of inferring inactivity", () => {
    expect(() => normalizeBlueskyFeed({ feed: [{}] })).toThrow("malformed feed item");
  });
});
