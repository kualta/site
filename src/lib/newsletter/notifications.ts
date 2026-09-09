import type { NewsletterEnv } from "./types";

export type WaitUntil = (work: Promise<unknown>) => void;

export async function notifySubscription(
  env: NewsletterEnv,
  event: "subscribed" | "unsubscribed",
  email: string,
  waitUntil?: WaitUntil,
): Promise<void> {
  const webhook = env.NEWSLETTER_DISCORD_WEBHOOK_URL;
  if (!webhook) return;
  async function send(webhook: string) {
    try {
      const url = new URL(webhook);
      // Ask Discord to acknowledge that the message was saved.
      url.searchParams.set("wait", "true");
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `Newsletter ${event}: ${email}`, allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Discord rejected notification");
    } catch {
      // Never log credentials, provider responses, or subscriber addresses.
      console.error("newsletter_notification_failed", { provider: "discord", event });
    }
  }
  const work = send(webhook);
  if (waitUntil) waitUntil(work);
  else await work;
}
