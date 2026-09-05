import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

interface Heading {
  depth: number;
  slug: string;
  text: string;
}

interface Props {
  headings: Heading[];
  /** the post title, so the first chapter covers the opening instead of starting mid-post */
  title?: string;
}

/** the h1 the rail treats as chapter zero */
export const POST_TITLE_ID = "post-title";

/** where in the viewport a heading counts as the one being read */
const READING_OFFSET = 96;
/** two labels never stack closer than this, so a short chapter still reads */
const LABEL_GAP = 18;
/** the rail shows itself in full on arrival, then gets out of the way */
const INTRO_HOLD = 1800;
/** the ticks linger this long after the page stops moving */
const SCROLL_LINGER = 900;
const SCROLL_DURATION = 600;
/** a pointer leaving has to mean it, or crossing the gap would collapse the rail */
const CLOSE_DELAY = 200;

interface Chapter {
  id: string;
  text: string;
}

/** a chapter's stretch of the document, in page coordinates */
interface Span {
  top: number;
  height: number;
}

/** where a chapter sits on the rail, as a fraction of the whole post */
interface Segment {
  offset: number;
  size: number;
  end: number;
}

/** the chapters the rail ended up with, and where each one sits on the page */
interface Rail {
  chapters: Chapter[];
  spans: Span[];
}

const NO_RAIL: Rail = { chapters: [], spans: [] };

