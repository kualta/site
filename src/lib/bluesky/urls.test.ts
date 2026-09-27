import { expect, test } from "bun:test";
import { blueskyProfileUrl } from "./urls";

test("Bluesky profile URLs preserve DID colons", () => {
  expect(blueskyProfileUrl("did:plc:jhvnnnd3adml7t6anu3ay7ip")).toBe(
    "https://bsky.app/profile/did:plc:jhvnnnd3adml7t6anu3ay7ip",
  );
  expect(blueskyProfileUrl("kualta.dev")).toBe("https://bsky.app/profile/kualta.dev");
  expect(blueskyProfileUrl("did:web:example.com/path?query#fragment")).toBe(
    "https://bsky.app/profile/did:web:example.com%2Fpath%3Fquery%23fragment",
  );
});
