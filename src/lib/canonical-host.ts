export const CANONICAL_HOST = "kualta.dev";

// Hosts that redirect to the canonical apex while preserving the request path.
const aliasHosts = new Set(["www.kualta.dev", "kualta.com", "www.kualta.com"]);

// Subdomains that map to a specific path on the canonical host. Permanent:
// they have no content of their own and never will, so the destination is
// the one that should hold the ranking.
const subdomainPaths: Record<string, string> = {
  moji: "/kaomoji",
  blog: "/posts",
  join: "/join",
};

// Browsers keep a 301 without an expiry indefinitely. A day's limit means that
// if the primary domain ever changes, returning visitors re-check within a day
// instead of looping between a cached redirect and the new one.
const REDIRECT_MAX_AGE_SECONDS = 60 * 60 * 24;

/** A permanent redirect that browsers re-check after a day. */
export function permanentRedirect(target: string): Response {
  return new Response(null, {
    status: 301,
    headers: { Location: target, "Cache-Control": `max-age=${REDIRECT_MAX_AGE_SECONDS}` },
  });
}

/** Where a request belongs on the canonical host, or null when it is already there. */
export function canonicalRedirect(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (aliasHosts.has(host)) return `https://${CANONICAL_HOST}${url.pathname}${url.search}`;
  for (const [subdomain, path] of Object.entries(subdomainPaths)) {
    if (host.startsWith(`${subdomain}.`)) return `https://${CANONICAL_HOST}${path}`;
  }
  return null;
}
