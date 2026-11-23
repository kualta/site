import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import autoprefixer from "autoprefixer";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import tailwindcss from "tailwindcss";
import { createServer } from "vite";
import { scenarios } from "./publisher-shift-scenarios.mjs";

const FREDOKA = "node_modules/@fontsource/fredoka/files/fredoka-latin-400-normal.woff2";
/**
 * Serves the post app as the site does, rendered by the server and then hydrated, against the fixture's mocked API:
 * `/shifts.html` and `/shifts.html/<tab>`. `props` overrides what the server knows, as JSON in the query.
 */
export async function serveShifts({ root = process.cwd(), port = 8798 } = {}) {
  const at = (file) => `/@fs${path.join(root, file)}`;
  const font = readFileSync(path.join(root, FREDOKA)).toString("base64");
  const server = await createServer({
    configFile: false,
    // Apart from the composer check's, so neither readies the other's modules again.
    cacheDir: path.join(root, "node_modules/.vite/publisher-shifts"),
    root: path.join(root, "scripts/browser-fixtures"),
    publicDir: path.join(root, "public"),
    resolve: { alias: [{ find: "@", replacement: path.join(root, "src") }] },
    esbuild: { jsx: "automatic" },
    css: {
      postcss: {
        plugins: [tailwindcss({ config: path.join(root, "tailwind.config.js") }), autoprefixer()],
      },
    },
    server: {
      host: "127.0.0.1",
      port,
      hmr: false,
      fs: { allow: [root, realpathSync(path.join(root, "node_modules"))] },
    },
    optimizeDeps: { include: ["recharts", "react-dom/client", "exifr"] },
    plugins: [
      {
        // The page links its styles, as the site's does; the modules that import them add nothing.
        name: "linked-styles",
        enforce: "post",
        transform(_code, id, options) {
          if (!options?.ssr && /\.css$/.test(id)) return { code: "export {};", map: null };
        },
      },
      {
        name: "publisher-shifts",
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            const url = new URL(request.url, "http://127.0.0.1");
            const page = url.pathname.match(/^\/shifts\.html(?:\/([a-z]+))?$/);
            if (!page) return next();
            try {
              const { default: Publisher } = await vite.ssrLoadModule(path.join(root, "src/components/Publisher.tsx"));
              const { accounts } = await vite.ssrLoadModule(path.join(root, "src/lib/publisher/presets.ts"));
              const { readPath } = await vite.ssrLoadModule(path.join(root, "src/lib/publisher/route.ts"));
              const props = {
                initialAccess: "owner",
                initialHelper: { online: true, platforms: accounts.filter((account) => account !== "farcaster") },
                initialTab: readPath(`/${page[1] ?? ""}`).tab,
                initialSearch: url.search,
                ...JSON.parse(url.searchParams.get("props") ?? "{}"),
              };
              response.setHeader("Content-Type", "text/html");
              // As src/pages/publish/[...tab].astro lays the page out.
              response.end(
                await vite.transformIndexHtml(
                  "/publisher.html",
                  `<!doctype html><html lang="en" class="${url.searchParams.get("theme") ?? "dark"}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${at("src/styles/globals.css")}"><link rel="stylesheet" href="${at(
                    "src/styles/publisher.css",
                  )}"><link rel="stylesheet" href="${at("src/styles/publisher-archive.css")}">
<link rel="preload" href="${at(FREDOKA)}" as="font" type="font/woff2" crossorigin>
<script>document.fonts.add(new FontFace("Fredoka Publisher", Uint8Array.from(atob("${font}"), (c) => c.charCodeAt(0))))</script>
</head><body class="publisher-page bg-bg dark:bg-dark-bg text-text dark:text-dark-text min-h-screen relative">
<div class="noise" aria-hidden="true"></div>
<div id="root">${renderToString(createElement(Publisher, props))}</div>
<div class="pointer-events-none" aria-hidden="true"><div class="absolute top-0 left-0 m-3 p-4 rounded-tl-lg border-t-2 border-l-2"></div><div class="absolute top-0 right-0 m-3 p-4 rounded-tr-lg border-t-2 border-r-2"></div></div>
<div class="publisher-corners" aria-hidden="true"><div class="absolute bottom-0 left-0 m-3 p-4 rounded-bl-lg border-b-2 border-l-2"></div><div class="absolute bottom-0 right-0 m-3 p-4 rounded-br-lg border-b-2 border-r-2"></div></div>
<script type="application/json" id="props">${JSON.stringify(props).replaceAll("<", "\\u003c")}</script>
<script type="module" src="/publisher.tsx"></script></body></html>`,
                ),
              );
            } catch (error) {
              next(error);
            }
          });
        },
      },
    ],
  });
  await server.listen();
  return { base: `http://127.0.0.1:${port}/shifts.html`, close: () => server.close() };
}

