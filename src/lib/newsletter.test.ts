import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { admin } from "./newsletter/admin";
import { feedback } from "./newsletter/feedback";
import { parseIssue, prepareIssue, sendBatch } from "./newsletter/issues";
import { notifyNewsletter } from "./newsletter/notifications";
import { plunkSender, SendError } from "./newsletter/plunk";
import { digest, token, verifyToken } from "./newsletter/security";
import { confirm, subscribe, unsubscribe } from "./newsletter/subscriptions";
import { track } from "./newsletter/tracking";
import type { NewsletterDB, NewsletterEnv, Statement } from "./newsletter/types";

class SQL implements Statement {
  constructor(readonly sqlite: Database, readonly sql: string, readonly values: unknown[] = []) {}
  bind(...values: unknown[]) {
    return new SQL(this.sqlite, this.sql, values);
  }
  async first<T>() {
    return this.sqlite.query(this.sql).get(...(this.values as never[])) as T | null;
  }
  async all<T>() {
    return { results: this.sqlite.query(this.sql).all(...(this.values as never[])) as T[] };
  }
  async run() {
    return { meta: { changes: this.sqlite.query(this.sql).run(...(this.values as never[])).changes } };
  }
}
function setup() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  sqlite.exec(readFileSync(new URL("../../migrations/0001_newsletter.sql", import.meta.url), "utf8"));
  const db: NewsletterDB = {
    prepare: (sql) => new SQL(sqlite, sql),
    batch: async (statements) =>
      sqlite.transaction(() =>
        statements.map((item) => {
          const q = item as SQL;
          return sqlite.query(q.sql).run(...(q.values as never[]));
        }),
      )(),
  };
  const env = {
    NEWSLETTER_DB: db,
    PLUNK_SECRET_KEY: "sk_test",
    NEWSLETTER_TOKEN_SECRET: "t".repeat(64),
    NEWSLETTER_ADMIN_SECRET: "a".repeat(64),
    NEWSLETTER_WEBHOOK_SECRET: "w".repeat(64),
  };
  function seed(status = "active", email = "reader@example.com") {
    const id = crypto.randomUUID();
    sqlite
      .query("INSERT INTO newsletter_subscribers(id,email,status,created_at) VALUES (?,?,?,?)")
      .run(id, email, status, 1);
    return id;
  }
  return { db, sqlite, env, seed };
}
function signup(body: unknown = { email: "reader@example.com" }, ip = "127.0.0.1") {
  return new Request("https://kualta.dev/api/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://kualta.dev", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
}
function adminRequest(env: NewsletterEnv, body: unknown) {
  return new Request("https://kualta.dev/api/newsletter/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.NEWSLETTER_ADMIN_SECRET}` },
    body: JSON.stringify(body),
  });
}
const issue = {
  id: "first-essay",
  title: "An essay",
  preview: "A preview",
  paragraphs: ["Hello readers."],
  articleUrl: "https://kualta.dev/posts/memetic-culture",
};

