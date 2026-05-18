import { defineMiddleware } from "astro:middleware";

const redirects: Record<string, string> = {
  moji: "https://kualta.dev/kaomoji",
  blog: "https://kualta.dev/posts",
  post: "https://kualta.dev/posts",
  join: "https://kualta.dev/join",
};

export const onRequest = defineMiddleware((ctx, next) => {
  if (ctx.isPrerendered) return next();

  const hostname = ctx.request.headers.get("host") ?? "";
  for (const key in redirects) {
    if (hostname.startsWith(`${key}.`)) {
      return Response.redirect(redirects[key], 302);
    }
  }
  return next();
});
