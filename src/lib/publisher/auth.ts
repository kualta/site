import { resolveSession } from "@flow-industries/id/server";

export function flowOptions(url: URL) {
  // The audience is pinned in production; request headers cannot choose it.
  const audience =
    import.meta.env.DEV && ["localhost", "127.0.0.1"].includes(url.hostname) ? url.origin : "https://post.kualta.dev";
  return { audience, issuerUrl: "https://id.flow.industries" };
}
export function isOwner(user: { username: string; isGuest?: boolean } | null | undefined): boolean {
  return Boolean(user && !user.isGuest && user.username === "kualta");
}
export async function publisherSession(request: Request) {
  const session = await resolveSession(request.headers.get("cookie"), flowOptions(new URL(request.url)));
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const cookie of session.setCookies) headers.append("Set-Cookie", cookie);
  return { session, headers, allowed: isOwner(session.state?.user) };
}
export function publisherSameOrigin(request: Request): boolean {
  return request.headers.get("Origin") === new URL(request.url).origin;
}
