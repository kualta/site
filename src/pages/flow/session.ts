import type { APIRoute } from "astro";
import { handleSessionRequest } from "@flow-industries/id/server";
import { flowOptions } from "@/lib/publisher/auth";
export const prerender = false;
export const ALL: APIRoute = ({ request, url }) => handleSessionRequest(request, flowOptions(url));
