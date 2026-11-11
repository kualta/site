import type { APIRoute } from "astro";
import metadata from "@/lib/publisher/oauth-client.json";

// The laptop publisher's client_id (scripts/publisher/oauth.mjs): Bluesky reads its signing key here.
export const prerender = false;
export const GET: APIRoute = () =>
  new Response(JSON.stringify(metadata), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
