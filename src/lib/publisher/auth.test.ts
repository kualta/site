import { expect, test } from "bun:test";
import { flowOptions, isOwner, publisherSameOrigin } from "./auth";
test("local preview uses local Auth while production pins the trusted issuer and audience", () => {
  expect(flowOptions(new URL("http://127.0.0.1:4321/publish"), true)).toEqual({
    audience: "http://127.0.0.1:4321",
    issuerUrl: "http://localhost:8063",
    apiUrl: "http://127.0.0.1:8060",
  });
  expect(flowOptions(new URL("http://127.0.0.1:4321/publish"), false)).toEqual({
    audience: "https://post.kualta.dev",
    issuerUrl: "https://id.flow.industries",
  });
});
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
