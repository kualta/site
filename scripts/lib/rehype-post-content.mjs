/**
 * Two fixes applied to every post body as it is rendered.
 *
 * Headings: the page already prints the title as `h1`, but the posts imported
 * from Paragraph carry `h1` section headings of their own (setext `====`), and
 * the hand-written ones start at `h3`. Neither outline is sequential. Each
 * document is shifted so its own top level lands on `h2`, which leaves the
 * relative structure alone and the ids untouched.
 *
 * Images: markdown gives an `img` no dimensions, so the article reflows as each
 * one arrives. The files sit in `public/`, so their size is read off disk here
 * and written onto the tag. The first image is the one in view on load, so it
 * loads eagerly and the rest wait.
 */
import path from "node:path";
import { imageSize } from "./image-size.mjs";

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

export function rehypePostContent({ root = process.cwd() } = {}) {
  const publicDir = path.join(root, "public");

  return () => (tree) => {
    const headings = [];
    const images = [];

    walk(tree, (node) => {
      if (node.type !== "element") return;
      if (HEADINGS.has(node.tagName)) headings.push(node);
      if (node.tagName === "img") images.push(node);
    });

    if (headings.length > 0) {
      const top = Math.min(...headings.map((node) => Number(node.tagName[1])));
      const shift = 2 - top;
      if (shift !== 0) {
        for (const node of headings) {
          const depth = Math.min(6, Math.max(2, Number(node.tagName[1]) + shift));
          node.tagName = `h${depth}`;
        }
      }
    }

    for (const [index, node] of images.entries()) {
      const source = node.properties?.src;
      if (typeof source !== "string" || !source.startsWith("/")) continue;

      const size = imageSize(path.join(publicDir, decodeURIComponent(source)));
      if (size) {
        node.properties.width = size.width;
        node.properties.height = size.height;
      }

      // the lead image is the largest thing above the fold on a post page
      if (index === 0) {
        node.properties.loading = "eager";
        node.properties.fetchpriority = "high";
      } else {
        node.properties.loading = "lazy";
      }
      node.properties.decoding = "async";
    }
  };
}
