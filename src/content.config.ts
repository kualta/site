import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const posts = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/posts" }),
  schema: z.object({
    title: z.string(),
    description: z.string().default(""),
    date: z.string(),
    // written by the importer; hand-written posts fall back to `date`
    publishedTime: z.string().optional(),
    modifiedTime: z.string().optional(),
    tags: z.array(z.string()).default([]),
    preview: z.string().default(""),
    draft: z.boolean().default(false),
  }),
});

export const collections = { posts };
