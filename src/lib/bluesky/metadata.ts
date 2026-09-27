import type { BrowserOAuthClientOptions } from "@atproto/oauth-client-browser";

export const BLUESKY_SCOPE = [
  "atproto",
  "repo:app.bsky.feed.like?action=create&action=delete",
  "repo:app.bsky.feed.repost?action=create&action=delete",
  "repo:app.bsky.feed.post?action=create&action=delete",
  ...[
    "app.bsky.actor.getProfile",
    "app.bsky.feed.getPosts",
    "app.bsky.feed.getPostThread",
    "app.bsky.feed.searchPosts",
  ].map((method) => `rpc:${method}?aud=did:web:api.bsky.app%23bsky_appview`),
].join(" ");

export function blueskyClientMetadata(origin: string): NonNullable<BrowserOAuthClientOptions["clientMetadata"]> {
  return {
    client_id: `${origin}/oauth-client-metadata.json`,
    client_name: "kualta.dev",
    client_uri: origin,
    redirect_uris: [`${origin}/auth/bluesky`],
    scope: BLUESKY_SCOPE,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
    dpop_bound_access_tokens: true,
  };
}
