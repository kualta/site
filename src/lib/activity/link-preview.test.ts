import { describe, expect, test } from "bun:test";
import type { ActivityEvent, ActivityFetch, BlueskyActivity, LinkPreview } from "./types";
import { attachLinkPreviews, previewableLink, sanitizeLinkPreview } from "./link-preview";

const DID = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
const CID = "bafyreid3l3mpwbadpafmoajnc2ukaaf42cmnti6shcomrrqnqq4ctap5xy";
const TIME = "2026-08-30T12:00:00.000Z";
const VIDEO = "https://www.youtube.com/watch?v=nEX-9exMc1A";
const THUMB = "https://cardyb.bsky.app/v1/image?url=https%3A%2F%2Fi.ytimg.com%2Fvi%2FnEX-9exMc1A%2Fhqdefault.jpg";

function linkFacet(uri: string, byteStart: number) {
  return {
    index: { byteStart, byteEnd: byteStart + uri.length },
    features: [{ $type: "app.bsky.richtext.facet#link", uri }],
  };
}

function blueskyPost(rkey: string, facets?: unknown[], extra: Record<string, unknown> = {}): BlueskyActivity {
  const uri = `at://${DID}/app.bsky.feed.post/${rkey}`;
  return {
    id: `bluesky:post:${uri}:${TIME}`,
    source: "bluesky",
    action: "post",
    occurredAt: TIME,
    uri,
    url: `https://bsky.app/profile/${DID}/post/${rkey}`,
    text: VIDEO,
    author: { handle: "kualta.dev" },
    post: {
      uri,
      cid: CID,
      indexedAt: TIME,
      author: { did: DID, handle: "kualta.dev" },
      record: { $type: "app.bsky.feed.post", createdAt: TIME, text: VIDEO, ...(facets ? { facets } : {}) },
      ...extra,
    } as BlueskyActivity["post"],
  };
}

function cardService(handler: (link: string) => Response | Promise<Response>) {
  const asked: string[] = [];
  const fetch: ActivityFetch = async (input) => {
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe("https://cardyb.bsky.app/v1/extract");
    const link = url.searchParams.get("url") ?? "";
    asked.push(link);
    return handler(link);
  };
  return { asked, fetch };
}

const youtubeCard = () =>
  Response.json({
    error: "",
    likely_type: "video",
    url: VIDEO,
    title: "The Morning After I Killed Myself",
    description: "YouTube video by illneas",
    image: THUMB,
  });

function previewOf(event: ActivityEvent | undefined) {
  return event?.source === "bluesky" ? event.linkPreview : "not bluesky";
}

describe("previewableLink", () => {
  test("takes the first web link by position", () => {
    const post = blueskyPost("p", [linkFacet("https://later.example/", 40), linkFacet(VIDEO, 0)]).post;
    expect(previewableLink(post)).toBe(VIDEO);
  });

  test("leaves posts that already embed something, and links that are not web pages", () => {
    const embedded = blueskyPost("p", [linkFacet(VIDEO, 0)], {
      embed: { $type: "app.bsky.embed.images#view", images: [] },
    }).post;
    expect(previewableLink(embedded)).toBeUndefined();
    expect(previewableLink(blueskyPost("p", [linkFacet("javascript:alert(1)", 0)]).post)).toBeUndefined();
    expect(previewableLink(blueskyPost("p").post)).toBeUndefined();
  });
});

describe("sanitizeLinkPreview", () => {
  test("keeps only thumbnails the card service proxies", () => {
    expect(sanitizeLinkPreview({ uri: VIDEO, title: "t", description: "", thumb: THUMB })?.thumb).toBe(THUMB);
    expect(
      sanitizeLinkPreview({ uri: VIDEO, title: "t", description: "", thumb: "https://i.ytimg.com/x.jpg" }),
    ).toEqual({
      uri: VIDEO,
      title: "t",
      description: "",
    });
  });

  test("rejects cards with nothing to show or a link that is not a web page", () => {
    expect(sanitizeLinkPreview({ uri: VIDEO, title: " ", description: "" })).toBeUndefined();
    expect(sanitizeLinkPreview({ uri: "javascript:alert(1)", title: "t", description: "" })).toBeUndefined();
    expect(sanitizeLinkPreview(null)).toBeNull();
  });
});

describe("attachLinkPreviews", () => {
  test("gives a bare link the card Bluesky would draw for it", async () => {
    const service = cardService(youtubeCard);
    const [event] = await attachLinkPreviews([blueskyPost("p", [linkFacet(VIDEO, 0)])], [], service.fetch);

    expect(service.asked).toEqual([VIDEO]);
    expect(previewOf(event)).toEqual({
      uri: VIDEO,
      title: "The Morning After I Killed Myself",
      description: "YouTube video by illneas",
      thumb: THUMB,
    });
  });

  test("carries a known card or a known miss forward instead of asking again", async () => {
    const service = cardService(youtubeCard);
    const linkPreview: LinkPreview = { uri: VIDEO, title: "t", description: "" };
    const found = { ...blueskyPost("found", [linkFacet(VIDEO, 0)]), linkPreview };
    const missed = { ...blueskyPost("missed", [linkFacet(VIDEO, 0)]), linkPreview: null };

    const events = await attachLinkPreviews(
      [blueskyPost("found", [linkFacet(VIDEO, 0)]), blueskyPost("missed", [linkFacet(VIDEO, 0)])],
      [found, missed],
      service.fetch,
    );

    expect(service.asked).toEqual([]);
    expect(events.map(previewOf)).toEqual([found.linkPreview, null]);
  });

  test("remembers a page with no card, but retries when the service itself fails", async () => {
    const unreadable = await attachLinkPreviews(
      [blueskyPost("p", [linkFacet(VIDEO, 0)])],
      [],
      cardService(() => Response.json({ error: "Unable to generate link preview" }, { status: 400 })).fetch,
    );
    expect(previewOf(unreadable[0])).toBeNull();

    for (const failure of [
      () => new Response("busy", { status: 503 }),
      () => Promise.reject(new TypeError("network")),
      () => new Response("not json"),
    ]) {
      const [event] = await attachLinkPreviews(
        [blueskyPost("p", [linkFacet(VIDEO, 0)])],
        [],
        cardService(failure).fetch,
      );
      expect(event).not.toHaveProperty("linkPreview");
    }
  });

  test("a hung card service cannot hold the refresh past its budget", async () => {
    const start = performance.now();
    const [event] = await attachLinkPreviews(
      [blueskyPost("p", [linkFacet(VIDEO, 0)])],
      [],
      cardService(() => new Promise<Response>(() => {})).fetch,
      20,
    );
    expect(performance.now() - start).toBeLessThan(200);
    expect(event).not.toHaveProperty("linkPreview");
  });

  test("looks up a bounded number of cards per call", async () => {
    const service = cardService(youtubeCard);
    const events = Array.from({ length: 20 }, (_, index) =>
      blueskyPost(`p${index}`, [linkFacet(`${VIDEO}&t=${index}`, 0)]),
    );
    await attachLinkPreviews(events, [], service.fetch);
    expect(service.asked.length).toBe(8);
  });
});