describe("newsletter subscriptions", () => {
  test("activates immediately without sending email or requiring Plunk", async () => {
    const { env, sqlite } = setup();
    const response = await subscribe(signup({ email: " Reader@Example.com " }), {
      ...env,
      PLUNK_SECRET_KEY: undefined,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("subscribed");
    const row = sqlite
      .query("SELECT status,email,consent_at,confirmed_at,confirmation_hash FROM newsletter_subscribers")
      .get() as { consent_at: number };
    expect(row).toMatchObject({
      status: "active",
      email: "reader@example.com",
      confirmed_at: null,
      confirmation_hash: null,
    });
    expect(row.consent_at).toBeGreaterThan(0);
    expect(sqlite.query("SELECT COUNT(*) n FROM newsletter_deliveries").get()).toEqual({ n: 0 });
  });
  test.each([{}, null, { email: "bad" }, { email: 42 }, { email: "a@b.c\ninject" }])(
    "rejects malformed input %j",
    async (value) => {
      expect((await subscribe(signup(value), setup().env)).status).toBe(400);
    },
  );
  test("fails closed without configured database and rejects foreign origins", async () => {
    expect((await subscribe(signup(), {})).status).toBe(503);
    const req = new Request(signup(), {
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
    });
    expect((await subscribe(req, setup().env)).status).toBe(403);
  });
  test("repeat signups are idempotent, fresh signups reactivate opt-outs, suppression persists", async () => {
    for (const state of ["active", "suppressed", "pending", "unsubscribed"]) {
      const { env, seed, sqlite } = setup();
      seed(state);
      expect((await subscribe(signup(), env)).status).toBe(200);
      expect((await subscribe(signup(), env)).status).toBe(200);
      expect(sqlite.query("SELECT status FROM newsletter_subscribers").get()).toEqual({
        status: state === "suppressed" ? "suppressed" : "active",
      });
      expect(sqlite.query("SELECT COUNT(*) n FROM newsletter_deliveries").get()).toEqual({ n: 0 });
    }
  });
  test("rate limits across different emails at the same IP", async () => {
    const { env } = setup();
    for (let i = 0; i < 5; i++) expect((await subscribe(signup({ email: `r${i}@example.com` }), env)).status).toBe(200);
    expect((await subscribe(signup({ email: "six@example.com" }), env)).status).toBe(429);
  });
  test("unsubscribe is idempotent, invalidates confirmation and never lifts suppression", async () => {
    const { env, sqlite, seed } = setup();
    const id = seed();
    await unsubscribe(env, id);
    await unsubscribe(env, id);
    expect(sqlite.query("SELECT status,confirmation_hash FROM newsletter_subscribers WHERE id=?").get(id)).toEqual({
      status: "unsubscribed",
      confirmation_hash: null,
    });
    const blocked = seed("suppressed", "blocked@example.com");
    await unsubscribe(env, blocked);
    expect(sqlite.query("SELECT status FROM newsletter_subscribers WHERE id=?").get(blocked)).toEqual({
      status: "suppressed",
    });
  });
  test("expired confirmation and suppression cannot reactivate a subscriber", async () => {
    const { env, sqlite, seed } = setup();
    const id = seed("suppressed");
    const value = crypto.randomUUID() + crypto.randomUUID();
    sqlite
      .query("UPDATE newsletter_subscribers SET confirmation_hash=?,confirmation_expires=? WHERE id=?")
      .run(await digest(value), Date.now() / 1000 + 500, id);
    expect(await confirm(env, value)).toBe(false);
    sqlite.query("UPDATE newsletter_subscribers SET status='pending',confirmation_expires=1 WHERE id=?").run(id);
    expect(await confirm(env, value)).toBe(false);
  });
});
describe("durable sending", () => {
  test("snapshots active subscribers, excludes later signups, preserves immutable content", async () => {
    const { db, seed, sqlite } = setup();
    seed();
    seed("unsubscribed", "out@example.com");
    await prepareIssue(db, issue);
    seed("active", "later@example.com");
    await prepareIssue(db, issue);
    expect(sqlite.query("SELECT COUNT(*) n FROM newsletter_deliveries").get()).toEqual({ n: 1 });
    expect(prepareIssue(db, { ...issue, title: "changed" })).rejects.toThrow("different content");
  });
  test("concurrent workers and repeated commands never send a delivery twice", async () => {
    const { db, env, seed, sqlite } = setup();
    seed();
    await prepareIssue(db, issue);
    let sends = 0;
    const sender = async () => {
      sends++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "provider-one";
    };
    await Promise.all([sendBatch(env, issue.id, sender), sendBatch(env, issue.id, sender)]);
    await sendBatch(env, issue.id, sender);
    expect(sends).toBe(1);
    expect(sqlite.query("SELECT state FROM newsletter_deliveries").get()).toEqual({ state: "sent" });
  });
  test("opt-out after preparation is skipped before sending", async () => {
    const { db, env, seed, sqlite } = setup();
    seed();
    await prepareIssue(db, issue);
    sqlite.exec("UPDATE newsletter_subscribers SET status='unsubscribed'");
    let sends = 0;
    await sendBatch(env, issue.id, async () => {
      sends++;
      return "no";
    });
    expect(sends).toBe(0);
    expect(sqlite.query("SELECT state FROM newsletter_deliveries").get()).toEqual({ state: "skipped" });
  });
  test("uncertain provider handoff is never automatically retried", async () => {
    const { db, env, seed, sqlite } = setup();
    seed();
    await prepareIssue(db, issue);
    let sends = 0;
    const sender = async () => {
      sends++;
      throw new SendError("timeout", true);
    };
    await sendBatch(env, issue.id, sender);
    await sendBatch(env, issue.id, sender);
    expect(sends).toBe(1);
    expect(sqlite.query("SELECT state FROM newsletter_deliveries").get()).toEqual({ state: "unknown" });
  });
  test("renders own unsubscribe and tracking links with no contact data in URLs", async () => {
    const { db, env, seed } = setup();
    seed();
    await prepareIssue(db, issue);
    await sendBatch(env, issue.id, async (email) => {
      expect(email.html).toContain("/api/newsletter/open?token=");
      expect(email.html).toContain("/api/newsletter/click?token=");
      expect(email.unsubscribeUrl).toContain("https://kualta.dev/newsletter/unsubscribe?token=");
      expect(email.html).not.toContain("reader@example.com");
      expect(email.html).not.toContain("{{unsubscribeUrl}}");
      return "provider-render";
    });
  });
});
describe("feedback and tracking", () => {
  test("feedback before the send response is retained and suppresses hard bounces", async () => {
    const { db, env, seed, sqlite } = setup();
    seed();
    await prepareIssue(db, issue);
    const req = new Request("https://kualta.dev/api/newsletter/feedback?type=bounce", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.NEWSLETTER_WEBHOOK_SECRET}` },
      body: JSON.stringify({
        event: { emailId: "early", bounceType: "Permanent", bouncedAt: new Date().toISOString() },
      }),
    });
    expect((await feedback(req.clone(), env)).status).toBe(200);
    expect((await feedback(req.clone(), env)).status).toBe(200);
    await sendBatch(env, issue.id, async () => "early");
    expect(sqlite.query("SELECT status,suppression_reason FROM newsletter_subscribers").get()).toEqual({
      status: "suppressed",
      suppression_reason: "bounce",
    });
    expect(sqlite.query("SELECT COUNT(*) n FROM newsletter_feedback").get()).toEqual({ n: 1 });
  });
  test("unauthenticated feedback is rejected", async () => {
    expect(
      (await feedback(new Request("https://kualta.dev/api/newsletter/feedback?type=open"), setup().env)).status,
    ).toBe(401);
  });
  test("tokens are purpose scoped; tracking counts first observation per delivery", async () => {
    const { db, env, seed, sqlite } = setup();
    seed();
    await prepareIssue(db, issue);
    await sendBatch(env, issue.id, async () => "tracking");
    const { id } = sqlite.query("SELECT id FROM newsletter_deliveries").get() as { id: string };
    const open = await token(env.NEWSLETTER_TOKEN_SECRET, "open", id);
    expect(await verifyToken(env.NEWSLETTER_TOKEN_SECRET, "unsubscribe", open)).toBeNull();
    const req = new Request(`https://kualta.dev/api/newsletter/open?token=${open}`);
    expect((await track(req, env, "open")).headers.get("Content-Type")).toBe("image/gif");
    const first = sqlite.query("SELECT opened_at FROM newsletter_deliveries").get();
    await track(req, env, "open");
    expect(sqlite.query("SELECT opened_at FROM newsletter_deliveries").get()).toEqual(first);
    const click = await token(env.NEWSLETTER_TOKEN_SECRET, "click", id);
    const response = await track(new Request(`https://kualta.dev/api/newsletter/click?token=${click}`), env, "click");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(issue.articleUrl);
  });
});
describe("administration", () => {
  test("requires authentication and preserves imported opt-outs on later active imports", async () => {
    const { env, sqlite } = setup();
    expect((await admin(new Request("https://kualta.dev/api/newsletter/admin"), env)).status).toBe(401);
    for (const status of ["unsubscribed", "active"]) {
      const req = adminRequest(env, {
        action: "import",
        subscribers: [{ email: "reader@example.com", status, source: "paragraph-export", consent_at: 1000 }],
      });
      expect((await admin(req, env)).status).toBe(200);
    }
    expect(sqlite.query("SELECT status FROM newsletter_subscribers").get()).toEqual({ status: "unsubscribed" });
  });
  test("validates entire import before writing and requires consent evidence", async () => {
    const { env, sqlite } = setup();
    const response = await admin(
      adminRequest(env, {
        action: "import",
        subscribers: [{ email: "reader@example.com", status: "active", source: "paragraph" }],
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(sqlite.query("SELECT COUNT(*) n FROM newsletter_subscribers").get()).toEqual({ n: 0 });
  });
  test("rejects arbitrary redirect destinations and header injection", () => {
    expect(() => parseIssue({ ...issue, articleUrl: "https://evil.example" })).toThrow();
    expect(() => parseIssue({ ...issue, title: "Hi\r\nBcc: someone" })).toThrow();
  });
});
describe("Plunk adapter", () => {
  test("sends HTML and List-Unsubscribe headers directly, without provider templates or subscription mutation", async () => {
    const send = plunkSender("sk_test", async (url, options) => {
      expect(url).toBe("https://next-api.useplunk.com/v1/send");
      const body = JSON.parse(options?.body as string);
      expect(body.from).toEqual({ name: "kualta", email: "contact@kualta.dev" });
      expect(body.template).toBeUndefined();
      expect(body.subscribed).toBeUndefined();
      expect(body.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      return Response.json({ success: true, data: { emails: [{ email: "provider-id" }] } });
    });
    expect(
      await send({
        to: "reader@example.com",
        subject: "Hello",
        html: "<p>Hi</p>",
        idempotencyKey: "one",
        unsubscribeUrl: "https://kualta.dev/newsletter/unsubscribe?token=x",
      }),
    ).toBe("provider-id");
  });
  test("malformed success and duplicate-key responses remain uncertain", async () => {
    for (const response of [Response.json({ success: true }), new Response("", { status: 409 })]) {
      const send = plunkSender("test", async () => response);
      try {
        await send({ to: "reader@example.com", subject: "Hi", html: "Hi", idempotencyKey: "one" });
        throw new Error("Expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(SendError);
        expect((error as SendError).uncertain).toBe(true);
      }
    }
  });
});

function mockFetch(implementation: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(implementation, { preconnect: fetch.preconnect }));
}

describe("subscription notifications", () => {
  test("notifies each committed transition once and preserves suppression", async () => {
    const { env, sqlite, seed } = setup();
    const notified: string[] = [];
    const request = mockFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      notified.push(body.content);
      return Response.json({ id: "message" });
    });
    const configured = { ...env, NEWSLETTER_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test/token" };
    try {
      expect((await subscribe(signup(), configured)).status).toBe(200);
      sqlite.exec("DELETE FROM newsletter_rate_limits");
      await subscribe(signup(), configured);
      const { id } = sqlite.query("SELECT id FROM newsletter_subscribers").get() as { id: string };
      await unsubscribe(configured, id);
      await unsubscribe(configured, id);
      sqlite.exec("DELETE FROM newsletter_rate_limits");
      await subscribe(signup(), configured);
      const blocked = seed("suppressed", "blocked@example.com");
      await subscribe(signup({ email: "blocked@example.com" }), configured);
      await unsubscribe(configured, blocked);
      const legacy = seed("pending", "legacy@example.com");
      const confirmation = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      sqlite
        .query("UPDATE newsletter_subscribers SET confirmation_hash=?,confirmation_expires=? WHERE id=?")
        .run(await digest(confirmation), Math.floor(Date.now() / 1000) + 60, legacy);
      expect(await confirm(configured, confirmation)).toBe(true);
      expect(await confirm(configured, confirmation)).toBe(false);
      expect(notified).toEqual([
        "Newsletter subscribed: reader@example.com\nActive subscribers: 1",
        "Newsletter unsubscribed: reader@example.com",
        "Newsletter subscribed: reader@example.com\nActive subscribers: 1",
        "Newsletter subscribed: legacy@example.com\nActive subscribers: 2",
      ]);
      expect(JSON.parse(String(request.mock.calls[0][1]?.body)).allowed_mentions).toEqual({ parse: [] });
      expect(request.mock.calls[0][1]?.redirect).toBe("manual");
      expect(new Headers(request.mock.calls[0][1]?.headers).get("User-Agent")).toBe(
        "DiscordBot (https://kualta.dev, 1.0)",
      );
    } finally {
      request.mockRestore();
    }
  });

  test("provider failures do not undo signup or unsubscribe and do not leak secrets", async () => {
    const { env, sqlite } = setup();
    const request = spyOn(globalThis, "fetch").mockRejectedValue(new Error("secret-url"));
    const log = spyOn(console, "error").mockImplementation(() => {});
    const configured = { ...env, NEWSLETTER_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test/token" };
    try {
      expect((await subscribe(signup(), configured)).status).toBe(200);
      const { id } = sqlite.query("SELECT id FROM newsletter_subscribers").get() as { id: string };
      await unsubscribe(configured, id);
      expect(sqlite.query("SELECT status FROM newsletter_subscribers").get()).toEqual({ status: "unsubscribed" });
      expect(log).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret-url");
      expect(JSON.stringify(log.mock.calls)).not.toContain("reader@example.com");
    } finally {
      request.mockRestore();
      log.mockRestore();
    }
  });

  test("schedules Discord in background and handles a rejected request", async () => {
    const jobs: Promise<unknown>[] = [];
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = mockFetch(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      await pending;
      return new Response("unavailable", { status: 503 });
    });
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      await notifyNewsletter(
        {
          NEWSLETTER_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test/token",
        },
        "subscribed",
        "reader@example.com",
        (work) => jobs.push(work),
      );
      expect(jobs).toHaveLength(1);
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toContain("wait=true");
      release();
      await Promise.all(jobs);
      expect(log).toHaveBeenCalledWith("newsletter_notification_failed", {
        provider: "discord",
        event: "subscribed",
        failure: "http_503",
      });
    } finally {
      release();
      request.mockRestore();
      log.mockRestore();
    }
  });
});

describe("email open notifications", () => {
  test.each(["pixel-first", "provider-first", "concurrent"])("deduplicates %s opens across sources", async (order) => {
    const { db, env, seed, sqlite } = setup();
    seed();
    await prepareIssue(db, issue);
    await sendBatch(env, issue.id, async () => "open-provider");
    const { id } = sqlite.query("SELECT id FROM newsletter_deliveries").get() as { id: string };
    const signed = await token(env.NEWSLETTER_TOKEN_SECRET, "open", id);
    const pixelRequest = () => new Request(`https://kualta.dev/api/newsletter/open?token=${signed}`);
    const providerRequest = () =>
      new Request("https://kualta.dev/api/newsletter/feedback?type=open", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.NEWSLETTER_WEBHOOK_SECRET}` },
        body: JSON.stringify({ event: { emailId: "open-provider", openedAt: new Date().toISOString() } }),
      });
    const request = mockFetch(async () => Response.json({ id: "open-message" }));
    const configured = { ...env, NEWSLETTER_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test/token" };
    try {
      const pixel = () => track(pixelRequest(), configured, "open");
      const provider = () => feedback(providerRequest(), configured);
      if (order === "pixel-first") {
        await pixel();
        await provider();
      } else if (order === "provider-first") {
        await provider();
        await pixel();
      } else await Promise.all([pixel(), provider()]);
      await Promise.all([pixel(), provider(), pixel()]);
      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(request.mock.calls[0][1]?.body)).content).toBe(
        "`reader@example.com` opened `An essay`",
      );
      expect(
        (sqlite.query("SELECT opened_at FROM newsletter_deliveries").get() as { opened_at: number }).opened_at,
      ).toBeGreaterThan(0);
    } finally {
      request.mockRestore();
    }
  });

  test("retains early provider opens until the send is recorded", async () => {
    const { db, env, seed } = setup();
    seed();
    await prepareIssue(db, issue);
    const configured = { ...env, NEWSLETTER_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test/token" };
    const request = mockFetch(async () => Response.json({ id: "early-open-message" }));
    try {
      await feedback(
        new Request("https://kualta.dev/api/newsletter/feedback?type=open", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.NEWSLETTER_WEBHOOK_SECRET}` },
          body: JSON.stringify({ event: { emailId: "early-open", openedAt: new Date().toISOString() } }),
        }),
        configured,
      );
      expect(request).toHaveBeenCalledTimes(0);
      await sendBatch(configured, issue.id, async () => "early-open");
      expect(request).toHaveBeenCalledTimes(1);
      const invalid = await track(
        new Request("https://kualta.dev/api/newsletter/open?token=invalid"),
        configured,
        "open",
      );
      expect(invalid.headers.get("Content-Type")).toBe("image/gif");
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      request.mockRestore();
    }
  });
});
