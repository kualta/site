import { defineMiddleware } from "astro:middleware";
import { canonicalRedirect, permanentRedirect } from "@/lib/canonical-host";
import { TAB_PATHS } from "@/lib/publisher/route";
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
  // /publish and its tabs' paths, such as /publish/history, belong on post.kualta.dev.
  const publish = ctx.url.pathname.match(/^\/publish(\/[a-z]+)?$/);
  const publisherTab = publish && (!publish[1] || TAB_PATHS.includes(publish[1].slice(1)));
  if (!import.meta.env.DEV && hostname === "kualta.dev" && publisherTab)
    return Response.redirect(`https://post.kualta.dev${publish[1] ?? "/"}${ctx.url.search}`, 302);
  // src/pages/history.astro and the other tabs' pages give those paths a route here; on other hosts they're a 404.
  if (hostname === "post.kualta.dev" && (ctx.url.pathname === "/" || TAB_PATHS.includes(ctx.url.pathname.slice(1))))
    return ctx.rewrite(ctx.url.pathname === "/" ? "/publish" : `/publish${ctx.url.pathname}`);

  return next();
});
