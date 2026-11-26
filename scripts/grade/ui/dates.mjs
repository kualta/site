// Days as the grade app shows them, the same whatever the browser's language: "24 Nov", as in Britain. Shoot days stay
// ISO (2026-11-24) in ids, data and file names; they're only ever shown like this. The server says them so too.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A shoot day, `2026-11-24`: "24 Nov", with its year when it isn't this one ("24 Nov 2025"), `now` saying when this is.
 * Anything that isn't a day is said as it is.
 */
export function dayLabel(day, now = Date.now()) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? "");
  if (!iso) return day;
  const [year, month, date] = iso.slice(1).map(Number);
  return `${date} ${MONTHS[month - 1]}${year === new Date(now).getFullYear() ? "" : ` ${year}`}`;
}
