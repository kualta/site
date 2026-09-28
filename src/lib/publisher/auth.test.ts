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

test("Flow login uses Worker-compatible fetch and refuses issuer redirects", async () => {
  const { handleSessionRequest } = await import("@flow-industries/id/server");
  const original = globalThis.fetch;
  const options = {
    audience: "http://127.0.0.1:4321",
    issuerUrl: "http://localhost:8063",
    apiUrl: "http://127.0.0.1:8060",
  };
  const request = () =>
    new Request(`${options.audience}/flow/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: options.audience },
      body: JSON.stringify({ action: "login", returnTo: "/publish" }),
    });
  let redirect = false;
  globalThis.fetch = Object.assign(
    async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return redirect
        ? new Response(null, { status: 307, headers: { Location: "https://unexpected.example" } })
        : Response.json({ transaction: "a".repeat(43) });
    },
    { preconnect: original.preconnect },
  );
  try {
    const success = await handleSessionRequest(request(), options);
    expect(success.status).toBe(200);
    expect((await success.json()).authorizeUrl).toStartWith(`${options.issuerUrl}/authorize?`);
    expect(success.headers.get("Set-Cookie")).toContain("HttpOnly");
    redirect = true;
    const refused = await handleSessionRequest(request(), options);
    expect(refused.status).toBe(502);
    expect((await refused.json()).error).toBe("login_unavailable");
  } finally {
    globalThis.fetch = original;
  }
});
