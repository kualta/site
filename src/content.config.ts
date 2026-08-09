import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const posts = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/posts" }),
  schema: z.object({
    title: z.string(),
    /** the subtitle printed under the title: a few words, not a summary */
    description: z.string().default(""),
    /** what search results and the feed show; falls back to the opening lines */
    summary: z.string().optional(),
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
