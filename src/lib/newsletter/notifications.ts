import type { NewsletterEnv } from "./types";

export type WaitUntil = (work: Promise<unknown>) => void;

export async function notifyNewsletter(
  env: NewsletterEnv,
  event: "subscribed" | "unsubscribed" | "open detected",
  detail: string,
  waitUntil?: WaitUntil,
): Promise<void> {
  const webhook = env.NEWSLETTER_DISCORD_WEBHOOK_URL;
  if (!webhook) return;
  async function send(webhook: string) {
    let failure = "transport";
    try {
      const url = new URL(webhook);
      // Ask Discord to acknowledge that the message was saved.
      url.searchParams.set("wait", "true");
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "DiscordBot (https://kualta.dev, 1.0)",
        },
        body: JSON.stringify({
          content: event === "open detected" ? detail : `Newsletter ${event}: ${detail}`,
          allowed_mentions: { parse: [] },
        }),
        signal: AbortSignal.timeout(5000),
        redirect: "manual",
      });
      failure = `http_${response.status}`;
      if (!response.ok) throw new Error("Discord rejected notification");
      failure = "invalid_acknowledgement";
      const message = (await response.json()) as { id?: string };
      if (!message.id) throw new Error("Discord did not acknowledge the message");
      console.info("newsletter_notification_sent", { provider: "discord", event, messageId: message.id });
    } catch {
      // Never log credentials, provider responses, or subscriber addresses.
      console.error("newsletter_notification_failed", { provider: "discord", event, failure });
    }
  }
  const work = send(webhook);
  if (waitUntil) waitUntil(work);
  else await work;
}
