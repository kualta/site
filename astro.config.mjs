import { defineConfig } from "astro/config";
import { loadEnv } from "vite";
import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import vercel from "@astrojs/vercel";

const SITE = "https://kualta.dev";
const PARAGRAPH_API = "https://api.paragraph.com/api/v1";
const env = { ...process.env, ...loadEnv(process.env.NODE_ENV ?? "production", process.cwd(), "PARAGRAPH_") };

async function fetchPostLastmod() {
  const key = env.PARAGRAPH_API_KEY;
  if (!key) return new Map();
  const slug = env.PARAGRAPH_PUBLICATION_SLUG || "kualta";
  try {
    const pubRes = await fetch(`${PARAGRAPH_API}/publications/slug/${slug}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!pubRes.ok) return new Map();
    const pub = await pubRes.json();
    const postsRes = await fetch(`${PARAGRAPH_API}/publications/${pub.id}/posts`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!postsRes.ok) return new Map();
    const data = await postsRes.json();
    const items = data.items ?? data;
    return new Map(
      items.map((p) => {
        const ts = p.updatedAt ?? p.publishedAt;
        return [p.slug, new Date(Number(ts)).toISOString()];
      }),
    );
  } catch {
    return new Map();
  }
}

const postLastmod = await fetchPostLastmod();

export default defineConfig({
  site: SITE,
  output: "static",
  adapter: vercel(),
  integrations: [
    react(),
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
      { protocol: "https", hostname: "storage.googleapis.com" },
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
