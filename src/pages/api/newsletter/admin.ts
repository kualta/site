import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { admin } from "@/lib/newsletter/admin";
export const prerender = false;
export const GET: APIRoute = ({ request }) => admin(request, env);
export const POST: APIRoute = ({ request }) => admin(request, env);