export default function TableOfContents({ headings, title }: Props) {
  const candidates = useMemo(() => toChapters(headings, title), [headings, title]);

  const [{ chapters, spans }, setRail] = useState<Rail>(NO_RAIL);
  const [progress, setProgress] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [railHeight, setRailHeight] = useState(0);
  const [intro, setIntro] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [seeking, setSeeking] = useState(false);

  const measure = useCallback(() => {
    const found = candidates.map((chapter) => document.getElementById(chapter.id));
    if (found.length === 0 || found.some((node) => node === null)) {
      setRail(NO_RAIL);
      return;
    }
    const nodes = found as HTMLElement[];

    // a post that opens straight onto its first section has no lead of its own,
    // and a title chapter with nothing under it only crowds that section off the
    // top of the rail
    const lead = title && nodes.length > 1 && !hasLead(nodes[0], nodes[1]) ? 1 : 0;

    // the last chapter runs to the end of the post, not to the end of the page,
    // or everything after it would be squeezed into the final tick
    const body = document.querySelector<HTMLElement>("[data-post-body]");
    const bottom = body ? body.getBoundingClientRect().bottom + window.scrollY : document.documentElement.scrollHeight;

    const tops = nodes.slice(lead).map((node) => node.getBoundingClientRect().top + window.scrollY);
    setRail({
      chapters: candidates.slice(lead),
      spans: tops.map((top, i) => ({ top, height: Math.max(1, (tops[i + 1] ?? bottom) - top) })),
    });
  }, [candidates, title]);

  useEffect(() => {
    const frame = requestAnimationFrame(measure);
    // images and embeds settle after first paint and move every heading with them
    const observer = new ResizeObserver(measure);
    const body = document.querySelector<HTMLElement>("[data-post-body]");
    if (body) observer.observe(body);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  useEffect(() => {
    if (spans.length === 0) return;
    let frame = 0;
    let lastY = window.scrollY;
    let idle: ReturnType<typeof setTimeout> | undefined;

    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { progress, activeIndex } = readPosition(spans);
        setProgress(progress);
        setActiveIndex(activeIndex);
      });

      // a fired scroll event that moved nothing is a resize in disguise
      if (window.scrollY !== lastY) {
        lastY = window.scrollY;
        setScrolling(true);
        clearTimeout(idle);
        idle = setTimeout(() => setScrolling(false), SCROLL_LINGER);
      }
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      clearTimeout(idle);
    };
  }, [spans]);

  // the introduction only starts once there is something to introduce
  useEffect(() => {
    if (spans.length === 0) return;
    const timer = setTimeout(() => setIntro(false), INTRO_HOLD);
    return () => clearTimeout(timer);
  }, [spans.length]);

  const railRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      setRailHeight(0);
      return;
    }
    setRailHeight(node.clientHeight);
    const observer = new ResizeObserver(() => setRailHeight(node.clientHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setHovered(true);
  }, []);
  const hide = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHovered(false), CLOSE_DELAY);
  }, []);
  useEffect(() => () => void (closeTimer.current && clearTimeout(closeTimer.current)), []);

  const cancelGlide = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelGlide.current?.(), []);

  const glideTo = useCallback((target: number) => {
    cancelGlide.current?.();
    setSeeking(true);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reduced ? 0 : SCROLL_DURATION;
    const from = window.scrollY;
    const distance = target - from;
    const interrupts = ["wheel", "touchstart", "keydown"] as const;

    let frame = 0;
    let start: number | null = null;
    let aborted = false;
    const abort = () => {
      aborted = true;
    };
    for (const event of interrupts) window.addEventListener(event, abort, { passive: true });

    const stop = () => {
      cancelAnimationFrame(frame);
      for (const event of interrupts) window.removeEventListener(event, abort);
      cancelGlide.current = null;
      setSeeking(false);
    };
    cancelGlide.current = stop;

    const step = (now: number) => {
      if (aborted) {
        stop();
        return;
      }
      if (start === null) start = now;
      const t = duration <= 0 ? 1 : Math.min(1, (now - start) / duration);
      // the page is `scroll-smooth`, so each frame has to land instantly or the
      // browser would ease every one of them and the two curves would fight
      window.scrollTo({ top: from + distance * (1 - (1 - t) ** 3), behavior: "instant" });
      if (t < 1) {
        frame = requestAnimationFrame(step);
        return;
      }
      stop();
    };
    frame = requestAnimationFrame(step);
  }, []);

  const onSelect = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, id: string) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const node = document.getElementById(id);
      if (!node) return;
      event.preventDefault();
      glideTo(Math.max(0, node.getBoundingClientRect().top + window.scrollY - READING_OFFSET));
      history.replaceState(null, "", `#${id}`);
    },
    [glideTo],
  );

  const segments = useMemo(() => toSegments(spans), [spans]);
  const labelTops = useMemo(
    () =>
      stackLabels(
        segments.map((segment) => segment.offset),
        railHeight,
      ),
    [segments, railHeight],
  );

  // a single chapter is not an outline, and the rail cannot show a position in
  // it; before the first measurement there are none at all
  if (chapters.length < 2) return null;

  const open = intro || hovered;
  const visible = open || scrolling || seeking;

  return (
    <nav
      aria-label="Table of contents"
      data-open={open || undefined}
      data-visible={visible || undefined}
      className="toc pointer-events-none fixed left-0 top-1/2 z-20 hidden h-[72vh]
                 w-[176px] -translate-y-1/2 lg:block xl:w-[280px]"
    >
      <div aria-hidden="true" className="toc-scrim" />
      <div aria-hidden="true" className="toc-reach" onMouseEnter={show} onMouseLeave={hide} />

      <div className="pointer-events-none absolute inset-0 flex h-full items-stretch pl-3 pr-4">
        <div ref={railRef} className="toc-rail relative h-full w-6 shrink-0" onMouseEnter={show} onMouseLeave={hide}>
          <div className="toc-bar pointer-events-none absolute inset-y-0 left-0">
            {segments.map((segment, i) => (
              <div
                key={`track-${chapters[i].id}`}
                className="toc-track"
                style={{ top: pct(segment.offset), height: `calc(${pct(segment.size)} - 3px)` }}
              />
            ))}
            {segments.map((segment, i) => {
              const filled = fillRatio(progress, segment);
              return (
                <div
                  key={`fill-${chapters[i].id}`}
                  className="toc-fill"
                  style={{
                    top: pct(segment.offset),
                    height: `calc(${pct(filled * segment.size)} - ${3 * filled}px)`,
                    opacity: filled > 0 ? 1 : 0,
                  }}
                />
              );
            })}
          </div>
        </div>

        <ol className="relative h-full min-w-0 flex-1">
          {chapters.map((chapter, i) => (
            <li
              key={chapter.id}
              className={`toc-label absolute left-0 max-w-full${i <= activeIndex ? " is-read" : ""}`}
              style={{ top: labelTops[i] !== undefined ? `${labelTops[i]}px` : pct(segments[i].offset) }}
            >
              <a
                href={`#${chapter.id}`}
                aria-current={i === activeIndex ? "location" : undefined}
                onClick={(event) => onSelect(event, chapter.id)}
                onMouseEnter={show}
                onMouseLeave={hide}
                onFocus={show}
                onBlur={hide}
                title={chapter.text}
                className="block truncate"
              >
                {chapter.text}
              </a>
            </li>
          ))}
        </ol>
      </div>
    </nav>
  );
}

