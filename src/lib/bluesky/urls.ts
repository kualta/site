/** Bluesky routes expect literal colons in DID identifiers. */
export function blueskyProfileUrl(identifier: string): string {
  return `https://bsky.app/profile/${encodeURIComponent(identifier).replace(/%3A/gi, ":")}`;
}
