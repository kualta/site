import type { APIRoute } from "astro";
import { groveUrl } from "@/lib/publisher/media-link";
export const prerender = false;

const redirect: APIRoute = ({ params }) => {
  const target = groveUrl(params.file ?? "");
  if (!target) return new Response("Not found", { status: 404 });
  return new Response(null, {
    status: 302,
    headers: {
      Location: target,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
    },
  });
};
export const GET = redirect;
export const HEAD = redirect;
