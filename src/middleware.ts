import { defineMiddleware } from "astro:middleware";
import { canonicalRedirect, permanentRedirect } from "@/lib/canonical-host";
import { forbiddenFormOrigin } from "@/lib/request-origin";

export const onRequest = defineMiddleware((ctx, next) => {
  if (ctx.isPrerendered) return next();
  if (forbiddenFormOrigin(ctx.request))
    return new Response("Cross-site form submissions are forbidden", { status: 403 });

  // the redirect Worker (wrangler.redirect.jsonc) answers these hosts before
  // the site runs; this only catches one attached to the site Worker by mistake
  const canonical = canonicalRedirect(ctx.url);
  if (canonical) return permanentRedirect(canonical);

  const hostname = (ctx.request.headers.get("host") ?? "").toLowerCase();
  const publisherTab = ctx.url.pathname.match(/^\/publish(\/(?:history|calendar|analytics))?$/);
  if (!import.meta.env.DEV && hostname === "kualta.dev" && publisherTab)
    return Response.redirect(`https://post.kualta.dev${publisherTab[1] ?? "/"}${ctx.url.search}`, 302);
  // src/pages/history.astro, calendar.astro and analytics.astro give those paths a route here; on other hosts
  // they're a 404.
  if (hostname === "post.kualta.dev" && ["/", "/history", "/calendar", "/analytics"].includes(ctx.url.pathname))
    return ctx.rewrite(ctx.url.pathname === "/" ? "/publish" : `/publish${ctx.url.pathname}`);

  return next();
});
