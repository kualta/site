/**
 * Farcaster has no media uploads: a cast embeds a URL, and clients decide how to show it from what the URL
 * looks like. Grove's URLs have no extension, so casts link here and this sends them on to the file.
 */
export function groveUrl(file: string): string | null {
  const key = file.match(/^([a-f0-9]{64})\.(?:jpg|m3u8)$/)?.[1];
  return key ? `https://api.grove.storage/${key}` : null;
}
