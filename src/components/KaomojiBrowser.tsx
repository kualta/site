import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { searchKaomoji, type KaomojiIndex } from "@/lib/kaomoji-search";
import KaomojiList from "./KaomojiList";

interface Props {
  initialEntries: string[];
  total: number;
  pageSize: number;
}

export default function KaomojiBrowser({ initialEntries, total, pageSize }: Props) {
  const [browseEntries, setBrowseEntries] = useState(initialEntries);
  const [browsePage, setBrowsePage] = useState(1);
  const [searchPage, setSearchPage] = useState(1);
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const deferredQuery = useDeferredValue(trimmedQuery);
  const searching = trimmedQuery.length > 0;
  const [index, setIndex] = useState<KaomojiIndex | null>(null);
  const [indexLoading, setIndexLoading] = useState(false);
  const [indexError, setIndexError] = useState("");
  const [retry, setRetry] = useState(0);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!searching || index) return;
    const controller = new AbortController();
    setIndexLoading(true);
    setIndexError("");
    fetch("/kaomoji-library/search.json", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load search");
        const data = await response.json();
        if (!Array.isArray(data.tags) || !Array.isArray(data.entries)) throw new Error("Invalid search index");
        setIndex(data);
      })
      .catch(() => {
        if (!controller.signal.aborted) setIndexError("Couldn’t load search.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setIndexLoading(false);
      });
    return () => controller.abort();
  }, [searching, index, retry]);

  const results = useMemo(
    () => (index && deferredQuery ? searchKaomoji(index, deferredQuery) : []),
    [index, deferredQuery],
  );
  const page = searching ? searchPage : browsePage;
  const count = searching ? results.length : total;
  const pageCount = Math.max(1, Math.ceil(count / pageSize));
  const entries = searching ? results.slice((page - 1) * pageSize, page * pageSize) : browseEntries;
  const loading = searching ? (!index && indexLoading) || trimmedQuery !== deferredQuery : pageLoading;
  const error = searching ? indexError : pageError;
  const firstEntry = count ? (page - 1) * pageSize + 1 : 0;
  const lastEntry = Math.min(page * pageSize, count);

  function focusHeading(): void {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "start" });
  }

  async function goToPage(nextPage: number): Promise<void> {
    if (loading || nextPage < 1 || nextPage > pageCount) return;
    if (searching) {
      setSearchPage(nextPage);
      focusHeading();
      return;
    }
    setPageLoading(true);
    setPageError("");
    const trigger = document.activeElement;
    try {
      const response = await fetch(`/kaomoji-library/${nextPage}.json`);
      if (!response.ok) throw new Error("Unable to load kaomoji");
      const nextEntries: unknown = await response.json();
      if (!Array.isArray(nextEntries) || !nextEntries.every((entry) => typeof entry === "string")) {
        throw new Error("Invalid kaomoji page");
      }
      setBrowseEntries(nextEntries);
      setBrowsePage(nextPage);
      if (document.activeElement === trigger) focusHeading();
    } catch {
      setPageError("Couldn’t load this page. Try again.");
    } finally {
      setPageLoading(false);
    }
  }

  const buttonClass =
    "rounded border border-current/20 px-3 py-2 hover:bg-current/5 disabled:opacity-30 disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4";

  return (
    <div className="kaomoji-browser flex w-full flex-col items-center">
      <div className="w-full max-w-md px-5 mb-10">
        <label htmlFor="kaomoji-search" className="sr-only">
          Search kaomoji, categories, and tags
        </label>
        <input
          id="kaomoji-search"
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSearchPage(1);
          }}
          placeholder="Search kaomoji, categories, tags…"
          className="kaomoji-search"
        />
      </div>
      {!searching && <KaomojiList />}
      <section aria-labelledby="all-kaomoji" className="w-full max-w-6xl px-5 pb-16 pt-12 font-mono">
        <h2
          id="all-kaomoji"
          ref={heading}
          tabIndex={-1}
          className="scroll-mt-8 text-center text-xl font-bold outline-none"
        >
          all kaomoji
        </h2>
        <p className="mt-4 text-center text-sm opacity-60" aria-live="polite" role="status">
          {loading ? "Loading…" : `${firstEntry}–${lastEntry} of ${count.toLocaleString("en-US")}`}
        </p>
        <ul aria-busy={loading} className="my-8 grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((entry) => (
            <li key={entry} className="overflow-x-auto whitespace-pre text-center text-lg py-1">
              {entry}
            </li>
          ))}
        </ul>
        {searching && index && !loading && count === 0 && <p className="my-8 text-center text-sm">No kaomoji found.</p>}
        <nav aria-label="All kaomoji pages" className="flex flex-wrap items-center justify-center gap-3 text-sm">
          <button
            type="button"
            className={buttonClass}
            disabled={loading || page === 1}
            onClick={() => goToPage(1)}
            aria-label="First page"
          >
            «
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={loading || page === 1}
            onClick={() => goToPage(page - 1)}
          >
            Previous
          </button>
          <span>
            {page} / {pageCount}
          </span>
          <button
            type="button"
            className={buttonClass}
            disabled={loading || page === pageCount}
            onClick={() => goToPage(page + 1)}
          >
            Next
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={loading || page === pageCount}
            onClick={() => goToPage(pageCount)}
            aria-label="Last page"
          >
            »
          </button>
        </nav>
        {error && (
          <p role="alert" className="mt-4 text-center text-sm">
            {error}
            {searching && (
              <button type="button" onClick={() => setRetry(retry + 1)} className="ml-2 underline">
                Retry
              </button>
            )}
          </p>
        )}
      </section>
    </div>
  );
}
