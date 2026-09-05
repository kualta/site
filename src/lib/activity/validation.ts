export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

export function stringField(record: UnknownRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function recordField(record: UnknownRecord | undefined, key: string): UnknownRecord | undefined {
  return asRecord(record?.[key]);
}

export function safeDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}
