/** Bluesky routes expect literal colons in DID identifiers. */
export function blueskyProfileUrl(identifier: string): string {
  return `https://bsky.app/profile/${encodeURIComponent(identifier).replace(/%3A/gi, ":")}`;
}

export function parsePostUri(uri: string): { did: string; rkey: string } | undefined {
  const match =
    /^at:\/\/(did:(?:plc:[a-z2-7]{24}|web:[A-Za-z0-9._:%-]+))\/app\.bsky\.feed\.post\/([A-Za-z0-9._~:-]{1,512})$/.exec(
      uri,
    );
  if (!match || [".", ".."].includes(match[2])) return;
  return { did: match[1], rkey: match[2] };
}
export function sitePostPath(uri: string): string {
  const parts = parsePostUri(uri);
  if (!parts) throw new Error("Invalid Bluesky post identifier");
  return `/post/${encodeURIComponent(parts.did)}/${encodeURIComponent(parts.rkey)}`;
}
export function sitePostUrl(uri: string): string {
  return `https://kualta.dev${sitePostPath(uri)}`;
}
export function blueskyPostUrl(uri: string): string {
  const parts = parsePostUri(uri);
  if (!parts) throw new Error("Invalid Bluesky post identifier");
  return `${blueskyProfileUrl(parts.did)}/post/${encodeURIComponent(parts.rkey)}`;
}

export function postUriFromPath(pathname: string): string {
  const match = /^\/post\/([^/]+)\/([^/]+)(?:\/row)?\/?$/.exec(pathname);
  if (!match) return "";
  try {
    const uri = `at://${decodeURIComponent(match[1])}/app.bsky.feed.post/${decodeURIComponent(match[2])}`;
    return parsePostUri(uri) ? uri : "";
  } catch {
    return "";
  }
}
