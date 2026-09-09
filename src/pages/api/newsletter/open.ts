import type { APIRoute } from "astro";
import { env, waitUntil } from "cloudflare:workers";
import { track } from "@/lib/newsletter/tracking";
export const prerender = false;
export const GET: APIRoute = ({ request }) => track(request, env, "open", waitUntil);
