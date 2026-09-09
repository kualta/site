import { authorized, json, readJson, record } from "./security";
import { applyFeedback } from "./store";
import type { NewsletterEnv } from "./types";

const fields: Record<string, string> = {
  delivery: "deliveredAt",
  open: "openedAt",
  click: "clickedAt",
  bounce: "bouncedAt",
  complaint: "complainedAt",
};
export async function feedback(request: Request, env: NewsletterEnv): Promise<Response> {
  if (!authorized(request, env.NEWSLETTER_WEBHOOK_SECRET)) return json(401, { message: "Unauthorized" });
  if (!env.NEWSLETTER_DB) return json(503, { message: "Unavailable" });
  if (request.method === "GET") return json(200, { ok: true });
  const type = new URL(request.url).searchParams.get("type") || "";
  if (!Object.hasOwn(fields, type)) return json(400, { message: "Invalid event type" });
  try {
    const payload = record(await readJson(request));
    const event = record(payload.event);
    if (typeof event.emailId !== "string" || event.emailId.length > 100)
      return json(400, { message: "Missing emailId" });
    const date = event[fields[type]];
    const parsed = typeof date === "string" ? Date.parse(date) : Date.now();
    if (!Number.isFinite(parsed)) return json(400, { message: "Invalid timestamp" });
    const now = Math.floor(Date.now() / 1000);
    const at = Math.min(Math.floor(parsed / 1000), now);
    const permanent = type === "complaint" || (type === "bounce" && event.bounceType === "Permanent");
    await env.NEWSLETTER_DB.prepare(`INSERT INTO newsletter_feedback(provider_id,type,occurred_at,permanent) VALUES (?,?,?,?)
      ON CONFLICT(provider_id,type) DO UPDATE SET occurred_at=MIN(occurred_at,excluded.occurred_at), permanent=MAX(permanent,excluded.permanent)`)
      .bind(event.emailId, type, at, permanent ? 1 : 0)
      .run();
    await applyFeedback(env.NEWSLETTER_DB, event.emailId);
    return json(200, { ok: true });
  } catch {
    return json(400, { message: "Unable to process feedback" });
  }
}
