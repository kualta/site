import type { NewsletterEnv } from "./types";

const encoder = new TextEncoder();
export async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
function hex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function sign(secret: string, purpose: string, id: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${purpose}:${id}`)));
}
export function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
export async function token(secret: string, purpose: string, id: string): Promise<string> {
  return `${id}.${await sign(secret, purpose, id)}`;
}
export async function verifyToken(secret: string, purpose: string, value: string): Promise<string | null> {
  if (!/^[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(value)) return null;
  const [id, signature] = value.split(".");
  return equal(signature, await sign(secret, purpose, id)) ? id : null;
}
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
export function origin(env: NewsletterEnv): string {
  return env.NEWSLETTER_ORIGIN || "https://kualta.dev";
}
export function authorized(request: Request, secret: string | undefined): boolean {
  return !!secret && secret.length >= 32 && equal(request.headers.get("Authorization") || "", `Bearer ${secret}`);
}
export function json(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
export async function readJson(request: Request, maxBytes = 32768): Promise<unknown> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) throw new Error("JSON required");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Body required");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("Body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Object required");
  return value as Record<string, unknown>;
}
