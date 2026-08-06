import type { APIRoute } from "astro";
import type { Track } from "@/types";
import musicData from "@/data/music.json";

export const GET: APIRoute = () => {
  const sorted = [...(musicData as Track[])].sort((a, b) => b.date.localeCompare(a.date));
  return new Response(JSON.stringify(sorted), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
};
