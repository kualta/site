import type { APIRoute } from "astro";
import { getPostsMetadata } from "@/lib/posts";

export const GET: APIRoute = async () => {
  const posts = await getPostsMetadata();
  const linkable = posts.map((post) => ({
    name: post.title,
    description: post.description,
    link: `https://kualta.dev/posts/${post.filename}`,
  }));
  return new Response(JSON.stringify(linkable), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
};
