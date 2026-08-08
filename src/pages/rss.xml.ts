import type { APIRoute } from "astro";
import { getPostsMetadata } from "@/lib/posts";
import { SITE_NAME, SITE_URL, TAGLINE } from "@/lib/seo";

/**
 * The blog had no feed, so the only way to follow it was the mailing list.
 * Hand-rolled rather than pulled from a package: the whole document is six
 * elements and readers are strict about exactly those six.
 */
const esc = (text: string) =>
  text.replace(
    /[<>&'"]/g,
    (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[character] as string,
  );

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

export const GET: APIRoute = async ({ site }) => {
  const base = (site?.toString() ?? `${SITE_URL}/`).replace(/\/$/, "");
  const posts = await getPostsMetadata();

  const items = posts
    .map((post) => {
      const link = `${base}/posts/${post.filename}/`;
      // media:content rather than enclosure: the spec wants a byte length on an
      // enclosure and there is none to hand at build time
      const type = MIME[post.preview.split(".").pop()?.toLowerCase() ?? ""];
      const media =
        post.preview && type
          ? [`      <media:content url="${esc(`${base}${post.preview}`)}" medium="image" type="${type}" />`]
          : [];

      return [
        "    <item>",
        `      <title>${esc(post.title)}</title>`,
        `      <link>${esc(link)}</link>`,
        `      <guid isPermaLink="true">${esc(link)}</guid>`,
        `      <description>${esc(post.summary)}</description>`,
        `      <pubDate>${new Date(post.publishedTime).toUTCString()}</pubDate>`,
        ...post.tags.map((tag) => `      <category>${esc(tag)}</category>`),
        ...media,
        "    </item>",
      ].join("\n");
    })
    .join("\n");

  const newest = posts[0]?.modifiedTime ?? new Date().toISOString();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${esc(`${SITE_NAME} — posts`)}</title>
    <link>${esc(`${base}/posts/`)}</link>
    <description>${esc(`Essays by ${SITE_NAME} — ${TAGLINE}.`)}</description>
    <language>en-us</language>
    <lastBuildDate>${new Date(newest).toUTCString()}</lastBuildDate>
    <atom:link href="${esc(`${base}/rss.xml`)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
