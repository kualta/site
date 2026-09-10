import { expect, test } from "bun:test";
import { forbiddenFormOrigin } from "./request-origin";
function request(path: string, origin?: string, type = "application/x-www-form-urlencoded") {
  const headers: Record<string, string> = { "Content-Type": type };
  if (origin) headers.Origin = origin;
  return new Request(`https://kualta.dev${path}`, { method: "POST", headers });
}
test("only the exact originless mail-client unsubscribe route is exempt", () => {
  expect(forbiddenFormOrigin(request("/newsletter/unsubscribe"))).toBe(false);
  expect(forbiddenFormOrigin(request("/newsletter/unsubscribe", "https://evil.example"))).toBe(true);
  expect(forbiddenFormOrigin(request("/newsletter/unsubscribe/"))).toBe(true);
  expect(forbiddenFormOrigin(request("/newsletter/confirm"))).toBe(true);
  expect(forbiddenFormOrigin(request("/other"))).toBe(true);
  expect(forbiddenFormOrigin(request("/other", "https://kualta.dev"))).toBe(false);
  expect(forbiddenFormOrigin(request("/other", undefined, "text/plain"))).toBe(true);
  expect(forbiddenFormOrigin(new Request("https://kualta.dev/other", { method: "POST" }))).toBe(true);
  expect(forbiddenFormOrigin(new Request("https://kualta.dev/other"))).toBe(false);
  expect(forbiddenFormOrigin(request("/api/newsletter/admin", undefined, "application/json"))).toBe(false);
});
