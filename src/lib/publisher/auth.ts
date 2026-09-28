import { resolveSession } from "@flow-industries/id/server";

export function flowOptions(url: URL, development = import.meta.env.DEV) {
  // The audience is pinned in production; request headers cannot choose it.
  if (development && ["localhost", "127.0.0.1"].includes(url.hostname)) {
    return {
      audience: url.origin,
      issuerUrl: import.meta.env.FLOW_ID_HOST || "http://localhost:8063",
      apiUrl: import.meta.env.FLOW_ID_API_URL || "http://127.0.0.1:8060",
    };
  }
  return { audience: "https://post.kualta.dev", issuerUrl: "https://id.flow.industries" };
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
