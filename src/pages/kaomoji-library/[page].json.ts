import type { GetStaticPaths, APIRoute } from "astro";
import { allKaomoji, KAOMOJI_PAGE_SIZE } from "@/data/kaomoji-library";

export const getStaticPaths: GetStaticPaths = () => {
  return Array.from({ length: Math.ceil(allKaomoji.length / KAOMOJI_PAGE_SIZE) }, (_, index) => ({
    params: { page: String(index + 1) },
    props: { entries: allKaomoji.slice(index * KAOMOJI_PAGE_SIZE, (index + 1) * KAOMOJI_PAGE_SIZE) },
  }));
};

export const GET: APIRoute = ({ props }) => {
  return new Response(JSON.stringify(props.entries), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
