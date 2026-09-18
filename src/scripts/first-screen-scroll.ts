/**
 * The home page rests on two screens: the name, then the activity feed. Scroll
 * snapping alone only decides where a scroll *ends*, so a trackpad fling spends
 * its whole momentum and flies deep into the feed. This turns the first push off
 * the first screen into the transition itself and swallows the rest of that
 * gesture, so however hard the fling, it stops at the top of the feed. Once the
 * page is there the feed scrolls like any other page.
 */

/** wheel events keep arriving while a fling decays; this much silence ends it */
const QUIET_MS = 100;
/** someone who just keeps scrolling is let through rather than held forever */
const MAX_HOLD_MS = 1000;
/** a finger wanders a little before it means to scroll */
const TOUCH_SLOP = 6;

export function holdFirstScreen(feed: HTMLElement): () => void {
  const listeners = new AbortController();
  const options = { passive: false, signal: listeners.signal } as const;

  let holding = false;
  let heldSince = 0;
  let quiet = 0;

  const feedTop = (): number => Math.round(feed.getBoundingClientRect().top + window.scrollY);
  // the feed collapses to nothing until its first rows arrive, and until then
  // there is no second screen to hold the page on
  const hasFeed = (): boolean => feed.getBoundingClientRect().height > 0;
  const onFirstScreen = (): boolean => window.scrollY < feedTop() - 1;

  /** true once this gesture belongs to the transition, so it must not reach the page */
  function caught(downward: boolean): boolean {
    if (holding) {
      if (performance.now() - heldSince > MAX_HOLD_MS) {
        clearTimeout(quiet);
        holding = false;
        return false;
      }
    } else {
      if (!downward || !hasFeed() || !onFirstScreen()) return false;
      holding = true;
      heldSince = performance.now();
      // html is scroll-smooth, so this eases down to the feed on its own
      window.scrollTo({ top: feedTop() });
    }

    clearTimeout(quiet);
    quiet = window.setTimeout(() => {
      holding = false;
    }, QUIET_MS);
    return true;
  }

  window.addEventListener(
    "wheel",
    (event) => {
      // pinch zoom and sideways scrolls are nobody's business here
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (caught(event.deltaY > 0)) event.preventDefault();
    },
    options,
  );

  let touchStart = 0;
  window.addEventListener(
    "touchstart",
    (event) => {
      touchStart = event.touches[0]?.clientY ?? 0;
    },
    { passive: true, signal: listeners.signal },
  );
  window.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length > 1) return;
      const moved = touchStart - (event.touches[0]?.clientY ?? 0);
      if (caught(moved > TOUCH_SLOP)) event.preventDefault();
    },
    options,
  );

  return () => {
    clearTimeout(quiet);
    listeners.abort();
  };
}
