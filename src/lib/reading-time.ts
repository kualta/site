/** about how long a post takes to read, at an unhurried 220 words a minute */
export function readingMinutes(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / 220));
}
