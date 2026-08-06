import { defineConfig } from "astro/config";
import { readFileSync, readdirSync } from "node:fs";
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import cloudflare from "@astrojs/cloudflare";

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

export default defineConfig({
  site: SITE,
  output: "static",
  adapter: cloudflare({ imageService: "compile" }),
  integrations: [
    react(),
    mdx(),
    tailwind({ applyBaseStyles: false }),
    sitemap({
      customPages: [
        "https://pomo.kualta.dev",
        "https://hemi.kualta.dev",
      ],
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
        } else if (path.startsWith("/posts/")) {
          item.priority = 0.9;
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
  image: {
    remotePatterns: [
      { protocol: "https", hostname: "picsum.photos" },
    ],
  },
  vite: {
    server: {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    },
  },
});
