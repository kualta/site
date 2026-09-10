import { notifyNewsletter, type WaitUntil } from "./notifications";
import { digest, json, normalizeEmail, readJson, record, sign } from "./security";
import { rateLimit } from "./store";
import type { NewsletterEnv } from "./types";

const accepted = () => json(200, { message: "You’re subscribed." });
export async function subscribe(request: Request, env: NewsletterEnv, waitUntil?: WaitUntil): Promise<Response> {
  const requestOrigin = request.headers.get("Origin");
  if (requestOrigin && requestOrigin !== new URL(request.url).origin)
    return json(403, { message: "Please subscribe from this site." });
  let email: string | null;
  try {
    email = normalizeEmail(record(await readJson(request, 2048)).email);
  } catch {
    return json(400, { message: "Please enter a valid email address." });
  }
  if (!email) return json(400, { message: "Please enter a valid email address." });
  const db = env.NEWSLETTER_DB;
  const secret = env.NEWSLETTER_TOKEN_SECRET;
  if (!db || !secret || secret.length < 32)
    return json(503, { message: "Signup is temporarily unavailable. Please try again later." });
  const now = Math.floor(Date.now() / 1000);
  try {
    await db.prepare("DELETE FROM newsletter_rate_limits WHERE expires_at < ?").bind(now).run();
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    if (
      !(await rateLimit(db, `ip:${await sign(secret, "ip", ip)}`, 5, 3600, now)) ||
      !(await rateLimit(db, "global", 100, 3600, now))
    )
      return json(429, { message: "Please try again later." });
    if (!(await rateLimit(db, `email:${await sign(secret, "email", email)}`, 1, 600, now))) return accepted();
    // A fresh signup is consent; provider suppressions always take precedence.
    const result = await db
      .prepare(`INSERT INTO newsletter_subscribers (id,email,status,created_at,consent_at)
      VALUES (?,?,'active',?,?) ON CONFLICT(email) DO UPDATE SET
      status='active', consent_at=excluded.consent_at, unsubscribed_at=NULL,
      confirmation_hash=NULL, confirmation_expires=NULL
      WHERE status IN ('pending','unsubscribed')`)
      .bind(crypto.randomUUID(), email, now, now)
      .run();
    if (result.meta.changes) await notifyNewsletter(env, "subscribed", email, waitUntil);
    return accepted();
  } catch {
    return json(503, { message: "Signup is temporarily unavailable. Please try again later." });
  }
}
export async function confirm(env: NewsletterEnv, value: string, waitUntil?: WaitUntil): Promise<boolean> {
  if (!env.NEWSLETTER_DB || !/^[a-f0-9-]{72}$/.test(value)) return false;
  const now = Math.floor(Date.now() / 1000);
  const result = await env.NEWSLETTER_DB.prepare(`UPDATE newsletter_subscribers SET status='active',
    consent_at=?, confirmed_at=?, unsubscribed_at=NULL, confirmation_hash=NULL, confirmation_expires=NULL
    WHERE confirmation_hash=? AND confirmation_expires>=? AND status IN ('pending','unsubscribed') RETURNING email`)
    .bind(now, now, await digest(value), now)
    .first<{ email: string }>();
  if (result) await notifyNewsletter(env, "subscribed", result.email, waitUntil);
  return !!result;
}

export async function unsubscribe(env: NewsletterEnv, id: string, waitUntil?: WaitUntil): Promise<void> {
  if (!env.NEWSLETTER_DB) throw new Error("Newsletter unavailable");
  const changed = await env.NEWSLETTER_DB.prepare(`UPDATE newsletter_subscribers SET
    status=CASE WHEN status='suppressed' THEN 'suppressed' ELSE 'unsubscribed' END,
    unsubscribed_at=COALESCE(unsubscribed_at,?), confirmation_hash=NULL,confirmation_expires=NULL
    WHERE id=? AND status IN ('active','pending','suppressed') RETURNING email,status`)
    .bind(Math.floor(Date.now() / 1000), id)
    .first<{ email: string; status: string }>();
  if (changed?.status === "unsubscribed") await notifyNewsletter(env, "unsubscribed", changed.email, waitUntil);
}
