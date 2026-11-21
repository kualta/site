import { type CalendarDay, calendarDays, type StoryDay } from "@/lib/videos";
import { firstToShow, warmWhenNear } from "./stories-viewer";

/** How many squares a row can hold, closest first; zooming in or out moves one step along. */
const COLUMNS = [1, 2, 3, 4, 5, 7, 9, 12, 16, 22, 30, 40];
/** Squares stay between these sizes, so which steps are on offer depends on how wide the calendar is. */
const SMALLEST = 18;
const LARGEST = 480;
/** The calendar opens with squares about this wide, unless this browser zoomed it before. */
const OPENING = 140;
/** How far a pinch has to spread or close to take a step. */
const PINCH_STEP = 1.3;
/** A pinch that pauses this long starts counting afresh. */
const PINCH_SETTLE_MS = 250;
const GLIDE_MS = 320;
const STORED = "stories-calendar-columns:v1";

/** What a day's ring or calendar square is called: "Nov 16: 4 stories". */
export function dayName(day: StoryDay): string {
  return `${day.label}: ${day.stories.length} ${day.stories.length === 1 ? "story" : "stories"}`;
}

/** The row lengths on offer when the calendar is `width` pixels wide. */
export function zoomSteps(width: number): number[] {
  const steps = COLUMNS.filter((columns) => width / columns >= SMALLEST && width / columns <= LARGEST);
  return steps.length ? steps : [1];
}

/** The row length on offer at `width` whose squares come closest in size to those of `columns` to a row. */
export function nearestStep(width: number, columns: number): number {
  const distance = (step: number): number => Math.abs(Math.log(step / columns));
  return zoomSteps(width).reduce((best, step) => (distance(step) < distance(best) ? step : best));
}

/** One step in, to fewer and larger squares, or out, to more and smaller ones; at either end it stays put. */
export function zoomStep(width: number, columns: number, direction: "in" | "out"): number {
  const steps = zoomSteps(width);
  const at = steps.indexOf(nearestStep(width, columns)) + (direction === "in" ? -1 : 1);
  return steps[Math.min(steps.length - 1, Math.max(0, at))];
}

/** The space between squares: a little while they are large, a hairline once they are small. */
export function gapFor(columns: number): number {
  if (columns <= 3) return 6;
  if (columns <= 7) return 4;
  if (columns <= 16) return 2;
  return 1;
}

/** Safari's pinch, on a trackpad or a touch screen. */
interface GestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

function storedColumns(): number | undefined {
  try {
    const columns = Number(localStorage.getItem(STORED));
    return columns > 0 ? columns : undefined;
  } catch {
    return undefined;
  }
}

function storeColumns(columns: number): void {
  try {
    localStorage.setItem(STORED, String(columns));
  } catch {
    /* zoom is only remembered where the browser keeps storage */
  }
}

/** How many squares a row holds as the calendar opens: as this browser last zoomed it, or about 140 pixels each. */
function openingColumns(width: number): number {
  return nearestStep(width, storedColumns() ?? width / OPENING);
}

/** Sets how many squares a row holds and the gap between them. */
function layColumns(grid: HTMLElement, columns: number): void {
  grid.style.setProperty("--columns", String(columns));
  grid.style.setProperty("--gap", `${gapFor(columns)}px`);
}

/**
 * Holds the calendar's place while its days are read: blank squares, as large as the calendar will open with, filling
 * whole rows to most of the screen's height. The calendar, once mounted, takes their place.
 */
export function showSuspense(root: HTMLElement): void {
  const grid = root.querySelector<HTMLElement>("[data-calendar-grid]");
  if (!grid) return;
  const width = grid.clientWidth;
  const columns = openingColumns(width);
  const rows = Math.min(40, Math.max(2, Math.ceil((innerHeight * 0.7) / (width / columns))));
  root.setAttribute("aria-busy", "true");
  root.setAttribute("data-loading", "");
  layColumns(grid, columns);
  grid.replaceChildren(
    ...Array.from({ length: columns * rows }, () => {
      const placeholder = document.createElement("span");
      placeholder.className = "story-date story-date-suspense";
      return placeholder;
    }),
  );
}

/** Takes the placeholders away when no calendar follows them, after a failed read or signing out. */
export function hideSuspense(root: HTMLElement): void {
  if (!root.hasAttribute("data-loading")) return;
  root.querySelector("[data-calendar-grid]")?.replaceChildren();
  root.removeAttribute("aria-busy");
  root.removeAttribute("data-loading");
}

/**
 * Fills `root` with the stories calendar, laid out the way Apple Photos lays out a library: every day from the first
 * with stories to the last is a square, in order and filling each row, and a day with stories shows its picture and
 * opens its stories. It zooms the way Photos does as well. A pinch on a trackpad or a touch screen, Ctrl or ⌘ with the
 * scroll wheel, the zoom buttons, or + and - change how many squares fit a row; each square glides from where it was to
 * where it lands, and the one under the fingers keeps its place. The bar above names the month in view.
 */
