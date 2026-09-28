import type { APIRoute } from "astro";
import { publisherSession } from "@/lib/publisher/auth";
export const prerender = false;
export const GET: APIRoute = async ({ request }) => {
  const { session, headers, allowed } = await publisherSession(request);
  return Response.json({ signedIn: Boolean(session.state), allowed }, { headers });
};
