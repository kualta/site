import getPostsMetadata from "@/components/PostMetadata";
import { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const postMetadata = getPostsMetadata();
  const posts: MetadataRoute.Sitemap = postMetadata.map((post) => ({
    url: `https://kualta.dev/posts/${post.filename}`,
    lastModified: new Date(post.date),
    changeFrequency: "weekly",
    priority: 0.9,
  }));

  return [
    {
      url: "https://kualta.dev",
      lastModified: new Date(),
      changeFrequency: "yearly",
      priority: 1,
    },
    {
      url: "https://kualta.dev/posts",
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: "https://kualta.dev/projects",
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: "https://pomo.kualta.dev",
      lastModified: new Date(),
      changeFrequency: "yearly",
      priority: 0.8,
    },
    {
      url: "https://hemi.kualta.dev",
      lastModified: new Date(),
      changeFrequency: "yearly",
      priority: 0.8,
    },
    {
      url: "https://kualta.dev/join",
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: "https://kualta.dev/gallery",
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: "https://kualta.dev/pics",
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: "https://kualta.dev/kaomoji",
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: "https://kualta.dev/contacts",
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.8,
    },
    ...posts,
  ];
}