export function mountCalendar(
  root: HTMLElement,
  days: StoryDay[],
  open: (position: number, from: HTMLElement) => void,
): () => void {
  const found = root.querySelector<HTMLElement>("[data-calendar-grid]");
  if (!found) return () => {};
  const grid: HTMLElement = found;
  const bar = root.querySelector<HTMLElement>("[data-calendar-bar]");
  const monthName = root.querySelector<HTMLElement>("[data-calendar-month]");
  const zoomIn = root.querySelector<HTMLButtonElement>('[data-zoom="in"]');
  const zoomOut = root.querySelector<HTMLButtonElement>('[data-zoom="out"]');
  const controller = new AbortController();
  const { signal } = controller;
  const positions = new Map(days.map((day, position) => [day.day, position]));
  const calendar = calendarDays(days.map((day) => day.day));
  const squares = calendar.map(square);
  hideSuspense(root);
  grid.replaceChildren(...squares);

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let columns = openingColumns(grid.clientWidth);
  let gliding: Animation[] = [];
  let frame = 0;

  function square(date: CalendarDay): HTMLElement {
    const label = document.createElement("span");
    label.className = "story-date-label";
    label.textContent = date.label;
    const position = positions.get(date.day);
    if (position === undefined) {
      const empty = document.createElement("span");
      empty.className = "story-date";
      empty.setAttribute("aria-hidden", "true");
      empty.append(label);
      return empty;
    }
    const day = days[position];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "story-date story-date-has";
    button.setAttribute("aria-label", dayName(day));
    // the day's first story, as it began
    const cover = day.stories[0]?.thumbnail;
    if (cover) {
      const image = new Image();
      image.alt = "";
      image.decoding = "async";
      image.loading = "lazy";
      image.src = cover;
      button.append(image);
    }
    button.append(label);
    button.addEventListener("click", () => open(position, button));
    warmWhenNear(button, signal, () => firstToShow(day.stories));
    return button;
  }

  /** Sets the row length, and with it the gap, the buttons' limits and the month in view. */
  function lay(): void {
    const steps = zoomSteps(grid.clientWidth);
    layColumns(grid, columns);
    if (zoomIn) zoomIn.disabled = columns <= steps[0];
    if (zoomOut) zoomOut.disabled = columns >= (steps.at(-1) ?? columns);
    nameMonth();
  }

  /** Names the month of the row just under the bar, worked out from where rows fall rather than measuring each. */
  function nameMonth(): void {
    if (!monthName || !squares.length) return;
    const under = bar?.getBoundingClientRect().bottom ?? 0;
    const row = squares.length > columns ? squares[columns].offsetTop - squares[0].offsetTop : Infinity;
    const index = Math.floor((under - grid.getBoundingClientRect().top) / row) * columns;
    monthName.textContent = calendar[Math.min(squares.length - 1, Math.max(0, index))].month;
  }

  /** The square at a point, or between squares and beside the grid, the first one of the row at that height. */
  function squareAt(x: number, y: number): HTMLElement | undefined {
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>(".story-date");
    if (hit && grid.contains(hit)) return hit;
    return squares.find((square) => square.getBoundingClientRect().bottom >= y) ?? squares.at(-1);
  }

  /** The middle of the part of the grid in view, where zooming without a pointer centres. */
  function middle(): [number, number] {
    const box = grid.getBoundingClientRect();
    const top = Math.max(box.top, bar?.getBoundingClientRect().bottom ?? 0);
    const bottom = Math.min(box.bottom, innerHeight);
    return [box.left + box.width / 2, (top + bottom) / 2];
  }

  /**
   * Runs `change`, which moves the squares, keeps the point (x, y) over the same spot of the same square by scrolling,
   * then glides every square in view from where it was on screen to where it now is. Squares that were far off screen
   * fade in instead of flying across it. Measuring while a glide is still running starts the next from mid-flight.
   */
  function glide(change: () => void, x: number, y: number): void {
    const anchor = squareAt(x, y);
    const before = squares.map((square) => square.getBoundingClientRect());
    for (const animation of gliding) animation.cancel();
    gliding = [];
    change();
    if (anchor) {
      const was = before[squares.indexOf(anchor)];
      const now = anchor.getBoundingClientRect();
      window.scrollBy({ top: now.top + ((y - was.top) / was.height) * now.height - y, behavior: "instant" });
    }
    if (reducedMotion.matches) return;
    const height = innerHeight;
    for (const [index, square] of squares.entries()) {
      const now = square.getBoundingClientRect();
      if (now.bottom < 0 || now.top > height) continue;
      const was = before[index];
      const near = was.bottom > -height && was.top < height * 2;
      const keyframes = near
        ? [
            {
              transform: `translate(${was.left - now.left}px, ${was.top - now.top}px) scale(${was.width / now.width})`,
            },
            { transform: "none" },
          ]
        : [{ opacity: 0 }, { opacity: 1 }];
      gliding.push(square.animate(keyframes, { duration: GLIDE_MS, easing: "cubic-bezier(.2, .8, .2, 1)" }));
    }
  }

  function zoom(direction: "in" | "out", x: number, y: number): void {
    const next = zoomStep(grid.clientWidth, columns, direction);
    if (next === columns) return;
    storeColumns(next);
    glide(
      () => {
        columns = next;
        lay();
      },
      x,
      y,
    );
  }

  // A pinch adds up across events, taking a step each time it has spread or closed far enough.
  let pinched = 1;
  let settle: ReturnType<typeof setTimeout> | undefined;
  function pinch(factor: number, x: number, y: number): void {
    pinched *= factor;
    clearTimeout(settle);
    settle = setTimeout(() => {
      pinched = 1;
    }, PINCH_SETTLE_MS);
    if (pinched >= PINCH_STEP) {
      pinched = 1;
      zoom("in", x, y);
    } else if (pinched <= 1 / PINCH_STEP) {
      pinched = 1;
      zoom("out", x, y);
    }
  }

  // Chrome and Firefox report a trackpad pinch as the wheel with Ctrl held; a mouse wheel with Ctrl or ⌘ zooms too.
  let safariPinching = false;
  root.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (safariPinching) return;
      const pixels = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      pinch(Math.exp(-pixels / 100), event.clientX, event.clientY);
    },
    { passive: false, signal },
  );

  if ("GestureEvent" in window) {
    // Safari, on a Mac trackpad and on iPhone and iPad alike; stopping these keeps the page itself from zooming.
    let scale = 1;
    root.addEventListener(
      "gesturestart",
      (event) => {
        event.preventDefault();
        safariPinching = true;
        scale = 1;
      },
      { signal },
    );
    root.addEventListener(
      "gesturechange",
      (event) => {
        event.preventDefault();
        const gesture = event as GestureEvent;
        pinch(gesture.scale / scale, gesture.clientX, gesture.clientY);
        scale = gesture.scale;
      },
      { signal },
    );
    root.addEventListener(
      "gestureend",
      (event) => {
        event.preventDefault();
        safariPinching = false;
      },
      { signal },
    );
  } else {
    // Other touch screens: two fingers spreading or closing.
    let spread = 0;
    const fingers = (touches: TouchList): { spread: number; x: number; y: number } => {
      const [a, b] = [touches[0], touches[1]];
      return {
        spread: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2,
      };
    };
    const lift = (event: TouchEvent): void => {
      if (event.touches.length < 2) spread = 0;
    };
    root.addEventListener(
      "touchstart",
      (event) => {
        if (event.touches.length === 2) spread = fingers(event.touches).spread;
      },
      { passive: true, signal },
    );
    root.addEventListener(
      "touchmove",
      (event) => {
        if (event.touches.length !== 2 || !spread) return;
        event.preventDefault();
        const now = fingers(event.touches);
        pinch(now.spread / spread, now.x, now.y);
        spread = now.spread;
      },
      { passive: false, signal },
    );
    root.addEventListener("touchend", lift, { passive: true, signal });
    root.addEventListener("touchcancel", lift, { passive: true, signal });
  }

  zoomIn?.addEventListener("click", () => zoom("in", ...middle()), { signal });
  zoomOut?.addEventListener("click", () => zoom("out", ...middle()), { signal });
  // + and - zoom from anywhere on the page, but not while typing or watching stories
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable], dialog, [data-story-viewer]")) return;
      let direction: "in" | "out" | undefined;
      if (event.key === "+" || event.key === "=") direction = "in";
      else if (event.key === "-" || event.key === "_") direction = "out";
      if (!direction) return;
      event.preventDefault();
      zoom(direction, ...middle());
    },
    { signal },
  );
  addEventListener(
    "scroll",
    () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        nameMonth();
      });
    },
    { passive: true, signal },
  );
  // a narrower window may not fit the row length any more; the nearest that fits takes over
  const resize = new ResizeObserver(() => {
    columns = nearestStep(grid.clientWidth, columns);
    lay();
  });
  resize.observe(grid);

  lay();
  // like Photos, it opens on the newest days, unless the page has already been scrolled
  const newest = squares.at(-1);
  if (newest && scrollY < 40 && newest.getBoundingClientRect().bottom > innerHeight) {
    newest.scrollIntoView({ block: "end", behavior: "instant" });
  }

  return () => {
    controller.abort();
    resize.disconnect();
    clearTimeout(settle);
    cancelAnimationFrame(frame);
    for (const animation of gliding) animation.cancel();
    grid.replaceChildren();
  };
}
