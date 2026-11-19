import { FORM_TOKEN_MAX_AGE_MS, FORM_TOKEN_MIN_AGE_MS } from "./form-age";
import { equal, json, sign } from "./security";
import type { NewsletterEnv } from "./types";

// The signup form fetches one of these from GET /api/subscribe before it posts.
// Scripts that only POST an address never have one.
export async function formToken(secret: string, issuedAt = Date.now()): Promise<string> {
  const id = `${issuedAt}.${crypto.randomUUID()}`;
  return `${id}.${await sign(secret, "signup-form", id)}`;
}

export async function issueFormToken(env: NewsletterEnv): Promise<Response> {
  const secret = env.NEWSLETTER_TOKEN_SECRET;
  if (!secret || secret.length < 32)
    return json(503, { message: "Signup is temporarily unavailable. Please try again later." });
  return json(200, { token: await formToken(secret) });
}

export type FormTokenProblem = "token_missing" | "token_invalid" | "token_early" | "token_expired";

/** The token's id and expiry (seconds) when it's genuine and old enough, or what's wrong with it. */
export async function readFormToken(
  secret: string,
  value: unknown,
  now = Date.now(),
): Promise<{ id: string; expiresAt: number } | FormTokenProblem> {
  if (!value) return "token_missing";
  const match = typeof value === "string" ? /^(\d{13})\.([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(value) : null;
  if (!match) return "token_invalid";
  const id = `${match[1]}.${match[2]}`;
  if (!equal(match[3], await sign(secret, "signup-form", id))) return "token_invalid";
  const issuedAt = Number(match[1]);
  if (now - issuedAt < FORM_TOKEN_MIN_AGE_MS) return "token_early";
  if (now - issuedAt > FORM_TOKEN_MAX_AGE_MS) return "token_expired";
  return { id, expiresAt: Math.ceil((issuedAt + FORM_TOKEN_MAX_AGE_MS) / 1000) };
}
