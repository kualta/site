const api = "https://api.plyr.fm";

export async function syncMusicArtwork(items, did, {
  token,
  verifyOnly = false,
  fetcher = fetch,
  log = console.log,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  async function request(path, options = {}) {
    const response = await fetcher(`${api}${path}`, { ...options, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`plyr.fm ${path}: HTTP ${response.status}`);
    return response.json();
  }
  const headers = { Authorization: `Bearer ${token}` };
  if (!verifyOnly) {
    if (!token) throw new Error("Set PLYR_TOKEN to sync music artwork");
    if ((await request("/auth/me", { headers })).did !== did) throw new Error("Artwork publishing identity mismatch");
  }
  for (const item of items) {
    const source = item.record.description.split("\n")[0];
    let track;
    for (let attempt = 0; attempt < 12; attempt++) {
      const matches = [];
      let cursor;
      do {
        const query = new URLSearchParams({ artist_did: did, limit: "100" });
        if (cursor) query.set("cursor", cursor);
        const page = await request(`/tracks/?${query}`);
        matches.push(...page.tracks.filter((entry) => entry.description?.split("\n")[0] === source));
        cursor = page.has_more ? page.next_cursor : null;
      } while (cursor);
      if (matches.length > 1) throw new Error(`Duplicate indexed music: ${item.slug}`);
      track = matches[0];
      if (track || verifyOnly) break;
      await wait(5_000);
    }
    if (!track || !track.atproto_record_uri?.startsWith(`at://${did}/fm.plyr.track/`))
      throw new Error(`Music not indexed for artist: ${item.slug}`);
    async function artworkMatches(url) {
      if (!url || new URL(url).protocol !== "https:") return false;
      const response = await fetcher(url, { signal: AbortSignal.timeout(60_000) });
      return response.ok && Buffer.from(await response.arrayBuffer()).equals(item.artwork);
    }
    if (!(await artworkMatches(track.image_url))) {
      if (verifyOnly) throw new Error(`Indexed artwork differs: ${item.slug}`);
      const body = new FormData();
      body.set("image", new Blob([item.artwork], { type: "image/jpeg" }), `${item.slug}.jpg`);
      await request(`/tracks/${track.id}`, { method: "PATCH", headers, body });
      track = await request(`/tracks/${track.id}`);
      if (!(await artworkMatches(track.image_url))) throw new Error(`Artwork readback mismatch: ${item.slug}`);
    }
    item.record.imageUrl = track.image_url;
    log(`Verified indexed artwork ${item.slug}: ${track.image_url}`);
  }
}
