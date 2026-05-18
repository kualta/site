import type { APIRoute } from "astro";
import type { Project } from "@/types";
import projectsData from "@/data/projects.json";

export const GET: APIRoute = () => {
  const sorted = [...(projectsData as Project[])].sort(
    (a, b) => (b.relevance || 0) - (a.relevance || 0),
  );
  return new Response(JSON.stringify(sorted), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
};
