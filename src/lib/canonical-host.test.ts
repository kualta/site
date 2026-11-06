import { expect, test } from "bun:test";
import redirectWorker from "../redirect-worker";
import { canonicalRedirect } from "./canonical-host";

const target = (url: string) => canonicalRedirect(new URL(url));

test("alias hosts keep the path and query on kualta.dev", () => {
  expect(target("https://kualta.com/")).toBe("https://kualta.dev/");
  expect(target("https://kualta.com/links")).toBe("https://kualta.dev/links");
  expect(target("https://www.kualta.com/posts/fair-play?ref=ig")).toBe("https://kualta.dev/posts/fair-play?ref=ig");
  expect(target("https://www.kualta.dev/music")).toBe("https://kualta.dev/music");
  expect(target("https://KUALTA.com:8443/projects")).toBe("https://kualta.dev/projects");
});

test("one-page subdomains go to their page whatever the path", () => {
  expect(target("https://moji.kualta.dev/")).toBe("https://kualta.dev/kaomoji");
  expect(target("https://moji.kualta.dev/links")).toBe("https://kualta.dev/kaomoji");
  expect(target("https://join.kualta.dev/")).toBe("https://kualta.dev/join");
});

test("the canonical host and the publisher stay where they are", () => {
  expect(target("https://kualta.dev/links")).toBeNull();
  expect(target("https://post.kualta.dev/")).toBeNull();
});

test("the redirect worker answers with a permanent redirect browsers re-check daily", () => {
  const res = redirectWorker.fetch(new Request("https://kualta.com/links?from=bio"));
  expect(res.status).toBe(301);
  expect(res.headers.get("location")).toBe("https://kualta.dev/links?from=bio");
  expect(res.headers.get("cache-control")).toBe("max-age=86400");
  expect(redirectWorker.fetch(new Request("https://kualta.dev/")).status).toBe(421);
});
