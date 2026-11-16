/**
 * Moves through an upload page at a person's pace: pauses of uneven length between steps, the mouse travelling on
 * curves to a spot inside each control before clicking it, and typing with uneven gaps between keys. TikTok gave the
 * helper's uploads no views while the same videos posted from the phone got them.
 */

/** A number between min and max. */
export function between(min, max, random = Math.random) {
  return min + (max - min) * random();
}

/** Waits min to max milliseconds. Closing the browser ends the wait. */
export function pause(page, min, max) {
  return page.waitForTimeout(Math.round(between(min, max)));
}

/** Roughly normal around 0, mostly within ±1. */
function wobble(random) {
  return (random() + random() + random() - 1.5) / 1.5;
}

/**
 * The points a hand takes from one spot to another: a curve bowing to one side, slow to start and stop, a little
 * shaky, and ending exactly on the spot. A long move sometimes overshoots and comes back.
 */
export function mousePath(from, to, random = Math.random) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 2) return [{ ...to }];
  const steps = Math.round(Math.min(70, Math.max(12, distance / between(9, 15, random))));
  // Control points sit off the straight line, both to the same side, by up to a fifth of the distance.
  const side = (random() < 0.5 ? -1 : 1) * between(0.04, 0.2, random) * distance;
  const normal = { x: -dy / distance, y: dx / distance };
  const control = (at, bow) => ({
    x: from.x + dx * at + normal.x * side * bow,
    y: from.y + dy * at + normal.y * side * bow,
  });
  const c1 = control(between(0.2, 0.4, random), between(0.6, 1.2, random));
  const c2 = control(between(0.6, 0.8, random), between(0.6, 1.2, random));
  const overshoot = distance > 300 && random() < 0.3;
  const end = overshoot
    ? { x: to.x + dx * between(0.02, 0.06, random), y: to.y + dy * between(0.02, 0.06, random) }
    : to;
  const points = [];
  for (let i = 1; i <= steps; i++) {
    const linear = i / steps;
    const t = (1 - Math.cos(Math.PI * linear)) / 2;
    const u = 1 - t;
    const shake = i === steps ? 0 : 0.6;
    points.push({
      x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x + wobble(random) * shake,
      y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y + wobble(random) * shake,
    });
  }
  // The last point has no shake and t = 1, so the curve ends exactly on `end`.
  if (overshoot) points.push(...mousePath(end, to, random));
  return points;
}

/** Where on a control to click: near its middle, never at its edges. */
export function spotIn(box, random = Math.random) {
  const within = (size) => size * Math.min(0.8, Math.max(0.2, 0.5 + wobble(random) * 0.15));
  return { x: within(box.width), y: within(box.height) };
}

// Playwright doesn't say where the mouse is; each page's is remembered from the last move.
const pointers = new WeakMap();

/** The page's size: the one Playwright set, or the window's own when nothing overrides it (stealth.mjs). */
async function viewportOf(page) {
  return (
    page.viewportSize() ??
    (await page
      .evaluate(() => ({ width: innerWidth, height: innerHeight }))
      .catch(() => ({ width: 1280, height: 900 })))
  );
}

/** Moves the mouse there along a hand's path. */
export async function moveTo(page, x, y) {
  const viewport = await viewportOf(page);
  const from = pointers.get(page) ?? { x: between(0.2, 0.8) * viewport.width, y: between(0.2, 0.8) * viewport.height };
  for (const point of mousePath(from, { x, y })) {
    await page.mouse.move(point.x, point.y);
    await new Promise((resolve) => setTimeout(resolve, between(6, 18)));
  }
  pointers.set(page, { x, y });
}

/**
 * Clicks like a person: waits until the control can be clicked, moves there, hesitates, then presses and releases with
 * a short hold. Playwright's own checks still decide that the click lands on the control.
 */
export async function humanClick(page, locator, { timeout } = {}) {
  await locator.click({ trial: true, timeout });
  const box = await locator.boundingBox();
  if (!box) return locator.click({ timeout });
  const spot = spotIn(box);
  await moveTo(page, box.x + spot.x, box.y + spot.y);
  await pause(page, 90, 280);
  await locator.click({ position: spot, delay: Math.round(between(50, 140)), timeout: 10_000 });
}

/** Types with uneven gaps between keys, longer after words and sentences, and now and then a pause to think. */
export async function humanType(page, text) {
  for (const char of text) {
    await page.keyboard.type(char);
    let gap = between(55, 170);
    if (char === " ") gap *= between(1, 1.6);
    if (/[.,!?;:\n]/.test(char)) gap += between(150, 500);
    if (Math.random() < 0.04) gap += between(300, 1100);
    await page.waitForTimeout(Math.round(gap));
  }
}

/** Looks the page over: a pause, the mouse drifting to a spot or two, now and then a small scroll that comes back. */
export async function lookAround(page) {
  const viewport = await viewportOf(page);
  await pause(page, 900, 2400);
  for (let i = Math.round(between(1, 3)); i > 0; i--) {
    await moveTo(page, between(0.15, 0.85) * viewport.width, between(0.15, 0.85) * viewport.height);
    await pause(page, 250, 900);
  }
  if (Math.random() < 0.4) {
    const by = Math.round(between(120, 360));
    await page.mouse.wheel(0, by);
    await pause(page, 500, 1400);
    await page.mouse.wheel(0, -by);
    await pause(page, 300, 800);
  }
}
