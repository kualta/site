import { recordOpen } from "./opens";
import type { WaitUntil } from "./notifications";
import { verifyToken } from "./security";
import type { NewsletterEnv } from "./types";

const pixel = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));
export async function track(
  request: Request,
  env: NewsletterEnv,
  type: "open" | "click",
  waitUntil?: WaitUntil,
): Promise<Response> {
  const headers = {
    "Cache-Control": "no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex",
  };
  const missing = () => new Response("Link unavailable", { status: 404, headers });
  let target: string | undefined;
  try {
    if (env.NEWSLETTER_DB && env.NEWSLETTER_TOKEN_SECRET) {
      const id = await verifyToken(
        env.NEWSLETTER_TOKEN_SECRET,
        type,
        new URL(request.url).searchParams.get("token") || "",
      );
      if (id) {
        const row = await env.NEWSLETTER_DB.prepare(`SELECT i.content FROM newsletter_deliveries d JOIN newsletter_issues i ON i.id=d.issue_id
          WHERE d.id=? AND d.kind IN ('newsletter','test') AND d.state IN ('sending','sent','unknown')`)
          .bind(id)
          .first<{ content: string }>();
        if (row) {
          target = JSON.parse(row.content).articleUrl;
          const now = Math.floor(Date.now() / 1000);
          if (type === "open") await recordOpen(env, id, now, waitUntil);
          else
            await env.NEWSLETTER_DB.prepare(
              `UPDATE newsletter_deliveries SET clicked_at=COALESCE(clicked_at,?) WHERE id=?`,
            )
              .bind(now, id)
              .run();
        }
      }
    }
  } catch {
    /* A tracking outage must not break an otherwise valid article link. */
  }
  if (type === "open") return new Response(pixel, { headers: { ...headers, "Content-Type": "image/gif" } });
  if (!target) return missing();
  return new Response(null, { status: 302, headers: { ...headers, Location: target } });
}
