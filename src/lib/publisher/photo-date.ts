/** Show capture times in the browser's local timezone, including EXIF offsets. */
export function localDateTime(date: Date): string {
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}
export function exifDateTime(original: unknown, offset: unknown): string {
  if (typeof original !== "string") return "";
  const match = original.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})$/);
  if (!match) return "";
  const wallTime = `${match[1]}-${match[2]}-${match[3]}T${match[4]}`;
  const zone = typeof offset === "string" && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : "";
  return localDateTime(new Date(wallTime + zone));
}
