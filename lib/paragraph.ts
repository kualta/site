const API_BASE = "https://api.paragraph.com/api/v1";

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.PARAGRAPH_API_KEY}`,
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

async function getPublicationId(): Promise<string> {
  const slug = process.env.PARAGRAPH_PUBLICATION_SLUG;
  const res = await fetch(`${API_BASE}/publications/slug/${slug}`, {
    headers: getHeaders(),
    next: { revalidate: 86400 },
  });
  if (!res.ok) {
    throw new Error(`Paragraph API error: ${res.status} ${res.statusText}`);
  }
  const pub = await res.json();
  return pub.id;
}

export async function fetchPublicationPosts(): Promise<ParagraphPost[]> {
  const pubId = await getPublicationId();
  const res = await fetch(
    `${API_BASE}/publications/${pubId}/posts?includeContent=true`,
    {
      headers: getHeaders(),
      next: { revalidate: 3600 },
    },
  );
  if (!res.ok) {
    throw new Error(`Paragraph API error: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const items: ParagraphPost[] = data.items ?? data;

  return items.sort(
    (a, b) => Number(b.publishedAt) - Number(a.publishedAt),
  );
}

export async function fetchPostBySlug(
  postSlug: string,
): Promise<ParagraphPost> {
  // Fetch all posts and find by slug, since the slug-based endpoint is unreliable
  const posts = await fetchPublicationPosts();
  const post = posts.find((p) => p.slug === postSlug);
  if (!post) {
    throw new Error(`Post not found: ${postSlug}`);
  }
  return post;
}
