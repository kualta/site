import { expect, test } from "bun:test";
import { loadBlueskyProfile, parseBlueskyProfile } from "./profile";

const avatar = "https://cdn.bsky.app/img/avatar/plain/did:plc:jhvnnnd3adml7t6anu3ay7ip/bafkrei@jpeg";
const response = (body: unknown, status = 200) =>
  (async () => Response.json(body, { status })) as unknown as typeof fetch;

test("profiles keep the avatar and a trimmed bio", () => {
  expect(parseBlueskyProfile({ avatar, description: "  a servant of many \n", handle: "kualta.dev" })).toEqual({
    avatar,
    description: "a servant of many",
  });
});

test("avatars from anywhere but Bluesky's CDN are dropped", () => {
  expect(parseBlueskyProfile({ avatar: "https://evil.example/a.jpg" }).avatar).toBeUndefined();
  expect(parseBlueskyProfile({ avatar: "javascript:alert(1)" }).avatar).toBeUndefined();
  expect(parseBlueskyProfile({ description: "   " }).description).toBeUndefined();
  expect(parseBlueskyProfile(null)).toEqual({ avatar: undefined, description: undefined });
});

test("an unreachable AppView leaves the page without a profile", async () => {
  expect(await loadBlueskyProfile(response({ avatar, description: "bio" }))).toEqual({ avatar, description: "bio" });
  expect(await loadBlueskyProfile(response({}, 503))).toEqual({});
  const failing = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  expect(await loadBlueskyProfile(failing)).toEqual({});
});
