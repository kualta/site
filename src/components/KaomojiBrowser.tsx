import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { searchKaomoji, type KaomojiIndex } from "@/lib/kaomoji-search";
import { FiChevronLeft, FiChevronRight, FiChevronsLeft, FiChevronsRight, FiX } from "react-icons/fi";

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
  const input = useRef<HTMLInputElement>(null);
  const resultsPane = useRef<HTMLDivElement>(null);

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
  const pageDigits = String(Math.max(1, Math.ceil(total / pageSize))).length;
  const entries = searching ? results.slice((page - 1) * pageSize, page * pageSize) : browseEntries;
  const loading = searching ? (!index && indexLoading) || trimmedQuery !== deferredQuery : pageLoading;
  const error = searching ? indexError : pageError;
  const firstEntry = count ? (page - 1) * pageSize + 1 : 0;
  const lastEntry = Math.min(page * pageSize, count);

  useEffect(() => {
    if (resultsPane.current) resultsPane.current.scrollTop = 0;
  }, [deferredQuery]);

  function focusResults(): void {
    if (!resultsPane.current) return;
    resultsPane.current.scrollTop = 0;
    resultsPane.current.focus({ preventScroll: true });
  }

  function clearSearch(): void {
    setQuery("");
    setSearchPage(1);
    input.current?.focus({ preventScroll: true });
  }

  async function goToPage(nextPage: number): Promise<void> {
    if (loading || nextPage < 1 || nextPage > pageCount) return;
    if (searching) {
      setSearchPage(nextPage);
      focusResults();
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
      if (document.activeElement === trigger) focusResults();
    } catch {
      setPageError("Couldn’t load this page. Try again.");
    } finally {
      setPageLoading(false);
    }
  }

  const buttonClass = "kaomoji-button";

  return (
    <div className="kaomoji-browser">
      <div className="kaomoji-toolbar">
        <div className="kaomoji-search-field">
          <label htmlFor="kaomoji-search" className="sr-only">
            Search kaomoji, categories, and tags
          </label>
          <input
            ref={input}
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
          {query && (
            <button type="button" className="kaomoji-clear" aria-label="Clear search" onClick={clearSearch}>
              <FiX aria-hidden="true" size={18} />
            </button>
          )}
        </div>
        <a href="/kaomoji/categories" className="kaomoji-button">
          categories
        </a>
      </div>
      <section aria-labelledby="all-kaomoji" className="kaomoji-results">
        <h2 id="all-kaomoji" className="sr-only">
          all kaomoji
        </h2>
        <p className="text-center text-sm opacity-60" aria-live="polite" role="status">
          {loading ? "Loading…" : `${firstEntry}–${lastEntry} of ${count.toLocaleString("en-US")}`}
        </p>
        <div
          ref={resultsPane}
          className="kaomoji-results-scroll"
          tabIndex={0}
          role="region"
          aria-label="Kaomoji results"
        >
          <ul aria-busy={loading} className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3 lg:grid-cols-5 font-mono">
            {entries.map((entry) => (
              <li key={entry} className="overflow-x-auto whitespace-pre text-center text-sm px-2 py-3">
                {entry}
              </li>
            ))}
          </ul>
          {searching && index && !loading && count === 0 && (
            <p className="my-8 text-center text-sm">No kaomoji found.</p>
          )}
        </div>
        <nav aria-label="All kaomoji pages" className="flex flex-wrap items-center justify-center gap-3 text-sm">
          <button
            type="button"
            className={buttonClass}
            disabled={loading || page === 1}
            onClick={() => goToPage(1)}
            aria-label="First page"
          >
            <FiChevronsLeft aria-hidden="true" size={18} />
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={loading || page === 1}
            onClick={() => goToPage(page - 1)}
            aria-label="Previous page"
          >
            <FiChevronLeft aria-hidden="true" size={18} />
          </button>
          <span className="flex items-center font-mono tabular-nums shrink-0">
            <span className="text-right" style={{ width: `${pageDigits}ch` }}>
              {page}
            </span>
            <span className="text-center w-[3ch]">/</span>
            <span style={{ width: `${pageDigits}ch` }}>{pageCount}</span>
          </span>
          <button
            type="button"
            className={buttonClass}
            disabled={loading || page === pageCount}
            onClick={() => goToPage(page + 1)}
            aria-label="Next page"
          >
            <FiChevronRight aria-hidden="true" size={18} />
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={loading || page === pageCount}
            onClick={() => goToPage(pageCount)}
            aria-label="Last page"
          >
            <FiChevronsRight aria-hidden="true" size={18} />
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
