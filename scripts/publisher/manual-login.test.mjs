import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { manualLogin } from "./manual-login.mjs";

function fixture() {
  const child = new EventEmitter();
  const calls = [];
  child.kill = (signal) => {
    calls.push(signal);
    child.emit("exit", 0);
  };
  let time = 0;
  return {
    child,
    calls,
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
  await manualLogin(
    "/tmp/publisher-test-profile",
    "https://x.com/home",
    async () => ({ confirmed: ++polls === 2 }),
    f.deps,
  );
  expect(f.calls[0].binary).toEndWith("/Google Chrome");
  expect(f.calls[0].args).toContain("--user-data-dir=/tmp/publisher-test-profile");
  expect(f.calls[0].args.some((arg) => /automation|remote-debugging|disable-blink/.test(arg))).toBe(false);
  expect(f.calls.at(-1)).toBe("SIGTERM");
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
