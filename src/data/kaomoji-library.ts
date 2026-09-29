import { kaomoji } from "./kaomoji";
import collected from "./kaomoji-collected.json";
import type { KaomojiIndex } from "@/lib/kaomoji-search";

const tags = [...collected.tags];
const tagIds = new Map(tags.map((tag, id) => [tag, id]));
const entries = new Map<string, Set<number>>();

function addEntry(text: string, labels: string[]): void {
  // NFC preserves the width and spacing that give each face its expression.
  const normalized = text.trim().normalize("NFC");
  const entryTags = entries.get(normalized) ?? new Set<number>();
  for (const label of labels) {
    let id = tagIds.get(label);
    if (id === undefined) {
      id = tags.length;
      tagIds.set(label, id);
      tags.push(label);
    }
    entryTags.add(id);
  }
  entries.set(normalized, entryTags);
}

for (const [category, faces] of Object.entries(kaomoji)) {
  for (const face of faces) addEntry(face, [category.replaceAll("_", " ")]);
}
for (const entry of collected.entries) {
  addEntry(entry.text, entry.tags.map((id) => collected.tags[id]));
}

export const kaomojiSearchIndex: KaomojiIndex = {
  tags,
  entries: [...entries].map(([text, ids]) => [text, [...ids]]),
};
export const allKaomoji = kaomojiSearchIndex.entries.map(([text]) => text);
export const KAOMOJI_PAGE_SIZE = 120;
