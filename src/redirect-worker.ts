import { canonicalRedirect, permanentRedirect } from "./lib/canonical-host";

// Serves the hosts in wrangler.redirect.jsonc instead of the site Worker, so a
// visit to kualta.com/links or www.kualta.dev/posts is sent to kualta.dev
// before any page or static file renders on the wrong host.
export default {
  fetch(request: Request): Response {
    const target = canonicalRedirect(new URL(request.url));
    // a canonical host routed here by mistake would otherwise redirect to itself
    if (!target) return new Response("Misdirected request", { status: 421 });
    return permanentRedirect(target);
  },
};