/**
 * Posts headline their sections with `##` or with `###` depending on when they
 * were written; whichever level a post starts at is that post's chapter level.
 */
function toChapters(headings: Heading[], title?: string): Chapter[] {
  const top = headings.length ? Math.min(...headings.map((heading) => heading.depth)) : 0;
  const sections = headings
    .filter((heading) => heading.depth === top)
    .map((heading) => ({ id: heading.slug, text: heading.text }));

  return title ? [{ id: POST_TITLE_ID, text: title }, ...sections] : sections;
}

/**
 * Whether the post says anything of its own before its first section. The
 * subtitle belongs to the title rather than to the writing, so it does not
 * count; a hero image or an opening paragraph does.
 */
function hasLead(title: HTMLElement, firstSection: HTMLElement): boolean {
  let node = title.nextElementSibling;
  while (node && node !== firstSection) {
    if (!node.classList.contains("post-subtitle")) return true;
    node = node.nextElementSibling;
  }
  return false;
}

/** the rail is drawn to scale: a long chapter takes a long stretch of it */
function toSegments(spans: Span[]): Segment[] {
  const total = spans.reduce((sum, span) => sum + span.height, 0) || 1;
  let cursor = 0;
  return spans.map((span) => {
    const offset = cursor / total;
    const size = span.height / total;
    cursor += span.height;
    return { offset, size, end: offset + size };
  });
}

/**
 * Where in the post the reader has got to, in page coordinates.
 *
 * That is the reading line, for as long as there is scroll left to do. But the
 * closing screenful never reaches it — the page runs out first — so a rail
 * measured off the line alone stops short of full at the foot of the page and
 * the last chapter never lights up. Over the last of the scroll the line slides
 * down the viewport instead, arriving at the end of the post exactly as the
 * scroll arrives at the bottom.
 */
function readingPoint(postEnd: number): number {
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const slack = postEnd - (maxScroll + READING_OFFSET);
  if (slack <= 0) return window.scrollY + READING_OFFSET;

  // a post that does not scroll at all is already read to the end
  const ramp = Math.min(slack, maxScroll);
  const descent = ramp > 0 ? clamp((window.scrollY - (maxScroll - ramp)) / ramp) : 1;
  return window.scrollY + READING_OFFSET + slack * descent;
}

function readPosition(spans: Span[]): { progress: number; activeIndex: number } {
  const first = spans[0].top;
  const last = spans[spans.length - 1];
  const postEnd = last.top + last.height;
  const read = readingPoint(postEnd);

  let activeIndex = 0;
  for (let i = 0; i < spans.length; i++) {
    if (read >= spans[i].top) activeIndex = i;
  }

  return { progress: clamp((read - first) / Math.max(postEnd - first, 1)), activeIndex };
}

/**
 * Labels want to sit on their tick, but chapters can be a paragraph apart. Push
 * them down until they clear each other, then pull the overflow back off the
 * bottom edge so the last one stays on the rail.
 *
 * The top edge is a floor the rest of the stack is spaced off, so it has to be
 * set before the pass and not after it — clamping the first label afterwards
 * slides it back under the second, which is spaced off where it used to be.
 */
function stackLabels(offsets: number[], railHeight: number): number[] {
  if (offsets.length === 0 || railHeight === 0) return [];
  const tops = offsets.map((offset) => offset * railHeight);

  tops[0] = Math.max(tops[0], LABEL_GAP / 2);
  for (let i = 1; i < tops.length; i++) {
    tops[i] = Math.max(tops[i], tops[i - 1] + LABEL_GAP);
  }
  for (let i = tops.length - 1; i >= 0; i--) {
    const limit = i === tops.length - 1 ? railHeight - LABEL_GAP / 2 : tops[i + 1] - LABEL_GAP;
    tops[i] = Math.min(tops[i], limit);
  }

  return tops;
}

function fillRatio(progress: number, segment: Segment): number {
  if (progress <= segment.offset) return 0;
  if (progress >= segment.end) return 1;
  return (progress - segment.offset) / segment.size;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function pct(fraction: number): string {
  return `${fraction * 100}%`;
}
