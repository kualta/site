// Snowfall as a pure function of the wall clock. Every flake's place comes from
// Date.now(), so the screen is already full of snow on the first frame and a
// reload, a second tab or another page shows the same flakes where they were.

/** time zero for the snow: positions are measured in seconds since this */
export const SNOW_EPOCH = Date.UTC(2026, 0, 1);

// px a flake travels past each edge before it wraps, so none pops in on screen:
// half the biggest flake, plus its widest sway across
const MARGIN_Y = 12;
const MARGIN_X = MARGIN_Y + 24;

export interface Flake {
  /** horizontal start, as a fraction of the field width */
  x: number;
  /** vertical start, as a fraction of the field height */
  y: number;
  /** seconds to fall through the field once */
  fall: number;
  /** horizontal drift, in field widths per second */
  drift: number;
  /** drawn width and height, in css px */
  size: number;
  /** px each side of the drift line the flake sways */
  sway: number;
  /** radians per second */
  swayRate: number;
  phase: number;
  /** radians per second; negative turns anticlockwise */
  spin: number;
  angle: number;
  /** radians per second of the tumble that foreshortens the flake */
  tumbleRate: number;
  opacity: number;
  /** index into FLAKE_SVGS */
  design: number;
}

export interface FlakePose {
  x: number;
  y: number;
  angle: number;
  /** 1 face-on, smaller when the flake tumbles edge-on */
  tilt: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const frac = (n: number) => n - Math.floor(n);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** the same flakes for the same seed, every time and on every device */
export function makeFlakes(count: number, seed = 1225): Flake[] {
  const rand = mulberry32(seed);
  const between = (a: number, b: number) => lerp(a, b, rand());
  return Array.from({ length: count }, () => {
    // most flakes are small and far; near ones are bigger, brighter and faster
    const near = rand() ** 1.4;
    return {
      x: rand(),
      y: rand(),
      fall: lerp(15, 6, near) * between(0.85, 1.15),
      drift: between(-0.004, 0.014) * lerp(0.6, 1.2, near),
      size: lerp(9, 22, near),
      sway: between(6, 22),
      swayRate: (2 * Math.PI) / between(3, 7),
      phase: between(0, 2 * Math.PI),
      spin: between(0.15, 0.9) * (rand() < 0.5 ? -1 : 1),
      angle: between(0, 2 * Math.PI),
      tumbleRate: between(0.3, 1.1),
      opacity: lerp(0.55, 1, near),
      design: Math.floor(rand() * FLAKE_SVGS.length),
    };
  });
}

/** where a flake is `seconds` after SNOW_EPOCH in a width × height px field */
export function poseAt(flake: Flake, seconds: number, width: number, height: number): FlakePose {
  // the unbounded terms move in fractions of the field, so a resize stretches the
  // snow instead of reshuffling it; only the bounded sway is in px
  const across = frac(flake.x + seconds * flake.drift) * (width + 2 * MARGIN_X) - MARGIN_X;
  return {
    x: across + flake.sway * Math.sin(seconds * flake.swayRate + flake.phase),
    y: frac(flake.y + seconds / flake.fall) * (height + 2 * MARGIN_Y) - MARGIN_Y,
    angle: flake.angle + seconds * flake.spin,
    tilt: 0.7 + 0.3 * Math.cos(seconds * flake.tumbleRate + flake.phase),
  };
}

export function snowSeconds(now = Date.now()): number {
  return (now - SNOW_EPOCH) / 1000;
}

// Six-fold flakes on a 100 × 100 grid, centred on 50,50, drawn in white strokes.
const TURNS = [0, 60, 120, 180, 240, 300];
const around = (turns: number[], element: (transform: string) => string) =>
  turns.map((turn) => element(`transform="rotate(${turn} 50 50)"`)).join("");
/** `arm` is one arm pointing up; it is repeated six times around the centre */
const sixfold = (arm: string, extra = "", width = 6) => {
  const style = `fill="none" stroke="#fff" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;
  const arms = around(TURNS, (t) => `<path ${t} d="${arm}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" ${style}>${arms}${extra}</svg>`;
};

export const FLAKE_SVGS = [
  // the original /snowflake.webp: forked tips, six rhombus petals in the middle
  sixfold("M50 50V5M50 20L40 10M50 20L60 10M35.6 25.1L50 33.4L64.4 25.1"),
  // stellar dendrite: side branches at 60°, longest near the middle
  sixfold("M50 50V5M50 37L37.9 30M50 37L62.1 30M50 23L42.2 18.5M50 23L57.8 18.5"),
  // hexagonal plate with branched arms
  sixfold("M50 30V5M50 18L42.2 13.5M50 18L57.8 13.5", '<path d="M50 30L67.3 40V60L50 70L32.7 60V40Z"/>'),
  // beaded tips
  sixfold(
    "M50 50V18M50 32L42.2 27.5M50 32L57.8 27.5",
    `<g fill="#fff" stroke="none">${around(TURNS, (t) => `<circle ${t} cx="50" cy="11" r="5.5"/>`)}</g>`,
  ),
  // chevrons pointing out along each arm
  sixfold("M50 50V8M42 16L50 8L58 16M43 30L50 23L57 30"),
  // twelve points off a ring: forked long arms between short ones
  sixfold(
    "M50 40V5M50 15L43 8M50 15L57 8",
    `<circle cx="50" cy="50" r="10"/>${around([30, 90, 150, 210, 270, 330], (t) => `<path ${t} d="M50 40V25"/>`)}`,
  ),
  // fern: fine branches all the way out
  sixfold(
    "M50 50V4M50 40L43.9 36.5M50 40L56.1 36.5M50 32L40.5 26.5M50 32L59.5 26.5M50 24L41.3 19M50 24L58.7 19M50 16L43.9 12.5M50 16L56.1 12.5",
    "",
    5,
  ),
  // sectored plate: six hollow leaves
  sixfold("M50 50L43.5 30L50 6L56.5 30Z"),
];
