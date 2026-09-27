import type { APIRoute } from "astro";
import { blueskyClientMetadata } from "@/lib/bluesky/metadata";

export const prerender = false;
export const GET: APIRoute = ({ url }) =>
  new Response(JSON.stringify(blueskyClientMetadata(url.origin)), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
