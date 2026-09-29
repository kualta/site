export interface KaomojiIndex {
  tags: string[];
  entries: [text: string, tagIds: number[]][];
}

export function searchKaomoji(index: KaomojiIndex, query: string): string[] {
  const terms = query.normalize("NFKC").toLowerCase().trim().split(/\s+/).filter(Boolean);
  const tagWords = index.tags.map((tag) =>
    tag
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}\p{M}]+/u),
  );
  const matchingTags = terms.map(
    (term) => new Set(tagWords.flatMap((words, id) => (words.some((word) => word.startsWith(term)) ? [id] : []))),
  );
  return index.entries
    .filter(([text, tags]) => {
      const normalized = text.normalize("NFKC").toLowerCase();
      return terms.every((term, i) => normalized.includes(term) || tags.some((tag) => matchingTags[i].has(tag)));
    })
    .map(([text]) => text);
}