/**
 * Runs in the page before anything else. It records what moves, two ways: the browser's own layout-shift entries
 * (kept even after input, which the score leaves out), and every element that changed place in the document between
 * two frames, wherever it is and however little it moved. It also answers the fixture's requests as
 * `publisherFixture` says, and runs polls `speed` times as often.
 */
export function record({ speed }) {
  const every = window.setInterval.bind(window);
  const after = window.setTimeout.bind(window);
  window.setInterval = (run, ms = 0, ...rest) => every(run, ms >= 1000 ? ms / speed : ms, ...rest);
  window.setTimeout = (run, ms = 0, ...rest) => after(run, ms >= 3000 ? ms / speed : ms, ...rest);
  const fixture = { delay: () => 0, change: (_path, value) => value, calls: {} };
  window.publisherFixture = fixture;
  window.publisherAnswer = async (input, init, respond) => {
    const url = new URL(String(input), location.href);
    const name = url.pathname.replace("/api/publisher/", "");
    const method = init?.method || "GET";
    fixture.calls[name] = (fixture.calls[name] ?? 0) + 1;
    const wait = fixture.delay(name, method, fixture.calls[name]);
    if (wait) await new Promise((done) => after(done, wait));
    const response = await respond(input, init);
    if (!response.headers.get("content-type")?.includes("json")) return response;
    const value = fixture.change(name, await response.clone().json(), method, fixture.calls[name]);
    if (value?.error && Object.keys(value).length === 1) return Response.json(value, { status: 500 });
    return Response.json(value, { status: response.status });
  };

  if (window !== window.top) return;

  const named = (node) => {
    const el = node?.nodeType === 3 ? node.parentElement : node;
    if (!(el instanceof Element)) return String(node?.nodeName ?? "removed");
    const name = [el.tagName.toLowerCase(), ...el.classList].join(".");
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    return text ? `${name} “${text}”` : name;
  };
  const log = { phases: [{ name: "load", at: 0 }], shifts: [], moves: [] };
  const box = ({ x, y, width, height }) => [x, y, width, height].map(Math.round).join(",");
  const take = (entries) => {
    for (const entry of entries)
      log.shifts.push({
        at: entry.startTime,
        value: entry.value,
        input: entry.hadRecentInput,
        sources: entry.sources.map((s) => `${named(s.node)} [${box(s.previousRect)} → ${box(s.currentRect)}]`),
      });
  };
  const observer = new PerformanceObserver((list) => take(list.getEntries()));
  observer.observe({ type: "layout-shift", buffered: true });

  // Not laid out on the page: what a chart draws, and what isn't drawn at all.
  const unplaced = ".publisher-chart-marks, svg *, script, style, option, optgroup, datalist";
  // Held in the window, so the page scrolling under it moves it nowhere.
  const held = ".publisher-grade, .publisher-corners, .publisher-toasts, dialog, dialog form > :last-child";
  let before = new Map();
  let texts = new Map();
  const scan = () => {
    const at = performance.now();
    const now = new Map();
    const textsNow = new Map();
    // `dx` and `dy` are how far what it's in moved; `across` and `down`, how far that has scrolled.
    const visit = (el, dx, dy, across, down) => {
      // An element without a box of its own, such as the island the site puts the app in, still has what's in it.
      const boxless = getComputedStyle(el).display === "contents";
      if (el.matches(unplaced) || (!boxless && !el.checkVisibility())) return;
      const scrolled = el.matches(held) ? [0, 0] : [across, down];
      const rect = el.getBoundingClientRect();
      const [x, y] = [rect.x + scrolled[0], rect.y + scrolled[1]];
      const seen =
        rect.width > 0 && rect.height > 0 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
      const was = before.get(el);
      let [movedX, movedY] = [dx, dy];
      if (was) {
        [movedX, movedY] = [x - was.x, y - was.y];
        // Moved, and not only along with what it's in.
        const [offX, offY] = [movedX - dx, movedY - dy];
        const far = (a, b) => Math.abs(a) >= 0.75 || Math.abs(b) >= 0.75;
        if (seen && was.seen && far(movedX, movedY) && far(offX, offY))
          log.moves.push({ at, what: named(el), x: Math.round(offX * 10) / 10, y: Math.round(offY * 10) / 10 });
      }
      now.set(el, { x, y, seen });
      // A control drawn again by a new element counts too, found by what it says.
      if (seen && el.matches("h1, h2, h3, button, a, th, dt, legend, summary")) {
        const key = named(el);
        textsNow.set(key, textsNow.has(key) ? null : { el, x, y });
      }
      for (const child of el.children)
        visit(child, movedX, movedY, scrolled[0] + el.scrollLeft, scrolled[1] + el.scrollTop);
    };
    visit(document.body, 0, 0, scrollX - document.body.scrollLeft, scrollY - document.body.scrollTop);
    for (const [key, place] of textsNow) {
      const was = texts.get(key);
      if (!place || !was || was.el === place.el || was.el.isConnected) continue;
      if (Math.abs(place.x - was.x) >= 0.75 || Math.abs(place.y - was.y) >= 0.75)
        log.moves.push({ at, what: `redrawn ${key}`, x: Math.round(place.x - was.x), y: Math.round(place.y - was.y) });
    }
    before = now;
    texts = textsNow;
  };
  const loop = () => {
    if (document.body) scan();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.publisherShifts = {
    phase(name) {
      log.phases.push({ name, at: performance.now() });
    },
    report() {
      take(observer.takeRecords());
      const phaseAt = (at) => log.phases.findLast((phase) => phase.at <= at).name;
      const rows = {};
      for (const { name } of log.phases)
        rows[name] ??= { score: 0, entries: 0, moved: 0, furthest: 0, steps: new Set(), what: {} };
      const note = (row, what) => {
        row.what[what] = (row.what[what] ?? 0) + 1;
      };
      for (const shift of log.shifts) {
        const row = rows[phaseAt(shift.at)];
        row.score += shift.value;
        row.entries++;
        for (const source of shift.sources) note(row, `shift ${source}`);
      }
      for (const move of log.moves) {
        const row = rows[phaseAt(move.at)];
        row.moved++;
        row.steps.add(move.at);
        row.furthest = Math.max(row.furthest, Math.abs(move.x), Math.abs(move.y));
        note(row, `moved ${move.what} (${move.x}, ${move.y})`);
      }
      for (const row of Object.values(rows)) row.steps = row.steps.size;
      return rows;
    },
  };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const picture = (width, height) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#888"/></svg>`;
// The grade app on the Mac, standing in: it says it's there a moment after it loads.
const gradeApp =
  '<!doctype html><title>Grade</title><script>setTimeout(() => parent.postMessage({ type: "grade-ready" }, "*"), 400)</script>';

/** Opens a scenario's page, its responses, pictures and fonts all late, and returns a row for each of its parts. */
async function measure(browser, base, scenario, { width, theme, media }) {
  const mobile = width < 700;
  const context = await browser.newContext({
    viewport: { width, height: mobile ? 844 : 900 },
    isMobile: mobile,
    hasTouch: mobile,
    // What moves as an animation, such as a message rising into place, moves no layout.
    reducedMotion: "reduce",
  });
  try {
    await context.addInitScript(record, { speed: 20 });
    await context.addInitScript(
      (storage) => {
        if (window !== window.top) return;
        if (!localStorage.length) for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
        // Each kind of request takes its own time, so they come back one after another.
        const order = ["status", "footage/watch", "footage", "history", "content", "drafts", "footage/links"];
        order.push("footage/ledger", "calendar", "analytics", "analytics/overview", "archive/days", "archive/settings");
        window.publisherFixture.delay = (path) =>
          200 + 130 * Math.max(0, order.indexOf(path)) + (/^analytics\/[0-9a-f-]{36}/.test(path) ? 700 : 0);
      },
      scenario.storage ?? {},
    );
    if (scenario.init) await context.addInitScript(scenario.init);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message.split("\n")[0]));
    const late = (ms, body) => async (route) => {
      await sleep(ms);
      const answer = scenario.pictures === false ? { status: 404, body: "" } : { contentType: "image/svg+xml", body };
      await route.fulfill(answer).catch(() => {});
    };
    for (const [id, clip] of [
      ["d1d0", media.tall],
      ["d1d1", media.wide],
    ])
      await page.route(`**/api/publisher/media/00000000-0000-4000-8000-00000000${id}*`, async (route) => {
        await sleep(1200);
        await route.fulfill({ contentType: clip.mimeType, body: clip.buffer }).catch(() => {});
      });
    await page.route("**/api/publisher/media/m-*", late(700, picture(270, 480)));
    await page.route("**/api/publisher/thumbnails/**", late(800, picture(270, 480)));
    await page.route("**/api/publisher/footage/thumbs/**", late(800, picture(64, 36)));
    await page.route("https://i.ytimg.com/**", late(900, picture(480, 360)));
    await page.route("http://127.0.0.1:4777/**", (route) =>
      scenario.grade === false ? route.abort() : route.fulfill({ contentType: "text/html", body: gradeApp }),
    );
    await page.route("**/*.woff2*", async (route) => {
      await sleep(400);
      await route.continue().catch(() => {});
    });
    const query = new URLSearchParams({ ...scenario.query, theme });
    if (scenario.props) query.set("props", JSON.stringify(scenario.props));
    await page.goto(`${base}${scenario.tab === "compose" ? "" : `/${scenario.tab}`}?${query}`);
    await sleep(scenario.wait ?? 3600);
    const kinds = { load: "still" };
    const begin = (kind) => async (name) => {
      kinds[name] = kind;
      await page.evaluate((part) => window.publisherShifts.phase(part), name);
      await sleep(60);
    };
    let stopped = "";
    try {
      await scenario.run?.(page, { still: begin("still"), step: begin("step"), opens: begin("opens"), media });
    } catch (error) {
      stopped = error.message.split("\n")[0];
    }
    const report = await page.evaluate(() => window.publisherShifts.report());
    return Object.entries(report).map(([part, row]) => ({
      tab: scenario.tab,
      name: scenario.name,
      part,
      kind: kinds[part],
      width,
      theme,
      errors,
      stopped,
      ...row,
    }));
  } finally {
    await context.close();
  }
}

