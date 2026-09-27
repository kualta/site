import { describe, expect, it } from "bun:test";
import { safeReturnPath } from "./auth";
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
