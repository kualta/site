import { createHash } from "node:crypto";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMdx from "remark-mdx";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { toString } from "mdast-util-to-string";
import { parse } from "yaml";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);
const writer = unified().use(remarkStringify).use(remarkGfm);
const alphabet = "234567abcdefghijklmnopqrstuvwxyz";

// Stable, valid 63-bit TID keys, independent of build time or mutable dates.
export function recordKey(identity) {
  let value = createHash("sha256").update(identity).digest().readBigUInt64BE() & 0x7fffffffffffffffn;
  let result = "";
  for (let i = 0; i < 13; i++) {
    result = alphabet[Number(value & 31n)] + result;
    value >>= 5n;
  }
  return result;
}

export function publicationUri(config) {
  return `at://${config.did}/site.standard.publication/${recordKey(config.url)}`;
}

export function documentUri(config, slug) {
  return `at://${config.did}/site.standard.document/${recordKey(`${config.url}/posts/${slug}/`)}`;
}

export function readArticle(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("Article needs YAML frontmatter");
  return { data: parse(match[1]), body: source.slice(match[0].length) };
}

function absoluteUrl(value, canonical) {
  const url = new URL(value, canonical);
  if (!["https:", "http:", "mailto:"].includes(url.protocol)) {
    throw new Error(`Unsupported article URL: ${value}`);
  }
  return url.href;
}

export function portableContent(body, canonical) {
  const tree = parser.parse(body);
  function convert(nodes) {
    return nodes.flatMap((node) => {
      if (node.type === "mdxjsEsm") return [];
      if (node.type === "mdxJsxFlowElement" && node.name === "Interactive") {
        const fallbacks = node.children.filter(
          (child) =>
            child.type === "mdxJsxFlowElement" &&
            child.name === "div" &&
            child.attributes.some((attr) => attr.name === "slot" && attr.value === "fallback"),
        );
        if (fallbacks.length !== 1 || !toString(fallbacks[0]).trim()) {
          throw new Error('Interactive needs one readable <div slot="fallback">');
        }
        return [
          ...convert(fallbacks[0].children),
          {
            type: "paragraph",
            children: [
              {
                type: "link",
                url: canonical,
                children: [{ type: "text", value: "Open the interactive version on kualta.dev." }],
              },
            ],
          },
        ];
      }
      if (node.type.startsWith("mdx") || node.type === "html") {
        throw new Error(
          `Unsupported ${node.name ?? node.type}: wrap interactive content in Interactive with a Markdown fallback`,
        );
      }
      if (node.url) node.url = absoluteUrl(node.url, canonical);
      if (node.children) node.children = convert(node.children);
      return [node];
    });
  }
  tree.children = convert(tree.children);
  const markdown = writer.stringify(tree);
  // Keep block boundaries, code, and image descriptions in the plain version.
  function plain(node) {
    if (node.type === "definition") return "";
    if (!node.children) return node.value ?? node.alt ?? "";
    const isBlock = ["root", "list", "listItem", "blockquote", "table", "tableRow"].includes(node.type);
    return node.children.map(plain).join(isBlock ? "\n\n" : "");
  }
  const textContent = plain(tree).trim();
  if (!textContent) throw new Error("Portable article is empty");
  return { markdown, textContent };
}

export function articleRecord(config, slug, source) {
  const { data, body } = readArticle(source);
  if (data.draft === true) return null;
  if (typeof data.title !== "string" || !data.title.trim()) throw new Error(`${slug}: missing title`);
  const path = `/posts/${slug}/`;
  const { markdown, textContent } = portableContent(body, `${config.url}${path}`);
  const publishedAt = new Date(data.publishedTime ?? data.date).toISOString();
  return {
    slug,
    uri: documentUri(config, slug),
    preview: data.preview || body.match(/!\[[^\]]*\]\(([^)]+)\)/)?.[1] || null,
    record: {
      $type: "site.standard.document",
      site: publicationUri(config),
      path,
      title: data.title,
      description: data.description ?? "",
      publishedAt,
      updatedAt: new Date(data.modifiedTime ?? publishedAt).toISOString(),
      tags: data.tags ?? [],
      textContent,
      content: { $type: "at.markpub.markdown", flavor: "gfm", text: { $type: "at.markpub.text", markdown } },
    },
  };
}
