import { expect, test } from "bun:test";
import { isOwner, publisherSameOrigin } from "./auth";
test("only the verified, non-guest kualta user is an owner", () => {
  expect(isOwner({ username: "kualta" })).toBe(true);
  expect(isOwner({ username: "kualta", isGuest: true })).toBe(false);
  expect(isOwner({ username: "someone-else" })).toBe(false);
  expect(isOwner(undefined)).toBe(false);
});
test("publisher writes require an explicit same-origin request", () => {
  expect(
    publisherSameOrigin(
      new Request("https://kualta.dev/api/publisher/jobs", { headers: { Origin: "https://evil.example" } }),
    ),
  ).toBe(false);
  expect(publisherSameOrigin(new Request("https://kualta.dev/api/publisher/jobs"))).toBe(false);
  expect(
    publisherSameOrigin(
      new Request("https://kualta.dev/api/publisher/jobs", { headers: { Origin: "https://kualta.dev" } }),
    ),
  ).toBe(true);
});
