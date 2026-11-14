import { defineConfig } from "astro/config";
import { readFileSync, readdirSync } from "node:fs";
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";
import cloudflare from "@astrojs/cloudflare";
import { buildImageManifest } from "./scripts/lib/image-manifest.mjs";
import { rehypePostContent } from "./scripts/lib/rehype-post-content.mjs";

const SITE = "https://kualta.dev";
const POSTS_DIR = "./src/content/posts";

/** last edit per post, read from frontmatter so the sitemap needs no network */
function readPostLastmod() {
  const entries = new Map();
  for (const file of readdirSync(POSTS_DIR)) {
    if (!/\.mdx?$/.test(file)) continue;
    const source = readFileSync(`${POSTS_DIR}/${file}`, "utf8");
    const stamp = source.match(/^(?:modifiedTime|publishedTime|date):\s*"?([^"\n]+)"?/m);
    if (stamp) entries.set(file.replace(/\.mdx?$/, ""), new Date(stamp[1]).toISOString());
  }
  return entries;
}

const postLastmod = readPostLastmod();

// every @flow-industries/ui component the site imports, so the optimizer bundles
// them in its first pass rather than discovering them one page at a time
const FLOW_UI_ENTRIES = ["badge", "button", "input", "item", "toggle", "tooltip"].map(
  (name) => `@flow-industries/ui/components/${name}`,
);

// sizes for every file in public/, so the layout can declare real og:image
// dimensions without reading the disk at request time
buildImageManifest();

export default defineConfig({
  site: SITE,
  output: "static",
  // pairs with html_handling in wrangler.jsonc, which serves /links and
  // redirects /links/ to it
  trailingSlash: "never",
  // The equivalent origin guard lives in middleware, with a signed RFC 8058
  // unsubscribe exception for mail clients that do not send an Origin header.
  security: { checkOrigin: false },
  adapter: cloudflare({ imageService: "compile" }),
  integrations: [
    react(),
    mdx(),
    sitemap({
      customPages: [
        "https://pomo.kualta.dev",
        "https://hemi.kualta.dev",
      ],
      // robots.txt disallows /api/, so listing it here only earns a
      // "blocked by robots.txt" report in Search Console
      filter: (page) => !["/api", "/newsletter/", "/auth/", "/publish", "/history", "/analytics", "/calendar", "/accounts", "/flow/", "/links", "/socials"].some(path => page.startsWith(`${SITE}${path}`)),
      serialize(item) {
        const path = item.url.replace(SITE, "").replace(/\/$/, "") || "/";
        const priorities = {
          "/": 1,
          "/posts": 0.9,
          "/projects": 0.8,
          "/music": 0.8,
          "/join": 0.7,
        };
        if (path in priorities) {
          item.priority = priorities[path];
        } else if (path.startsWith("/posts/tags/")) {
          // listings of posts already reachable from /posts
          item.priority = 0.4;
        } else if (path.startsWith("/posts/")) {
          item.priority = 0.9;
        } else if (path.startsWith("/music/")) {
          item.priority = 0.6;
        }
        const postMatch = path.match(/^\/posts\/([^/]+)$/);
        if (postMatch) {
          const lastmod = postLastmod.get(postMatch[1]);
          if (lastmod) item.lastmod = lastmod;
        }
        return item;
      },
    }),
  ],
  markdown: {
    rehypePlugins: [rehypePostContent({ root: process.cwd() })],
  },
  image: {
    remotePatterns: [
      { protocol: "https", hostname: "picsum.photos" },
    ],
  },
  vite: {
    optimizeDeps: { exclude: ["@ffmpeg/ffmpeg"], include: ["lucide-react", ...FLOW_UI_ENTRIES] },
    plugins: [
      tailwindcss(),
      {
        // This package ships Astro source. Cloudflare's SSR optimizer would
        // otherwise treat its `.astro` component as plain JavaScript.
        name: "exclude-astro-embed-source-from-optimizer",
        configEnvironment(environmentName) {
          if (!["astro", "ssr", "prerender"].includes(environmentName)) return;
          return {
            optimizeDeps: {
              exclude: ["@astro-community/astro-embed-bluesky"],
              // Prebundle the renderer helper and content schema before workerd
              // loads React, avoiding a second React instance during discovery.
              // Flow UI ships source, and Base UI's store is CommonJS, which workerd
              // cannot load unbundled; found late, either would re-run the optimizer
              // mid-session and load React twice.
              include: [
                "picomatch",
                "astro/zod",
                "react-icons/ri",
                "lucide-react",
                ...FLOW_UI_ENTRIES,
                "use-sync-external-store/shim",
                "use-sync-external-store/shim/with-selector",
                // the post pages' markdown pipeline, found on the first post visited
                "unified",
                "remark-parse",
                "remark-mdx",
                "remark-gfm",
                "remark-stringify",
                "mdast-util-to-string",
                "yaml",
              ],
            },
          };
        },
      },
    ],
    server: {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    },
  },
});
