import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runActivityCron } from "./scheduled";

function setup() {
  const sql = new Database(":memory:");
  sql.exec(readFileSync(new URL("../../../migrations/0007_activity_refresh.sql", import.meta.url), "utf8"));
  const env = {
    ACTIVITY_CACHE: { get: async () => null, put: async () => {} },
    NEWSLETTER_DB: {
      prepare(query: string) {
        let values: unknown[] = [];
        return {
          bind(...args: unknown[]) { values = args; return this; },
          async run() { return { meta: { changes: sql.query(query).run(...values as []).changes } }; },
        };
      },
    },
    GITHUB_ACTIVITY_TOKEN: "server-only",
  } as unknown as Cloudflare.Env;
  return { env, sql };
}

test("cron refreshes without visits and deduplicates concurrent and older deliveries", async () => {
  const { env, sql } = setup();
  let calls = 0;
  const refresh = async () => { calls++; };
  await Promise.all([runActivityCron(env, 120_000, refresh), runActivityCron(env, 120_000, refresh)]);
  await runActivityCron(env, 60_000, refresh);
  expect(calls).toBe(1);
  await runActivityCron(env, 180_000, refresh);
  expect(calls).toBe(2);
  sql.close();
});

test("cron retries failed refresh on next minute, never every visitor", async () => {
  const { env, sql } = setup();
  let calls = 0;
  const refresh = async () => { calls++; throw new Error("offline"); };
  await expect(runActivityCron(env, 120_000, refresh)).rejects.toThrow("offline");
  await runActivityCron(env, 120_000, refresh);
  await expect(runActivityCron(env, 180_000, refresh)).rejects.toThrow("offline");
  expect(calls).toBe(2);
  sql.close();
});

test("missing bindings fail closed before upstream requests", async () => {
  await expect(runActivityCron({}, Date.now())).rejects.toThrow("bindings");
});

test("missing migration blocks refresh with a safe diagnostic, and local schema recovery restores it", async () => {
  const { env, sql } = setup();
  sql.exec("DROP TABLE activity_refresh");
  let calls = 0;
  const refresh = async () => { calls++; };
  await expect(runActivityCron(env, 120_000, refresh)).rejects.toThrow("0007_activity_refresh.sql");
  expect(calls).toBe(0);
  sql.exec(readFileSync(new URL("../../../migrations/0007_activity_refresh.sql", import.meta.url), "utf8"));
  await runActivityCron(env, 180_000, refresh);
  expect(calls).toBe(1);
  sql.close();
});
