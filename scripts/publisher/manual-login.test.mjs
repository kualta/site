import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { manualLogin } from "./manual-login.mjs";

function fixture() {
  const child = new EventEmitter();
  const calls = [];
  let time = 0;
  let killedAt;
  child.kill = (signal) => {
    calls.push(signal);
    killedAt = time;
    child.emit("exit", 0);
  };
  return {
    child,
    calls,
    time: () => time,
    killedAt: () => killedAt,
    deps: {
      prepare: async () => {},
      launch: (binary, args) => {
        calls.push({ binary, args });
        return child;
      },
      now: () => time,
      wait: async (ms) => {
        time += ms;
      },
    },
  };
}
test("manual sign-in uses ordinary Chrome and closes only its process after confirmation", async () => {
  const f = fixture();
  let polls = 0;
  let confirmedAt;
  await manualLogin(
    "/tmp/publisher-test-profile",
    "https://x.com/home",
    async () => {
      if (++polls < 2) return {};
      confirmedAt ??= f.time();
      return { confirmed: true };
    },
    f.deps,
  );
  expect(f.calls[0].binary).toEndWith("/Google Chrome");
  expect(f.calls[0].args).toContain("--user-data-dir=/tmp/publisher-test-profile");
  expect(f.calls[0].args.some((arg) => /automation|remote-debugging|disable-blink/.test(arg))).toBe(false);
  expect(f.calls.at(-1)).toBe("SIGTERM");
  // Chrome's periodic cookie write must happen before SIGTERM, which skips it.
  expect(f.killedAt() - confirmedAt).toBeGreaterThan(30_000);
});
test("cancellation closes manual Chrome without confirming a session", async () => {
  const f = fixture();
  await expect(
    manualLogin(
      "/tmp/profile",
      "https://x.com/home",
      async () => {
        throw Error("Cancelled");
      },
      f.deps,
    ),
  ).rejects.toThrow("Cancelled");
  expect(f.calls.at(-1)).toBe("SIGTERM");
});
test("timeout closes manual Chrome", async () => {
  const f = fixture();
  await expect(manualLogin("/tmp/profile", "https://x.com/home", async () => ({}), f.deps)).rejects.toThrow(
    "timed out",
  );
  expect(f.calls.at(-1)).toBe("SIGTERM");
});
