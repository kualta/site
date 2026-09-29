import { claimAnalytics, saveAnalytics, analyticsPage, analyticsSeries } from "@/lib/publisher/analytics";
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { publisherSession, publisherSameOrigin } from "@/lib/publisher/auth";
import {
  authorizeHelper,
  claimTarget,
  claimConnection,
  hashToken,
  validId,
  validatePost,
} from "@/lib/publisher/server";
import { platforms } from "@/lib/publisher/presets";
import { historyPage, queueDeletion, claimDeletion } from "@/lib/publisher/history";
export const prerender = false;

export const ALL: APIRoute = async ({ request, params }) => {
  const path = params.path || "";
  const headers = new Headers({ "Cache-Control": "no-store" });
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
  try {
    const db = env.NEWSLETTER_DB;
    const bucket = env.PUBLISHER_MEDIA;
    const helper = path.startsWith("helper/");
    if (helper) {
      if (!db || !(await authorizeHelper(request, db))) return json({ error: "Helper authentication required" }, 401);
    } else {
      const owner = await publisherSession(request);
      for (const cookie of owner.session.setCookies) headers.append("Set-Cookie", cookie);
      if (!owner.allowed) return json({ error: "Owner sign-in required" }, 403);
      if (request.method !== "GET" && !publisherSameOrigin(request)) return json({ error: "Invalid origin" }, 403);
    }
    if (!db || !bucket) return json({ error: "Publisher storage is not configured" }, 503);
    if (path === "pair" && request.method === "POST") {
      const token = [...crypto.getRandomValues(new Uint8Array(32))]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
      await db
        .prepare(
          "INSERT INTO publisher_helper (id, token_hash) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, last_seen = NULL, platforms = '[]', public_key = NULL",
        )
        .bind(await hashToken(token))
        .run();
      return json({ token });
    }
    if (path === "pair" && request.method === "DELETE") {
      await db.prepare("DELETE FROM publisher_helper WHERE id = 1").run();
      return json({ ok: true });
    }
    if (path === "analytics" && request.method === "GET")
      return json(await analyticsPage(db, new URL(request.url).searchParams.get("before")));
    if (path.startsWith("analytics/") && request.method === "GET") {
      const id = path.slice("analytics/".length);
      if (!validId(id)) return json({ error: "Invalid post" }, 400);
      return json({ samples: await analyticsSeries(db, id) });
    }
    if (path === "analytics/refresh" && request.method === "POST") {
      const { job } = (await request.json()) as { job: string };
      if (!validId(job)) return json({ error: "Invalid post" }, 400);
      await db
        .prepare(
          "UPDATE publisher_metric_checks SET next_at=0 WHERE claim IS NULL AND (checked_at IS NULL OR checked_at < ?) AND target_id IN (SELECT id FROM publisher_targets WHERE job_id=?)",
        )
        .bind(Date.now() - 5 * 60_000, job)
        .run();
      return json({ ok: true });
    }
    if (path === "helper/analytics-result" && request.method === "POST") {
      const data = (await request.json()) as { target_id: string; claim: string; metrics: unknown; error?: string };
      if (
        !validId(data.target_id) ||
        !validId(data.claim) ||
        (data.error !== undefined && (typeof data.error !== "string" || !data.error))
      )
        return json({ error: "Invalid analytics receipt" }, 400);
      await saveAnalytics(db, data.target_id, data.claim, data.metrics, data.error);
      return json({ ok: true });
    }
    if (path === "history" && request.method === "GET") {
      return json(await historyPage(db, new URL(request.url).searchParams.get("before")));
    }
    if (path === "delete-publications" && request.method === "POST") {
      const data = (await request.json()) as {
        job: string;
        platform?: (typeof platforms)[number];
        confirmed?: boolean;
      };
      if (
        !validId(data.job) ||
        data.confirmed !== true ||
        (data.platform !== undefined && !platforms.includes(data.platform))
      )
        return json({ error: "Confirm the post and destinations to delete" }, 400);
      const result = await queueDeletion(db, data.job, data.platform);
      return json({ queued: result.meta.changes });
    }
    if (path === "helper/deletion-result" && request.method === "POST") {
      const data = (await request.json()) as { target_id: string; claim: string; state: string; message?: string };
      if (!validId(data.target_id) || !validId(data.claim) || !["deleted", "failed", "uncertain"].includes(data.state))
        return json({ error: "Invalid deletion result" }, 400);
      const result = await db
        .prepare(
          "UPDATE publisher_deletions SET state=?,message=?,finished_at=? WHERE target_id=? AND claim=? AND state IN ('working','uncertain')",
        )
        .bind(data.state, String(data.message || "").slice(0, 500), Date.now(), data.target_id, data.claim)
        .run();
      return json({ ok: result.meta.changes > 0 });
    }
    if (path === "status" && request.method === "GET") {
      const helper = await db.prepare("SELECT last_seen, platforms FROM publisher_helper WHERE id = 1").first();
      const connections = await db
        .prepare(
          "SELECT id, platform, action, state, confirmed, message FROM publisher_connections ORDER BY created_at DESC LIMIT 10",
        )
        .all();
      const { results } = await db
        .prepare(
          "SELECT j.id,j.payload,j.created_at,t.platform,t.state,t.message,t.url FROM publisher_jobs j JOIN publisher_targets t ON t.job_id=j.id WHERE j.id IN (SELECT id FROM publisher_jobs ORDER BY created_at DESC LIMIT 20) ORDER BY j.created_at DESC",
        )
        .all();
      return json({ helper, results, connections: connections.results });
    }
    if (path === "accounts" && request.method === "POST") {
      const data = (await request.json()) as {
        platform: (typeof platforms)[number];
        action: string;
        credentials?: unknown;
      };
      if (!platforms.includes(data.platform) || !["connect", "disconnect"].includes(data.action))
        return json({ error: "Invalid connection" }, 400);
      if (data.credentials !== undefined) return json({ error: "Refresh the composer to connect with OAuth" }, 400);
      const helper = await db
        .prepare("SELECT last_seen FROM publisher_helper WHERE id=1")
        .first<{ last_seen: number }>();
      if (!helper?.last_seen || Date.now() - helper.last_seen > 90_000)
        return json({ error: "Start your laptop helper first" }, 409);
      await db
        .prepare(
          "UPDATE publisher_connections SET state='failed', payload=NULL, message='Connection expired. Try again.' WHERE state IN ('queued','working') AND created_at < ?",
        )
        .bind(Date.now() - 15 * 60_000)
        .run();
      const id = crypto.randomUUID();
      const inserted = await db
        .prepare(
          "INSERT INTO publisher_connections(id,platform,action,payload,created_at) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM publisher_connections WHERE state IN ('queued','working')) RETURNING id",
        )
        .bind(id, data.platform, data.action, null, Date.now())
        .first();
      return inserted ? json({ id }, 201) : json({ error: "Finish or cancel the current connection first" }, 409);
    }
    if (path.startsWith("accounts/") && request.method === "POST") {
      const id = path.slice("accounts/".length);
      const { action } = (await request.json()) as { action: string };
      if (!validId(id) || !["finish", "cancel"].includes(action))
        return json({ error: "Invalid connection action" }, 400);
      if (action === "cancel")
        await db
          .prepare(
            "UPDATE publisher_connections SET state='cancelled', payload=NULL WHERE id=? AND state IN ('queued','working')",
          )
          .bind(id)
          .run();
      else
        await db.prepare("UPDATE publisher_connections SET confirmed=1 WHERE id=? AND state='working'").bind(id).run();
      return json({ ok: true });
    }
    if (path.startsWith("helper/accounts/") && request.method === "GET") {
      const id = path.slice("helper/accounts/".length);
      if (!validId(id)) return json({ error: "Invalid connection" }, 400);
      return json(await db.prepare("SELECT state, confirmed FROM publisher_connections WHERE id=?").bind(id).first());
    }
    if (path === "helper/accounts/result" && request.method === "POST") {
      const data = (await request.json()) as {
        id: string;
        claim: string;
        state: string;
        message?: string;
      };
      if (!validId(data.id) || !validId(data.claim) || !["succeeded", "failed"].includes(data.state))
        return json({ error: "Invalid connection result" }, 400);
      const updated = await db
        .prepare(
          "UPDATE publisher_connections SET state=?,message=?,payload=NULL WHERE id=? AND claim=? AND state='working'",
        )
        .bind(data.state, String(data.message || "").slice(0, 500), data.id, data.claim)
        .run();
      return json({ ok: updated.meta.changes > 0 });
    }
    if (path === "media" && request.method === "POST") {
      const type = request.headers.get("Content-Type") || "";
      const kind = type.startsWith("image/") ? "photo" : type.startsWith("video/") ? "video" : null;
      if (!kind) return json({ error: "Choose a photo or video" }, 400);
      const max = kind === "photo" ? 30_000_000 : 90_000_000;
      const length = Number(request.headers.get("Content-Length"));
      if (!length || length > max) return json({ error: "Photos can be up to 30 MB; videos up to 90 MB" }, 413);
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength !== length) return json({ error: "Incomplete upload" }, 400);
      const id = crypto.randomUUID();
      await bucket.put(id, bytes, { httpMetadata: { contentType: type } });
      try {
        await db
          .prepare("INSERT INTO publisher_media (id, kind, name, created_at) VALUES (?, ?, ?, ?)")
          .bind(id, kind, "media", Date.now())
          .run();
      } catch (error) {
        await bucket.delete(id);
        throw error;
      }
      return json({ id });
    }
    if (path === "jobs" && request.method === "POST") {
      const post = validatePost(await request.json());
      const existing = await db
        .prepare("SELECT payload FROM publisher_jobs WHERE id = ?")
        .bind(post.id)
        .first<{ payload: string }>();
      if (existing)
        return existing.payload === JSON.stringify(post)
          ? json({ id: post.id })
          : json({ error: "Post identifier already used" }, 409);
      for (const id of post.media) {
        const media = await db
          .prepare("SELECT kind, job_id FROM publisher_media WHERE id = ?")
          .bind(id)
          .first<{ kind: string; job_id: string | null }>();
        if (!media || media.kind !== post.kind || media.job_id)
          return json({ error: "Media is missing or already queued" }, 400);
      }
      await db.batch([
        db
          .prepare("INSERT INTO publisher_jobs (id, payload, created_at) VALUES (?, ?, ?)")
          .bind(post.id, JSON.stringify(post), Date.now()),
        ...post.media.map((id) => db.prepare("UPDATE publisher_media SET job_id = ? WHERE id = ?").bind(post.id, id)),
        ...post.platforms.map((platform) =>
          db
            .prepare("INSERT INTO publisher_targets (id, job_id, platform) VALUES (?, ?, ?)")
            .bind(crypto.randomUUID(), post.id, platform),
        ),
      ]);
      return json({ id: post.id }, 201);
    }
    if (path === "helper/heartbeat" && request.method === "POST") {
      await db.prepare("UPDATE publisher_helper SET last_seen = ? WHERE id = 1").bind(Date.now()).run();
      return json({ ok: true });
    }
    if (path === "helper/claim" && request.method === "POST") {
      const input = (await request.json()) as {
        platforms?: unknown;
        deletePublications?: boolean;
        analytics?: boolean;
      };
      const supported = platforms.filter((p) => Array.isArray(input.platforms) && input.platforms.includes(p));
      await db
        .prepare("UPDATE publisher_helper SET last_seen = ?, platforms = ? WHERE id = 1")
        .bind(Date.now(), JSON.stringify(supported))
        .run();
      const connection = await claimConnection(db);
      if (connection) return json({ connection, target: null });
      const connecting = await db.prepare("SELECT id FROM publisher_connections WHERE state='working' LIMIT 1").first();
      if (connecting) return json({ target: null });
      const deletion = input.deletePublications === true ? await claimDeletion(db, supported) : null;
      if (deletion) {
        const target = await db.prepare("SELECT * FROM publisher_targets WHERE id=?").bind(deletion.target_id).first();
        const job = await db
          .prepare("SELECT j.payload FROM publisher_jobs j JOIN publisher_targets t ON t.job_id=j.id WHERE t.id=?")
          .bind(deletion.target_id)
          .first<{ payload: string }>();
        return json({ deletion: { ...deletion, target, post: JSON.parse(job!.payload) } });
      }
      const target = await claimTarget(db, supported);
      if (!target) {
        const metricClaim =
          input.analytics === true
            ? await claimAnalytics(db, [...new Set([...supported, "grain", "bluesky"])] as (typeof platforms)[number][])
            : null;
        if (!metricClaim) return json({ target: null });
        const publication = await db
          .prepare("SELECT * FROM publisher_targets WHERE id=?")
          .bind(metricClaim.target_id)
          .first();
        return json({ analytics: { ...metricClaim, target: publication } });
      }
      const job = await db
        .prepare("SELECT payload FROM publisher_jobs WHERE id = ?")
        .bind(target.job_id)
        .first<{ payload: string }>();
      return json({ target, post: JSON.parse(job!.payload) });
    }
    if ((path.startsWith("helper/media/") || path.startsWith("media/")) && request.method === "GET") {
      const id = path.slice(path.lastIndexOf("/") + 1);
      if (!validId(id)) return json({ error: "Invalid media" }, 400);
      const object = await bucket.get(id);
      if (!object) return json({ error: "Media expired" }, 404);
      headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
      return new Response(object.body, { headers });
    }
    if (path === "helper/result" && request.method === "POST") {
      const data = (await request.json()) as Record<string, unknown>;
      if (
        !validId(data.id) ||
        !validId(data.claim) ||
        !["succeeded", "failed", "uncertain"].includes(String(data.state))
      )
        return json({ error: "Invalid result" }, 400);
      const url = typeof data.url === "string" && /^https:\/\//.test(data.url) ? data.url.slice(0, 2000) : null;
      if (data.state === "succeeded" && !url) return json({ error: "A confirmed post URL is required" }, 400);
      const result = await db
        .prepare(
          "UPDATE publisher_targets SET state = ?, message = ?, url = ? WHERE id = ? AND claim = ? AND state IN ('working','uncertain')",
        )
        .bind(data.state, String(data.message || "").slice(0, 500), url, data.id, data.claim)
        .run();
      return json({ ok: result.meta.changes > 0 });
    }
    if (path === "retry" && request.method === "POST") {
      const data = (await request.json()) as {
        job: string;
        platform: string;
        checked: boolean;
      };
      if (!validId(data.job) || !platforms.includes(data.platform as never) || data.checked !== true)
        return json({ error: "Confirm the destination has no duplicate first" }, 400);
      const result = await db
        .prepare(
          "UPDATE publisher_targets SET state = 'queued', claim = NULL, started_at = NULL, message = NULL, url = NULL WHERE job_id = ? AND platform = ? AND state IN ('failed','uncertain')",
        )
        .bind(data.job, data.platform)
        .run();
      return json({ ok: result.meta.changes > 0 });
    }
    if (path.startsWith("jobs/") && request.method === "DELETE") {
      const id = path.slice(5);
      if (!validId(id)) return json({ error: "Invalid post" }, 400);
      const published = await db
        .prepare(
          "SELECT id FROM publisher_targets WHERE job_id=? AND (state IN ('succeeded','uncertain') OR id IN (SELECT target_id FROM publisher_deletions)) LIMIT 1",
        )
        .bind(id)
        .first();
      if (published)
        return json({ error: "Published history is retained. Delete publications from History instead." }, 409);
      await db
        .prepare(
          "UPDATE publisher_targets SET state = 'failed', message = 'Cancelled by owner' WHERE job_id = ? AND state = 'queued'",
        )
        .bind(id)
        .run();
      if (await db.prepare("SELECT id FROM publisher_targets WHERE job_id = ? AND state = 'working'").bind(id).first())
        return json({ error: "Wait for the active upload to finish" }, 409);
      // Delete DB state first: no helper may claim queued targets during cleanup.
      const media = await db.prepare("SELECT id FROM publisher_media WHERE job_id = ?").bind(id).all<{ id: string }>();
      await db.batch([
        db.prepare("DELETE FROM publisher_targets WHERE job_id = ?").bind(id),
        db.prepare("DELETE FROM publisher_jobs WHERE id = ?").bind(id),
        db.prepare("DELETE FROM publisher_media WHERE job_id = ?").bind(id),
      ]);
      if (media.results.length) await bucket.delete(media.results.map((m) => m.id));
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: "Invalid request" }, 400);
    // Validation errors are safe; storage/session exceptions must not expose internals.
    const message = error instanceof Error ? error.message : "";
    const safe =
      /^(Invalid post|Choose |Add a title|Caption or alt|Unsupported destination|Grain supports|Bluesky captions|X captions|Instagram captions|Xiaohongshu supports)/.test(
        message,
      );
    return json(
      {
        error: safe ? message : "Publisher unavailable. Check storage and session configuration.",
      },
      safe ? 400 : 503,
    );
  }
};
