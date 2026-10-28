/** Historical pages can overlap rows already in the list. */
export function uniqueHistoricalRows(list: HTMLElement, rows: HTMLElement[]): HTMLElement[] {
  const seen = new Set(
    [...list.querySelectorAll<HTMLElement>("[data-post-uri]")].map(
      (card) => `${card.dataset.postAction || "post"}:${card.dataset.postUri}`,
    ),
  );
  return rows.filter((row) => {
    const card = row.querySelector<HTMLElement>("[data-post-uri]");
    if (!card) return true;
    const key = `${card.dataset.postAction || "post"}:${card.dataset.postUri}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Replace the newest rows up to the server page's last row; keep `existing` when nothing changed. */
export function mergeNewestRows(existing: HTMLElement[], incoming: HTMLElement[]): HTMLElement[] {
  if (!incoming.length) return existing;
  const anchor = incoming[incoming.length - 1].dataset.activityRow;
  const index = anchor ? existing.findIndex((row) => row.dataset.activityRow === anchor) : -1;
  const merged = [...incoming, ...(index < 0 ? [] : existing.slice(index + 1))];
  const signature = (rows: HTMLElement[]) =>
    rows
      .map(
        (row) =>
          `${row.dataset.activityRow || "boundary"}:${row.dataset.activityCount || ""}:${
            row.dataset.activityCursor || ""
          }:${row.querySelector<HTMLElement>("[data-post-cid]")?.dataset.postCid || ""}`,
      )
      .join("|");
  return signature(existing) === signature(merged) ? existing : merged;
}
