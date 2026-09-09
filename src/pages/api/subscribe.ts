import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { subscribe } from "@/lib/newsletter";

export const prerender = false;
export const POST: APIRoute = ({ request }) => subscribe(request, env);
