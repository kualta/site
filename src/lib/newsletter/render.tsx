import { render } from "react-email";
import Newsletter from "../../emails/Newsletter";
import { origin, token } from "./security";
import type { Issue, NewsletterEnv } from "./types";

export async function unsubscribeUrl(env: NewsletterEnv, subscriberId: string): Promise<string> {
  if (!env.NEWSLETTER_TOKEN_SECRET || env.NEWSLETTER_TOKEN_SECRET.length < 32)
    throw new Error("Token secret not configured");
  return `${origin(env)}/newsletter/unsubscribe?token=${await token(
    env.NEWSLETTER_TOKEN_SECRET,
    "unsubscribe",
    subscriberId,
  )}`;
}
export async function renderIssue(issue: Issue, env: NewsletterEnv, subscriberId: string, deliveryId: string) {
  if (!env.NEWSLETTER_TOKEN_SECRET || env.NEWSLETTER_TOKEN_SECRET.length < 32)
    throw new Error("Token secret not configured");
  const unsubscribe = await unsubscribeUrl(env, subscriberId);
  const openToken = await token(env.NEWSLETTER_TOKEN_SECRET, "open", deliveryId);
  const clickToken = await token(env.NEWSLETTER_TOKEN_SECRET, "click", deliveryId);
  const html = await render(
    <Newsletter
      {...issue}
      articleUrl={`${origin(env)}/api/newsletter/click?token=${clickToken}`}
      unsubscribeUrl={unsubscribe}
      trackingPixelUrl={`${origin(env)}/api/newsletter/open?token=${openToken}`}
    />,
  );
  return { html, unsubscribe };
}
