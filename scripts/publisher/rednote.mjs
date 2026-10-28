// Notes are managed in the creator center: a note's public page can't delete it, and on RedNote it shows
// "not available" on the web. The note manager lists every note as a card with its counts.

/** The creator center that manages a note, from the note's public link. */
export function creatorOrigin(noteUrl) {
  return new URL(noteUrl).hostname.endsWith("rednote.com")
    ? "https://creator.rednote.com"
    : "https://creator.xiaohongshu.com";
}

const noteList = /\/api\/galaxy\/v\d+\/creator\/note\/user\/posted/;

/**
 * Opens the note manager and scrolls until the note's card loads or the list ends.
 * `card` is null only when the whole list loaded without the note; `note` is its entry from the list API.
 */
export async function findNote(page, origin, id) {
  const notes = new Map();
  const listed = async (response) => {
    if (!noteList.test(response.url())) return;
    try {
      for (const note of (await response.json())?.data?.notes ?? []) notes.set(note.id, note);
    } catch {}
  };
  page.on("response", listed);
  try {
    await page.goto(`${origin}/new/note-manager`);
    const cards = page.locator("div.note-card");
    await cards.first().waitFor({ timeout: 20_000 });
    const card = page.locator(`div.note-card[data-impression*="${id}"]`).first();
    let ended = false;
    for (let scroll = 0; scroll < 20 && !ended && !(await card.count()); scroll++) {
      const loaded = await cards.count();
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(1200);
      ended = (await cards.count()) === loaded;
    }
    if (await card.count()) return { card, note: notes.get(id) ?? null };
    if (!ended) throw new Error("The note manager kept loading without reaching this note");
    return { card: null, note: null };
  } finally {
    page.off("response", listed);
  }
}
