const API_BASE = "https://api.paragraph.com/api/v1";

function getHeaders() {
  return {
    Authorization: `Bearer ${import.meta.env.PARAGRAPH_API_KEY}`,
  };
}

export interface ParagraphPost {
  id: string;
  title: string;
  subtitle: string;
  slug: string;
  publishedAt: string;
  updatedAt: string;
  imageUrl: string;
  categories: string[];
  markdown?: string;
  staticHtml?: string;
  json?: string;
}

let cachedPubId: string | undefined;
let cachedPosts: ParagraphPost[] | undefined;

async function getPublicationId(): Promise<string> {
  if (cachedPubId) return cachedPubId;
  const slug = import.meta.env.PARAGRAPH_PUBLICATION_SLUG || "kualta";
  const res = await fetch(`${API_BASE}/publications/slug/${slug}`, {
    headers: getHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Paragraph API error: ${res.status} ${res.statusText}`);
  }
  const pub = await res.json();
  cachedPubId = pub.id;
  return cachedPubId!;
}

export async function fetchPublicationPosts(): Promise<ParagraphPost[]> {
  if (cachedPosts) return cachedPosts;

  if (!import.meta.env.PARAGRAPH_API_KEY) {
    return [];
  }

  try {
    const pubId = await getPublicationId();
    const res = await fetch(
      `${API_BASE}/publications/${pubId}/posts?includeContent=true`,
      { headers: getHeaders() },
    );
    if (!res.ok) {
      throw new Error(`Paragraph API error: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    const items: ParagraphPost[] = data.items ?? data;
    cachedPosts = items.sort(
      (a, b) => Number(b.publishedAt) - Number(a.publishedAt),
    );
    return cachedPosts;
  } catch (err) {
    console.warn("[paragraph] fetchPublicationPosts failed:", err);
    return [];
  }
}

export async function fetchPostBySlug(
  postSlug: string,
): Promise<ParagraphPost | undefined> {
  const posts = await fetchPublicationPosts();
  return posts.find((p) => p.slug === postSlug);
}
