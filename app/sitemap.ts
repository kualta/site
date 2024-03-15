import getPostsMetadata from "@/components/PostMetadata";
import { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const postMetadata = getPostsMetadata();
  const posts: MetadataRoute.Sitemap = postMetadata.map((post) => ({
    url: `https://kualta.dev/posts/${post.filename}`,
  }));

  return [
    {
      url: "https://kualta.dev",
      priority: 1,
    },
    {
      url: "https://kualta.dev/posts",
      priority: 0.9,
    },
    {
      url: "https://kualta.dev/projects",
      priority: 0.8,
    },
    {
      url: "https://pomo.kualta.dev",
    },
    {
      url: "https://hemi.kualta.dev",
    },
    {
      url: "https://kualta.dev/join",
      priority: 0.7,
    },
    {
      url: "https://kualta.dev/gallery",
    },
    {
      url: "https://kualta.dev/pics",
    },
    {
      url: "https://kualta.dev/kaomoji",
    },
    {
      url: "https://kualta.dev/contacts",
    },
    ...posts,
  ];
}
