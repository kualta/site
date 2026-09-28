import type { APIRoute } from "astro";
import { env, waitUntil } from "cloudflare:workers";
import { getGalleryPage } from "@/lib/gallery";
export const prerender = false;
export const GET: APIRoute = async ({ url }) => {
  const cursor = url.searchParams.get("cursor") || undefined;
  if (cursor && (cursor.length > 400 || /[\x00-\x1f]/.test(cursor)))
    return new Response("Invalid cursor", { status: 400 });
  try {
    const page = await getGalleryPage({ cursor, cache: env.ACTIVITY_CACHE, waitUntil });
    return Response.json(page, {
      headers: { "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=3600" },
    });
  } catch {
    return Response.json(
      { error: "The gallery is temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
};
