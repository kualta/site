import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { claimTarget, hashToken, validatePost } from "./server";
import { defaultMetadata } from "./presets";
import type { NewsletterDB } from "../newsletter/types";
const post = () => ({
  id: crypto.randomUUID(),
  kind: "photo",
  title: "A photo",
  caption: "Hello",
  alt: "A mountain",
  media: [crypto.randomUUID()],
  platforms: ["grain"],
  metadata: defaultMetadata(),
  visibility: "PRIVATE",
});
function database() {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("migrations/0002_publisher.sql", "utf8"));
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...v: unknown[]) {
          values = v;
          return statement;
        },
        async first() {
          return sqlite.query(sql).get(...(values as never[]));
        },
        async run() {
          return { meta: sqlite.query(sql).run(...(values as never[])) };
        },
      };
      return statement;
    },
  } as unknown as NewsletterDB;
  return { db, sqlite };
}
test("rejects unsupported media, destinations and unsafe post parameters", () => {
  expect(validatePost(post()).title).toBe("A photo");
  expect(() => validatePost({ ...post(), kind: "video" })).toThrow("Unsupported");
  expect(() => validatePost({ ...post(), platforms: ["bogus"] })).toThrow("Unsupported");
  expect(() => validatePost({ ...post(), platforms: ["twitter"], caption: "x".repeat(281) })).toThrow("280");
  expect(() => validatePost({ ...post(), media: ["../../secret"] })).toThrow();
  expect(() => validatePost({ ...post(), metadata: {} })).toThrow();
});
test("pairing secrets are hashed deterministically", async () => {
  const token = "a".repeat(64);
  expect(await hashToken(token)).toHaveLength(64);
  expect(await hashToken(token)).not.toBe(token);
  expect(await hashToken(token)).toBe(await hashToken(token));
});
describe("queue", () => {
  test("claims each target once, only for configured platforms", async () => {
    const { db, sqlite } = database();
    sqlite.exec(
      "INSERT INTO publisher_targets (id, job_id, platform) VALUES ('a', 'job', 'grain'), ('b', 'job', 'twitter')",
    );
    expect((await claimTarget(db, ["grain"]))?.id).toBe("a");
    expect(await claimTarget(db, ["grain"])).toBeNull();
    expect((await claimTarget(db, ["twitter"]))?.id).toBe("b");
    sqlite.close();
  });
  test("expired work becomes uncertain and is never automatically reposted", async () => {
    const { db, sqlite } = database();
    sqlite.exec(
      "INSERT INTO publisher_targets (id, job_id, platform, state, started_at) VALUES ('a', 'job', 'grain', 'working', 1)",
    );
    expect(await claimTarget(db, ["grain"])).toBeNull();
    expect(sqlite.query("SELECT state FROM publisher_targets").get()).toEqual({ state: "uncertain" });
    sqlite.close();
  });
  test("a media upload cannot be assigned to two posts", () => {
    const { sqlite } = database();
    sqlite.exec("INSERT INTO publisher_media VALUES ('media', 'photo', 'photo', 1, 'job')");
    expect(() => sqlite.exec("UPDATE publisher_media SET job_id = 'other'")).toThrow();
    sqlite.close();
  });
});
