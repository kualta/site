import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import vercel from "@astrojs/vercel";

const SITE = "https://kualta.dev";

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
          "/about": 0.6,
        };
        if (path in priorities) {
          item.priority = priorities[path];
        } else if (path.startsWith("/posts/")) {
          item.priority = 0.9;
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
