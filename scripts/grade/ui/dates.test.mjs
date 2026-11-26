import { expect, test } from "bun:test";
import { dayLabel } from "./dates.mjs";

test("a shoot day is its date and month, with its year when that isn't this one", () => {
  const now = new Date(2026, 10, 25).getTime();
  expect(dayLabel("2026-11-24", now)).toBe("24 Nov");
  expect(dayLabel("2026-01-01", now)).toBe("1 Jan");
  expect(dayLabel("2026-09-08", now)).toBe("8 Sep");
  expect(dayLabel("2025-12-30", now)).toBe("30 Dec 2025");
  expect(dayLabel("2027-02-03", now)).toBe("3 Feb 2027");
  // What isn't a day is said as it is.
  for (const other of ["", "Others", "2026-11-24T10:00:00", null]) expect(dayLabel(other, now)).toBe(other);
});
