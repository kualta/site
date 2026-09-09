import { issueStats, parseIssue, prepareIssue, sendBatch } from "./issues";
import { plunkSender, SendError } from "./plunk";
import { renderIssue } from "./render";
import { authorized, digest, json, normalizeEmail, readJson, record } from "./security";
import { applyFeedback } from "./store";
import type { NewsletterEnv, Subscriber } from "./types";

export async function admin(request: Request, env: NewsletterEnv): Promise<Response> {
  if (!authorized(request, env.NEWSLETTER_ADMIN_SECRET)) return json(401, { message: "Unauthorized" });
  const db = env.NEWSLETTER_DB;
  if (!db) return json(503, { message: "Newsletter database unavailable" });
  const url = new URL(request.url);
  if (request.method === "GET") {
    const issue = url.searchParams.get("issue");
    if (issue) return json(200, await issueStats(db, issue));
    const email = normalizeEmail(url.searchParams.get("subscriber"));
    if (email) {
      const row = await db
        .prepare(
          "SELECT id,email,status,consent_at,confirmed_at,unsubscribed_at,suppression_reason,source FROM newsletter_subscribers WHERE email=?",
        )
        .bind(email)
        .first<{ id: string }>();
      const history = row
        ? await db
            .prepare("SELECT * FROM newsletter_deliveries WHERE subscriber_id=? ORDER BY created_at DESC LIMIT 100")
            .bind(row.id)
            .all()
        : { results: [] };
      return json(200, { subscriber: row, deliveries: history.results });
    }
    const after = url.searchParams.get("after") || "";
    const rows = await db
      .prepare(`SELECT id,email,status,source,consent_at,confirmed_at,unsubscribed_at,suppression_reason,created_at
      FROM newsletter_subscribers WHERE id>? ORDER BY id LIMIT 100`)
      .bind(after)
      .all<{ id: string }>();
    return json(200, { subscribers: rows.results, next: rows.results.length === 100 ? rows.results[99].id : null });
  }
  try {
    const input = record(await readJson(request, 256000));
    if (input.action === "prepare") {
      const issue = parseIssue(input.issue);
      await prepareIssue(db, issue);
      return json(200, await issueStats(db, issue.id));
    }
    if (input.action === "send") {
      if (typeof input.id !== "string") return json(400, { message: "Issue id required" });
      return json(200, await sendBatch(env, input.id));
    }
    if (input.action === "test") {
      if (!env.PLUNK_SECRET_KEY || !env.NEWSLETTER_TOKEN_SECRET)
        return json(503, { message: "Sending not configured" });
      const issue = parseIssue(input.issue);
      const to = normalizeEmail(input.to);
      const recipient = await db
        .prepare("SELECT * FROM newsletter_subscribers WHERE email=? AND status='active'")
        .bind(to)
        .first<Subscriber>();
      if (!recipient) return json(400, { message: "Test recipient must first subscribe." });
      const id = crypto.randomUUID();
      const testIssue = `test-${id}`;
      const now = Math.floor(Date.now() / 1000);
      const content = JSON.stringify(issue);
      await db.batch([
        db
          .prepare("INSERT INTO newsletter_issues(id,content,content_hash,created_at) VALUES (?,?,?,?)")
          .bind(testIssue, content, await digest(content), now),
        db
          .prepare(
            "INSERT INTO newsletter_deliveries(id,subscriber_id,issue_id,kind,state,created_at,attempted_at) VALUES (?,?,?,'test','sending',?,?)",
          )
          .bind(id, recipient.id, testIssue, now, now),
      ]);
      try {
        const rendered = await renderIssue(issue, env, recipient.id, id);
        const providerId = await plunkSender(env.PLUNK_SECRET_KEY)({
          to: recipient.email,
          subject: `[Preview] ${issue.title}`,
          html: rendered.html,
          unsubscribeUrl: rendered.unsubscribe,
          idempotencyKey: id,
        });
        await db
          .prepare("UPDATE newsletter_deliveries SET state='sent',provider_id=?,sent_at=? WHERE id=?")
          .bind(providerId, now, id)
          .run();
        await applyFeedback(db, providerId);
        return json(200, { id, state: "sent" });
      } catch (error) {
        const state = error instanceof SendError && !error.uncertain ? "failed" : "unknown";
        await db
          .prepare("UPDATE newsletter_deliveries SET state=?,error_code=? WHERE id=?")
          .bind(state, error instanceof SendError ? error.code : "internal", id)
          .run();
        return json(502, { id, state, message: "Test delivery failed or is uncertain. Inspect before retrying." });
      }
    }
    if (input.action === "resolve") {
      if (typeof input.id !== "string" || !["sent", "skipped"].includes(String(input.state)))
        throw new Error("Supply a delivery id and state sent or skipped.");
      if (
        input.state === "sent" &&
        (typeof input.providerId !== "string" || !input.providerId || input.providerId.length > 100)
      )
        throw new Error("Sent resolution requires the verified provider email id.");
      const changed = await db
        .prepare(`UPDATE newsletter_deliveries SET state=?, provider_id=COALESCE(?,provider_id), error_code='manually_resolved'
        WHERE id=? AND (state IN ('failed','unknown') OR (state='sending' AND attempted_at<?))`)
        .bind(
          input.state,
          input.state === "sent" ? input.providerId : null,
          input.id,
          Math.floor(Date.now() / 1000) - 300,
        )
        .run();
      if (!changed.meta.changes) throw new Error("Delivery is not unresolved, or its send is still in flight.");
      if (input.state === "sent") await applyFeedback(db, input.providerId as string);
      return json(200, { resolved: input.id, state: input.state });
    }
    if (input.action === "import") {
      if (!Array.isArray(input.subscribers) || input.subscribers.length > 100)
        throw new Error("Import at most 100 subscribers per request.");
      const now = Math.floor(Date.now() / 1000);
      const statements = input.subscribers.map((value) => {
        const row = record(value);
        const email = normalizeEmail(row.email);
        const allowed = ["active", "unsubscribed", "suppressed"];
        if (!email || typeof row.status !== "string" || !allowed.includes(row.status))
          throw new Error("Each row needs an email and explicit status.");
        if (typeof row.source !== "string" || !row.source || row.source.length > 200)
          throw new Error("Each row needs a consent source.");
        const consent =
          typeof row.consent_at === "number" &&
          Number.isInteger(row.consent_at) &&
          row.consent_at > 0 &&
          row.consent_at <= now
            ? row.consent_at
            : null;
        if (row.status === "active" && !consent)
          throw new Error("Active imports need a valid consent_at Unix timestamp.");
        return db
          .prepare(`INSERT INTO newsletter_subscribers(id,email,status,source,consent_at,created_at,suppression_reason)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET
          status=CASE WHEN newsletter_subscribers.status='suppressed' OR excluded.status='suppressed' THEN 'suppressed'
            WHEN newsletter_subscribers.status='unsubscribed' OR excluded.status='unsubscribed' THEN 'unsubscribed'
            ELSE excluded.status END,
          suppression_reason=COALESCE(newsletter_subscribers.suppression_reason,excluded.suppression_reason),
          consent_at=COALESCE(newsletter_subscribers.consent_at,excluded.consent_at), confirmation_hash=NULL`)
          .bind(
            crypto.randomUUID(),
            email,
            row.status,
            row.source,
            consent,
            now,
            row.status === "suppressed" ? "import" : null,
          );
      });
      await db.batch(statements);
      return json(200, { imported: statements.length });
    }
    return json(400, { message: "Unknown action" });
  } catch (error) {
    // Validation messages are ours; do not expose DB/provider details.
    const message =
      error instanceof Error && !/SQLITE|D1_|database|constraint/i.test(error.message)
        ? error.message
        : "Unable to complete request.";
    return json(400, { message });
  }
}
