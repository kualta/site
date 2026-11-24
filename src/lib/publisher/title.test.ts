import { expect, test } from "bun:test";
import { readPath, TAB_PATHS } from "./route";
import { tabTitle, wholePercent } from "./title";

test("the title names the open tab", () => {
  expect(["", ...TAB_PATHS].map((path) => tabTitle(readPath(`/${path}`).tab))).toEqual([
    "compose · kualta",
    "pipeline · kualta",
    "history · kualta",
    "calendar · kualta",
    "analytics · kualta",
    "footage · kualta",
    "footage · kualta",
    "grade · kualta",
    "accounts · kualta",
  ]);
});

test("an upload's percentage leads the title, from its start", () => {
  expect(tabTitle("footage", 43)).toBe("43% · footage · kualta");
  expect(tabTitle("grade", 0)).toBe("0% · grade · kualta");
  expect(tabTitle("grade", null)).toBe("grade · kualta");
});

test("a share becomes a whole percentage, 100 only at its end, and nothing else does", () => {
  expect([0, 0.004, 0.4376, 0.999, 1].map(wholePercent)).toEqual([0, 0, 43, 99, 100]);
  for (const value of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, "0.5", null, undefined, true, {}, [0.5]])
    expect(wholePercent(value)).toBeNull();
});
