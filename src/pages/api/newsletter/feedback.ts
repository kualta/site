import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { feedback } from "@/lib/newsletter/feedback";
export const prerender = false;
export const POST: APIRoute = ({ request }) => feedback(request, env);

export const GET: APIRoute = ({ request }) => feedback(request, env);
