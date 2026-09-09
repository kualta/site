import { defineMiddleware } from "astro:middleware";
import { forbiddenFormOrigin } from "@/lib/request-origin";

const CANONICAL_HOST = "kualta.dev";

// Subdomains that map to a specific path on the canonical host.
const subdomainRedirects: Record<string, string> = {
  moji: "/kaomoji",
  blog: "/posts",
  post: "/posts",
  join: "/join",
};

// Hosts that redirect to the canonical apex while preserving the request path.
const aliasHosts = new Set([
  "www.kualta.dev",
  "kualta.com",
  "www.kualta.com",
]);

export const onRequest = defineMiddleware((ctx, next) => {
  if (ctx.isPrerendered) return next();
  if (forbiddenFormOrigin(ctx.request)) return new Response("Cross-site form submissions are forbidden", { status: 403 });

  const hostname = (ctx.request.headers.get("host") ?? "").toLowerCase();

  if (aliasHosts.has(hostname)) {
    const target = `https://${CANONICAL_HOST}${ctx.url.pathname}${ctx.url.search}`;
    return Response.redirect(target, 301);
  }

  // permanent: these subdomains have no content of their own and never will,
  // so the destination is the one that should hold the ranking
  for (const key in subdomainRedirects) {
    if (hostname.startsWith(`${key}.`)) {
      return Response.redirect(`https://${CANONICAL_HOST}${subdomainRedirects[key]}`, 301);
    }
  }

  return next();
});
