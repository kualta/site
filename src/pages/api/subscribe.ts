import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async ({ url, locals }) => {
  const email = url.searchParams.get("email");

  if (!email) {
    return new Response(JSON.stringify({ error: "Email is required", status: 400 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = locals.runtime?.env.PARAGRAPH_API_KEY ?? import.meta.env.PARAGRAPH_API_KEY;

  try {
    const res = await fetch("https://api.paragraph.com/api/v1/subscribers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ email }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("Paragraph API error:", data);
      return new Response(JSON.stringify({ error: "Subscription failed", status: res.status }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ message: "Subscribed successfully", status: 200 }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error subscribing:", error);
    return new Response(JSON.stringify({ error: "Connection error", status: 500 }), {
      headers: { "Content-Type": "application/json" },
    });
  }
};
