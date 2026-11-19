import type { APIRoute } from "astro";
import { env, waitUntil } from "cloudflare:workers";
import { issueFormToken, subscribe } from "@/lib/newsletter";

export const prerender = false;
// The signup form fetches a token here before it posts.
export const GET: APIRoute = () => issueFormToken(env);
export const POST: APIRoute = ({ request }) => subscribe(request, env, waitUntil);