/**
 * Runs every scenario at a size, `pages` at once, and returns a row for each part of each: the score and number of its
 * layout-shift entries, how many elements moved, in how many frames and how far, and what they were.
 */
export async function measureShifts(browser, base, { only = () => true, pages = 8, ...size }) {
  const queue = scenarios.filter(only);
  const rows = [];
  await Promise.all(
    Array.from({ length: pages }, async () => {
      for (let next = queue.shift(); next; next = queue.shift())
        rows.push(...(await measure(browser, base, next, size)));
    }),
  );
  return rows;
}

/** What a row shows moving that shouldn't have, in a line, or null. */
function unsteady({ tab, width, name, part, kind, entries, moved, steps, furthest, what, errors, stopped }) {
  const still = kind === "still" ? !entries && !moved : kind === "opens" || steps <= 1;
  if (still && !errors.length && !stopped) return null;
  const found = [...errors, stopped, ...Object.keys(what).slice(0, 6)].filter(Boolean).join("\n    ");
  return `${tab} at ${width}px, ${name}, ${part}: ${moved} moved in ${steps} frames, up to ${furthest}px, with ${entries} layout shifts\n    ${found}`;
}

/** Everything on the post app that moves and shouldn't, on a desktop in dark and on a phone in light, in a line each. */
export async function findShifts(browser, media) {
  const { base, close } = await serveShifts();
  try {
    // The server readies the page's modules the first time they're asked for, reloading it as it finds more to ready.
    const page = await browser.newPage();
    await page.route("https://**", (route) => route.abort());
    await page.goto(`${base}/analytics`, { waitUntil: "networkidle" });
    await page.locator(".publisher-analytics-chart svg").first().waitFor();
    await page.close();
    const rows = [
      ...(await measureShifts(browser, base, { width: 1280, theme: "dark", media })),
      ...(await measureShifts(browser, base, { width: 390, theme: "light", media })),
    ];
    return rows.map(unsteady).filter(Boolean);
  } finally {
    await close();
  }
}
