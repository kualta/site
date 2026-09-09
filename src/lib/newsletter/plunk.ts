import type { EmailSender } from "./types";

export class SendError extends Error {
  constructor(public code: string, public uncertain: boolean) {
    super(code);
  }
}
// The only delivery-provider-specific send code. D1 owns consent and suppression.
export function plunkSender(
  secret: string,
  transport: (url: string, options: RequestInit) => Promise<Response> = fetch,
): EmailSender {
  return async (email) => {
    let response: Response;
    try {
      response = await transport("https://next-api.useplunk.com/v1/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
          "Idempotency-Key": email.idempotencyKey,
        },
        body: JSON.stringify({
          to: email.to,
          from: { name: "kualta", email: "contact@kualta.dev" },
          reply: "contact@kualta.dev",
          subject: email.subject,
          body: email.html,
          // Do not mutate Plunk's subscription status when sending.
          headers: email.unsubscribeUrl
            ? {
                "List-Unsubscribe": `<${email.unsubscribeUrl}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              }
            : undefined,
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new SendError("transport", true);
    }
    if (!response.ok) throw new SendError(`http_${response.status}`, response.status >= 500 || response.status === 409);
    try {
      const body = (await response.json()) as { success?: boolean; data?: { emails?: { email?: string }[] } };
      const id = body.data?.emails?.[0]?.email;
      if (body.success !== true || body.data?.emails?.length !== 1 || !id) throw new Error("Invalid response");
      return id;
    } catch {
      throw new SendError("invalid_response", true);
    }
  };
}
