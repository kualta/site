/** Only gestures crossing the hero/feed boundary belong to the transition. */
const QUIET_MS = 150;
const MAX_HOLD_MS = 1000;
const INTENT_PX = 8;

export function transitionFirstScreen(feed: HTMLElement): () => void {
  const listeners = new AbortController();
  const options = { passive: false, signal: listeners.signal } as const;
  let direction = 0;
  let heldSince = 0;
  let quiet = 0;
  let wheelIntent = 0;

  const feedTop = () => Math.round(feed.getBoundingClientRect().top + window.scrollY);
  const release = () => {
    window.clearTimeout(quiet);
    direction = 0;
    wheelIntent = 0;
  };
  const renewGesture = () => {
    window.clearTimeout(quiet);
    quiet = window.setTimeout(release, QUIET_MS);
  };
  const excluded = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return true;
    if (target.closest('input, textarea, select, [contenteditable], dialog[open], [role="dialog"], [popover]:popover-open')) return true;
    for (let element: Element | null = target; element && element !== document.body; element = element.parentElement) {
      if (element.scrollHeight > element.clientHeight && /auto|scroll/.test(getComputedStyle(element).overflowY)) return true;
    }
    return false;
  };

  function caught(nextDirection: number): boolean {
    if (direction && performance.now() - heldSince >= MAX_HOLD_MS) {
      release();
      return false;
    }
    if (!direction) {
      const boundary = feedTop();
      if (feed.clientHeight === 0 || (nextDirection > 0
        ? window.scrollY >= boundary - 1
        : window.scrollY <= 1 || window.scrollY > boundary + 1)) return false;
      heldSince = performance.now();
    }
    if (direction !== nextDirection) {
      direction = nextDirection;
      // Retarget immediately on reversal; no queued transition can push back down.
      window.scrollTo({
        top: direction > 0 ? feedTop() : 0,
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      });
    }
    return true;
  }

  window.addEventListener("wheel", (event) => {
    if (event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || excluded(event.target) || event.deltaY === 0) return;
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1);
    wheelIntent = Math.sign(wheelIntent) === Math.sign(pixels) ? wheelIntent + pixels : pixels;
    if ((direction || Math.abs(wheelIntent) >= INTENT_PX) && caught(Math.sign(pixels))) event.preventDefault();
    renewGesture();
  }, options);

  let touchStartX = 0;
  let touchStartY = 0;
  let touchLastY = 0;
  let touchOwned = false;
  let touchExcluded = false;
  window.addEventListener("touchstart", (event) => {
    const touch = event.touches[0];
    touchExcluded = event.touches.length !== 1 || excluded(event.target);
    touchOwned = false;
    touchStartX = touch?.clientX ?? 0;
    touchStartY = touchLastY = touch?.clientY ?? 0;
  }, { passive: true, signal: listeners.signal });
  window.addEventListener("touchmove", (event) => {
    if (event.touches.length !== 1 || touchExcluded || !event.cancelable) return;
    const touch = event.touches[0];
    const moved = touchStartY - touch.clientY;
    const delta = touchLastY - touch.clientY;
    touchLastY = touch.clientY;
    if (!touchOwned && (Math.abs(moved) < INTENT_PX || Math.abs(touch.clientX - touchStartX) > Math.abs(moved))) return;
    if (delta && caught(Math.sign(delta))) {
      touchOwned = true;
      event.preventDefault();
      renewGesture();
    }
  }, options);
  window.addEventListener("touchend", release, { passive: true, signal: listeners.signal });
  window.addEventListener("touchcancel", release, { passive: true, signal: listeners.signal });

  return () => { release(); listeners.abort(); };
}
