import type { APIRoute } from "astro";
import { kaomojiSearchIndex } from "@/data/kaomoji-library";

export const GET: APIRoute = () => {
  return new Response(JSON.stringify(kaomojiSearchIndex), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
