import { describe, expect, it } from "bun:test";
import { normalizeBlueskyCallbackUrl, parseRememberedAccount, safeReturnPath } from "./auth";
import { BLUESKY_SCOPE, blueskyClientMetadata } from "./metadata";

describe("OAuth return paths", () => {
  it("keeps local paths, queries, and anchors", () => {
    expect(safeReturnPath("/posts/hello?from=feed#comments")).toBe("/posts/hello?from=feed#comments");
    expect(safeReturnPath("/posts/encoded%20name")).toBe("/posts/encoded%20name");
  });
  it("rejects external, control-character, and backslash destinations", () => {
    for (const path of [
      null,
      "",
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/\nevil.example",
      "/\t/evil.example",
      "/auth/bluesky",
      "/auth/bluesky/",
      "/auth/bluesky/?code=test#state=test",
    ]) {
      expect(safeReturnPath(path)).toBe("/");
    }
  });
  it("keeps encoded separators on the same origin", () => {
    for (const path of ["/%2f%2fevil.example", "/%5cevil.example", "/%0a/evil.example"]) {
      expect(new URL(safeReturnPath(path), "https://kualta.dev").origin).toBe("https://kualta.dev");
    }
  });
});

describe("OAuth metadata", () => {
  it("keeps metadata and callback on the serving origin", () => {
    const metadata = blueskyClientMetadata("https://preview.example");
    expect(metadata.client_id).toBe("https://preview.example/oauth-client-metadata.json");
    expect(metadata.redirect_uris).toEqual(["https://preview.example/auth/bluesky"]);
    expect(metadata.scope).toBe(BLUESKY_SCOPE);
    expect(metadata.token_endpoint_auth_method).toBe("none");
    expect(BLUESKY_SCOPE).not.toContain("transition:generic");
  });
});


describe("OAuth callback canonicalization", () => {
  it("preserves query and fragment responses while matching the registered callback", () => {
    for (const suffix of ["?code=test&state=opaque&iss=https%3A%2F%2Fbsky.social", "#code=test&state=opaque", "?error=access_denied&state=opaque"]) {
      const url = new URL(`https://kualta.dev/auth/bluesky/${suffix}`);
      const history = {
        state: { existing: true },
        replaceState: (state: unknown, _title: string, path?: string | URL | null) => {
          expect(state).toEqual({ existing: true });
          url.href = new URL(String(path), url).href;
        },
      };
      normalizeBlueskyCallbackUrl(url, history);
      expect(url.href).toBe(`https://kualta.dev/auth/bluesky${suffix}`);
      expect(url.pathname).toBe(new URL(blueskyClientMetadata(url.origin).redirect_uris[0]).pathname);
    }
  });
  it("leaves normal pages and the exact callback untouched", () => {
    for (const path of ["/posts/dream-letter/", "/auth/bluesky", "/"]) {
      normalizeBlueskyCallbackUrl(new URL(`https://kualta.dev${path}`), {
        state: null,
        replaceState: () => { throw new Error("Unexpected URL rewrite"); },
      });
    }
  });
});

describe("Remembered account", () => {
  it("restores only the public profile fields it needs", () => {
    const stored = JSON.stringify({
      profile: {
        did: "did:plc:example",
        handle: "kualta.dev",
        displayName: "kualta",
        avatar: "https://cdn.bsky.app/img/avatar.jpg",
        followersCount: 3,
      },
      canUploadMedia: true,
    });
    expect(parseRememberedAccount(stored)).toEqual({
      profile: {
        did: "did:plc:example",
        handle: "kualta.dev",
        displayName: "kualta",
        avatar: "https://cdn.bsky.app/img/avatar.jpg",
      },
      canUploadMedia: true,
    });
  });
  it("treats missing, malformed, or tampered storage as signed out", () => {
    for (const value of [
      null,
      "",
      "not json",
      "{}",
      JSON.stringify({ profile: { did: "plc:missing-prefix", handle: "kualta.dev" } }),
      JSON.stringify({ profile: { did: "did:plc:example" } }),
    ]) {
      expect(parseRememberedAccount(value)).toBeNull();
    }
  });
  it("drops avatars that are not https and media access that is not explicitly granted", () => {
    const stored = JSON.stringify({
      profile: { did: "did:plc:example", handle: "kualta.dev", avatar: "javascript:alert(1)" },
      canUploadMedia: "yes",
    });
    expect(parseRememberedAccount(stored)).toEqual({
      profile: { did: "did:plc:example", handle: "kualta.dev", displayName: undefined, avatar: undefined },
      canUploadMedia: false,
    });
  });
});
