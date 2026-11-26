import { blockMeans, composeLut, inputCurves, isGraded, resolveGrade, sampleTetra } from "/color.mjs";
import { bringView, isCloud } from "/ui/bring.mjs";
import { dayLabel } from "/ui/dates.mjs";
import { offloadLine, offloadMenu, offloadMoves, offloadShare } from "/ui/offload.mjs";
import { Viewer } from "/ui/viewer.mjs";

const $ = (id) => document.getElementById(id);
const store = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

async function api(path, { method = "GET", json, keepalive } = {}) {
  const res = await fetch(path, {
    method,
    keepalive,
    headers: { "X-Grade": "1", ...(json ? { "Content-Type": "application/json" } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  return res;
}

const PROFILE_NAMES = { dlog2: "D-Log2", dlog: "D-Log", hlg: "HLG", rec709: "Rec.709" };
const cameraK = (clip) => clip.cameraKelvin ?? 5600;
function tintUnit(v) {
  if (v > 0) return "magenta";
  if (v < 0) return "green";
  return "";
}
/**
 * The grade controls. `neutral` is where a rail's fill starts (a bipolar control fills from it); `rail` names a
 * coloured rail instead of a fill; `tick` marks a reference point (the camera's own white balance).
 */
const CONTROLS = [
  { field: "exposure", group: "light", label: "Exposure", min: -3, max: 3, step: 0.05, reset: 0, neutral: 0, digits: 2, signed: true, unit: () => "EV" },
  { field: "contrast", group: "light", label: "Contrast", min: 0.5, max: 1.6, step: 0.01, reset: 1, neutral: 1, digits: 2, unit: () => "×" },
  {
    field: "kelvin",
    group: "color",
    label: "Temperature",
    min: 2000,
    max: 12000,
    step: 50,
    reset: null,
    digits: 0,
    rail: "temp",
    unit: () => "K",
    get: (g, clip) => g.kelvin ?? cameraK(clip),
    tick: (clip) => cameraK(clip),
    tickTitle: (clip) => `Camera: ${cameraK(clip)} K`,
  },
  { field: "tint", group: "color", label: "Tint", min: -100, max: 100, step: 1, reset: 0, neutral: 0, digits: 0, signed: true, rail: "tint", unit: tintUnit },
  { field: "saturation", group: "color", label: "Saturation", min: 0, max: 2, step: 0.01, reset: 1, neutral: 1, digits: 2, unit: () => "×" },
];
const controlValue = (c, g, clip) => (c.get ? c.get(g, clip) : g[c.field]);
// Rounded to the step's own precision, so 0.05 steps save as 0.6, not 0.6000000000000001.
const snap = (c, v) => Math.min(c.max, Math.max(c.min, Number((Math.round(v / c.step) * c.step).toFixed(6))));
const pct = (c, v) => `${((v - c.min) / (c.max - c.min)) * 100}%`;
function formatValue(c, v) {
  const text = Math.abs(v).toFixed(c.digits);
  if (Number(text) === 0) return text;
  if (v < 0) return `−${text}`;
  return c.signed ? `+${text}` : text;
}
function parseValue(text) {
  const n = Number.parseFloat(String(text).replace(/[−–]/g, "-").replace(/[^\d.+-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const state = {
  library: null,
  bases: {},
  source: null,
  clips: [],
  byName: new Map(),
  grades: {},
  selected: new Set(),
  primary: null,
  clipboard: null,
  mode: 0,
  split: 0.5,
  jobs: null,
  error: null,
  input: null,
  filter: ["all", "graded", "ungraded"].includes(store.get("grade.filter")) ? store.get("grade.filter") : "all",
  /** The server's /api/ledger answer: the ledger and whether it's saved to Cloudflare. */
  ledger: null,
  /** The ledger's clips by name without extension, any case. */
  ledgerByClip: new Map(),
};

const viewer = new Viewer($("canvas"));
const video = $("video");
viewer.attach(video);

// ---- helpers ----------------------------------------------------------------------------------------------------

const baseIds = (clip) => (state.bases[clip.profile] ?? []).map((b) => b.id);
const gradeOf = (clip) => resolveGrade(state.grades[clip.name], baseIds(clip));
const label = (clip) => {
  const m = /^DJI_\d{8}(\d{2})(\d{2})\d{2}_(\d+)/.exec(clip.stem);
  return m ? { title: m[3], time: `${m[1]}:${m[2]}` } : { title: clip.stem, time: "" };
};
/** A file size as Finder shows it (decimal units): 980 KB, 8.4 MB, 104 MB, 1.2 GB. */
function fileSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e7) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
const primaryClip = () => state.byName.get(state.primary);

/**
 * Whether a clip has a grade made here: not the one it starts with (a reset clip is back to it), nor the look an
 * offload gives log clips nobody graded. The server counts each day's the same way.
 */
const hasGrade = (clip) => isGraded(state.grades[clip.name], baseIds(clip), state.library?.defaultLook);

// ---- base looks and LUTs ------------------------------------------------------------------------------------------

const baseCache = new Map();
function loadBase(profile, id) {
  if (id === "none") return Promise.resolve(null);
  const k = `${profile}/${id}`;
  if (!baseCache.has(k))
    baseCache.set(
      k,
      api(`/api/lut/${profile}/${encodeURIComponent(id)}`)
        .then(async (res) => ({ size: Number(res.headers.get("X-Lut-Size")), data: new Float32Array(await res.arrayBuffer()), min: [0, 0, 0], max: [1, 1, 1] }))
        .catch((e) => {
          baseCache.delete(k);
          throw e;
        }),
    );
  return baseCache.get(k);
}

async function lutFor(clip, size, input = null) {
  const grade = gradeOf(clip);
  const base = await loadBase(clip.profile, grade.base);
  return composeLut({ profile: clip.profile, grade, shotK: clip.cameraKelvin, base, size, input });
}

/**
 * Decode the calibration ramp the way proxies are decoded and compare it with what ffmpeg reads, so the preview
 * starts from the same code values a render does. Without it the preview still works, uncorrected.
 */
async function calibrate() {
  try {
    const cal = await (await api("/api/calibration")).json();
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    const loaded = new Promise((resolve, reject) => {
      v.addEventListener("loadeddata", resolve, { once: true });
      v.addEventListener("error", () => reject(new Error("calibration clip failed to load")), { once: true });
    });
    v.src = cal.video;
    await loaded;
    v.currentTime = 0.5;
    await new Promise((resolve) => v.addEventListener("seeked", resolve, { once: true }));
    const { px, width, height } = viewer.measure(v);
    if (width !== 1280 || height !== 720) throw new Error("calibration clip decoded at the wrong size");
    const measured = blockMeans(px, 4);
    // Only correct a decoder that is measurably off; a good one is left untouched rather than fitted to noise.
    const off = Math.max(...measured.slice(8, 248).flatMap((m, i) => m.map((x, k) => Math.abs(x - cal.expected[i + 8][k]) * 255)));
    if (off > 1.5) state.input = inputCurves(measured, cal.expected);
  } catch (e) {
    state.input = null;
    console.warn("decoder calibration skipped:", e);
  }
}

let previewVersion = 0;
let fineTimer = null;
let previewQueued = false;
function schedulePreview() {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(() => {
    previewQueued = false;
    refreshPreview();
  });
}
async function refreshPreview() {
  const clip = primaryClip();
  if (!clip) return;
  const v = ++previewVersion;
  clearTimeout(fineTimer);
  try {
    // The decoder correction is measured on the proxy's path; the original takes the Mac's own decoder instead.
    const input = playsOriginal(clip) ? null : state.input;
    const coarse = await lutFor(clip, 33, input);
    if (v !== previewVersion) return;
    viewer.setLut(33, coarse);
    fineTimer = setTimeout(async () => {
      const fine = await lutFor(clip, 65, input);
      if (v === previewVersion) viewer.setLut(65, fine);
    }, 250);
  } catch (e) {
    showError(e);
  }
}

// Clip-list thumbnails: the ungraded still through the clip's own grade, on the CPU.
const thumbImages = new Map();
function thumbImage(clip) {
  const k = `${state.source}/${clip.stem}`;
  if (!thumbImages.has(k))
    thumbImages.set(
      k,
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => {
          thumbImages.delete(k);
          reject(new Error("thumbnail failed"));
        };
        img.src = `/media/${encodeURIComponent(state.source)}/thumb/${encodeURIComponent(clip.stem)}.jpg`;
      }),
    );
  return thumbImages.get(k);
}
// A day can hold hundreds of clips, so thumbnails are graded only once their row scrolls into view.
const thumbTimers = new Map();
const visibleRows = new Set();
const pendingThumbs = new Set();
const rowObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const name = entry.target.dataset.name;
      if (entry.isIntersecting) {
        visibleRows.add(name);
        if (pendingThumbs.has(name)) scheduleThumb(state.byName.get(name));
      } else visibleRows.delete(name);
    }
  },
  { root: $("clip-list").parentElement, rootMargin: "200px" },
);
function scheduleThumb(clip) {
  if (!clip) return;
  if (!visibleRows.has(clip.name)) {
    pendingThumbs.add(clip.name);
    return;
  }
  pendingThumbs.delete(clip.name);
  clearTimeout(thumbTimers.get(clip.name));
  thumbTimers.set(clip.name, setTimeout(() => drawThumb(clip).catch(() => {}), 120));
}
async function drawThumb(clip) {
  if (!clip.thumb) return;
  const img = await thumbImage(clip);
  const data = await lutFor(clip, 17);
  const canvas = document.querySelector(`.clip[data-name="${CSS.escape(clip.name)}"] canvas`);
  if (!canvas) return;
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const lut = { size: 17, data, min: [0, 0, 0], max: [1, 1, 1] };
  const d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    const o = sampleTetra(lut, d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
    d[i] = o[0] * 255 + 0.5;
    d[i + 1] = o[1] * 255 + 0.5;
    d[i + 2] = o[2] * 255 + 0.5;
  }
  ctx.putImageData(px, 0, 0);
}

// ---- library and sources ------------------------------------------------------------------------------------------

/** Every source the picker can open: the camera's days (when it's plugged in), then the days in Movies/Original. */
const allSources = () => [...(state.library?.camera.days ?? []), ...(state.library?.folders ?? [])];
const sourceInfo = (id) => allSources().find((s) => s.id === id);
const sourceLabel = (s) =>
  `${dayLabel(s.label)} · ${s.clips} clip${s.clips === 1 ? "" : "s"}${s.graded ? ` · ${s.graded} graded` : ""}`;

/** The picker's Cloudflare days, and bringing their clips to this Mac. */
const bring = bringView({
  api,
  fileSize,
  label,
  openClip,
  say: (text) => setStatus(text, { first: true }),
  poll,
  changed: () => state.library && renderPicker(),
});

function renderPicker() {
  const { camera, folders } = state.library;
  const sel = $("shoot");
  const group = (labelText, items) => {
    const og = document.createElement("optgroup");
    og.label = labelText;
    for (const s of items) {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = sourceLabel(s);
      og.append(o);
    }
    return og;
  };
  const groups = [];
  if (camera.mounted) groups.push(group(camera.name, camera.days));
  else if (state.source?.startsWith("camera:")) {
    // Keep the open day listed while the camera is away, so the picker doesn't jump to another folder.
    const og = group(`${camera.name} · not connected`, []);
    const o = document.createElement("option");
    o.value = state.source;
    o.textContent = dayLabel(state.source.slice("camera:".length));
    og.append(o);
    groups.push(og);
  }
  if (folders.length) groups.push(group("On this Mac", folders));
  sel.replaceChildren(...groups, ...bring.groups());
  // With nothing open, nothing looks picked: a day in Cloudflare is only opened by picking it.
  sel.value = state.source ?? "";
}

async function loadLibrary() {
  const [library, bases] = await Promise.all([api("/api/library").then((r) => r.json()), api("/api/bases").then((r) => r.json())]);
  state.library = library;
  state.bases = bases;
  renderPicker();
}

/** Opens a day in Cloudflare: none of its clips are here, so there's nothing to grade, only to bring. */
async function openCloud(id) {
  await save();
  state.source = id;
  $("shoot").value = id;
  state.clips = [];
  state.byName = new Map();
  state.grades = {};
  state.selected = new Set();
  renderList();
  setPrimary(null);
  await bring.show(id);
}

async function openSource(id) {
  if (isCloud(id)) return openCloud(id);
  await save();
  state.source = id;
  $("shoot").value = id;
  bring.show(null);
  store.set("grade.source", id);
  const payload = await (await api(`/api/sources/${encodeURIComponent(id)}`)).json();
  state.clips = payload.clips;
  state.byName = new Map(state.clips.map((c) => [c.name, c]));
  state.grades = payload.grades ?? {};
  const remembered = store.get(`grade.selection.${id}`) ?? [];
  state.selected = new Set(remembered.filter((n) => state.byName.has(n)));
  if (!state.selected.size && state.clips[0]) state.selected.add(state.clips[0].name);
  renderList();
  setPrimary([...state.selected].pop() ?? null);
}

/** Clips brought to the open day join its list, leaving the one on screen and what's selected as they are. */
function addArrived({ clips, grades }) {
  const arrived = clips.filter((c) => !state.byName.has(c.name));
  if (!arrived.length) return;
  for (const clip of arrived) if (grades[clip.name]) state.grades[clip.name] = grades[clip.name];
  state.clips = [...state.clips, ...arrived].sort((a, b) => (a.name < b.name ? -1 : 1));
  state.byName = new Map(state.clips.map((c) => [c.name, c]));
  const list = $("clip-list");
  for (const [i, clip] of state.clips.entries())
    if (arrived.includes(clip)) list.insertBefore(clipRow(clip), list.children[i] ?? null);
  updateRows();
}

/** Pick up thumbnails and previews that finished, keeping grades edited here. */
async function refreshSource() {
  if (!state.source || isCloud(state.source)) return;
  const payload = await (await api(`/api/sources/${encodeURIComponent(state.source)}`)).json();
  if (payload.id === state.source) addArrived(payload);
  for (const fresh of payload.clips) {
    const clip = state.byName.get(fresh.name);
    if (!clip) continue;
    const proxyReady = clip.proxy !== "ready" && fresh.proxy === "ready";
    const thumbReady = !clip.thumb && fresh.thumb;
    Object.assign(clip, fresh);
    if (thumbReady) scheduleThumb(clip);
    if (proxyReady && clip.name === state.primary && !playsOriginal(clip)) loadVideo(clip);
  }
}

/**
 * Ask for a preview of the clip on screen, made off the card on request. Only that one: selecting a whole day to grade
 * it at once must not set off hundreds of previews read off the card.
 */
let prepareTimer = null;
function prepareSelection() {
  clearTimeout(prepareTimer);
  prepareTimer = setTimeout(async () => {
    // The preview plays originals, so only an HLG clip needs a proxy made.
    const clip = primaryClip();
    const names = clip && clip.proxy !== "ready" && !playsOriginal(clip) ? [clip.name] : [];
    if (!names.length || !state.source) return;
    try {
      await api(`/api/sources/${encodeURIComponent(state.source)}/prepare`, { method: "POST", json: { names } });
      for (const n of names) if (state.byName.get(n).proxy === "none") state.byName.get(n).proxy = "queued";
      poll();
    } catch (e) {
      showError(e);
    }
  }, 150);
}

// ---- clip list ----------------------------------------------------------------------------------------------------

/** The clip list's filter: everything, only clips with a grade, or only clips without one. */
const shown = (clip) => {
  if (state.filter === "graded") return hasGrade(clip);
  if (state.filter === "ungraded") return !hasGrade(clip);
  return true;
};
const visibleClips = () => state.clips.filter(shown);

function renderList() {
  const list = $("clip-list");
  rowObserver.disconnect();
  visibleRows.clear();
  list.replaceChildren(...state.clips.map(clipRow));
  updateRows();
}

function clipRow(clip) {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.type = "button";
  b.className = "clip";
  b.dataset.name = clip.name;
  const { title, time } = label(clip);
  b.innerHTML =
    '<canvas class="thumb" width="16" height="9"></canvas><span class="info"><span class="title-row"><b></b><span class="when"></span><span class="state"></span></span><span class="sub-row"><span class="profile"></span><span class="size"></span></span></span>';
  b.querySelector("b").textContent = title;
  b.querySelector(".when").textContent = [time, `${clip.duration.toFixed(1)} s`].filter(Boolean).join(" · ");
  b.querySelector(".size").textContent = clip.bytes ? fileSize(clip.bytes) : "";
  b.querySelector(".profile").textContent = PROFILE_NAMES[clip.profile];
  b.title = `${clip.name} · ${clip.width}×${clip.height}`;
  li.append(b);
  rowObserver.observe(b);
  pendingThumbs.add(clip.name);
  return li;
}

/** That a trim or preview copy was, or is being, encoded on the CPU because the GPU couldn't, and why. */
const onCpu = ({ fallback }) => (fallback ? ` on the CPU, the GPU couldn't: ${fallback}` : "");
function updateRows() {
  for (const b of document.querySelectorAll(".clip")) {
    const clip = state.byName.get(b.dataset.name);
    if (!clip) continue;
    b.setAttribute("aria-pressed", String(state.selected.has(clip.name)));
    b.classList.toggle("primary-clip", clip.name === state.primary && state.selected.size > 1);
    b.parentElement.hidden = !shown(clip);
    const chip = b.querySelector(".state");
    const own = hasGrade(clip);
    const text = own ? "Graded" : "Not graded";
    // Just the dot; the words stay for screen readers and as its tooltip.
    chip.className = `state ${own ? "ok" : "none"}`;
    chip.title = text;
    const words = document.createElement("span");
    words.className = "sr-only";
    words.textContent = text;
    chip.replaceChildren(words);
  }
  const n = state.selected.size;
  const graded = state.clips.filter(hasGrade).length;
  $("clip-count").textContent = n > 1 ? `${n} selected` : `${graded} of ${state.clips.length} graded`;
  $("select-all").textContent = n === visibleClips().length && n > 1 ? "Select one" : "Select all";
  for (const b of document.querySelectorAll("#filter button")) b.setAttribute("aria-pressed", String(b.dataset.filter === state.filter));
  const reachable = !state.source?.startsWith("camera:") || state.library?.camera.mounted !== false;
  $("export-frame").disabled = !primaryClip() || !reachable;
  // A clip on the card or this Mac; a day in the cloud has none here, and an unplugged camera's aren't anywhere.
  $("reveal").hidden = !primaryClip() || !reachable;
}

$("clip-list").addEventListener("click", (e) => {
  const b = e.target.closest(".clip");
  if (!b) return;
  const name = b.dataset.name;
  if (e.shiftKey && state.primary) {
    const names = visibleClips().map((c) => c.name);
    const [a, z] = [names.indexOf(state.primary), names.indexOf(name)].sort((x, y) => x - y);
    if (a >= 0) for (const n of names.slice(a, z + 1)) state.selected.add(n);
  } else if (e.metaKey || e.ctrlKey) {
    if (state.selected.has(name) && state.selected.size > 1) {
      state.selected.delete(name);
      if (state.primary === name) return setPrimary([...state.selected].pop());
      return afterSelection();
    }
    state.selected.add(name);
  } else state.selected = new Set([name]);
  setPrimary(name);
});

$("select-all").addEventListener("click", () => {
  const visible = visibleClips();
  const all = state.selected.size === visible.length && visible.length > 1;
  state.selected = all ? new Set(state.primary ? [state.primary] : []) : new Set(visible.map((c) => c.name));
  afterSelection();
});

$("filter").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-filter]");
  if (!b) return;
  state.filter = b.dataset.filter;
  store.set("grade.filter", state.filter);
  updateRows();
});

function afterSelection() {
  store.set(`grade.selection.${state.source}`, [...state.selected]);
  updateRows();
  updatePanel();
  prepareSelection();
}

function setPrimary(name) {
  state.primary = name;
  if (name) state.selected.add(name);
  const clip = primaryClip();
  loadVideo(clip);
  afterSelection();
  refreshPreview();
}

// ---- video and viewer ---------------------------------------------------------------------------------------------

/**
 * The preview plays the original itself at full size, decoded by the Mac (still 8-bit on the GPU: Chrome hands video
 * to WebGL at 8 bits, so judge banding on a render).
 * HLG plays a proxy: its HDR transfer tag invites the browser to tone-map it, which would bend what the grade sees.
 */
const playsOriginal = (clip) => clip?.profile !== "hlg";

function loadVideo(clip) {
  const playing = !video.paused;
  viewer.hasFrame = false;
  if (clip && playsOriginal(clip)) {
    $("empty").hidden = true;
    $("canvas").hidden = false;
    video.src = `/media/${encodeURIComponent(state.source)}/original/${encodeURIComponent(clip.name)}`;
    if (playing) video.play().catch(() => {});
    return;
  }
  if (!clip || clip.proxy !== "ready") {
    video.removeAttribute("src");
    video.load();
    $("canvas").hidden = true;
    $("empty").hidden = false;
    if (!clip) $("empty").textContent = "Pick a clip.";
    else if (clip.proxy === "failed") $("empty").textContent = `The preview failed: ${clip.proxyError}`;
    else $("empty").textContent = "Preparing the preview…";
    placeOverlays();
    return;
  }
  $("empty").hidden = true;
  $("canvas").hidden = false;
  video.src = `/media/${encodeURIComponent(state.source)}/proxy/${encodeURIComponent(clip.stem)}.mp4`;
  if (playing) video.play().catch(() => {});
}

// Fullscreen: the viewer and its transport fill the screen; Esc or F leaves.
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else $("stage").requestFullscreen().catch(() => setStatus("The browser didn't allow full screen; click the button or press F to try again"));
}
$("fullscreen").addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  const on = Boolean(document.fullscreenElement);
  setIcon($("fullscreen"), on ? "i-shrink" : "i-expand", on ? "Exit full screen" : "Full screen");
  requestAnimationFrame(placeOverlays);
});

function placeOverlays() {
  const canvas = $("canvas");
  const frame = $("frame");
  const r = canvas.getBoundingClientRect();
  const f = frame.getBoundingClientRect();
  const visible = !canvas.hidden && r.width > 0;
  const line = $("split-line");
  line.hidden = !visible || state.mode !== 2;
  line.style.left = `${r.left - f.left + state.split * r.width - 1}px`;
  line.style.top = `${r.top - f.top}px`;
  line.style.height = `${r.height}px`;
  const left = $("tag-left");
  const right = $("tag-right");
  left.hidden = !visible || state.mode === 0;
  right.hidden = !visible || state.mode !== 2;
  left.style.left = `${r.left - f.left + 8}px`;
  left.style.top = `${r.top - f.top + 8}px`;
  right.style.right = `${f.right - r.right + 8}px`;
  right.style.top = `${r.top - f.top + 8}px`;
  frame.classList.toggle("splitting", state.mode === 2);
}
new ResizeObserver(placeOverlays).observe($("frame"));
video.addEventListener("loadedmetadata", () => requestAnimationFrame(placeOverlays));

function setMode(mode) {
  state.mode = mode;
  viewer.setMode(mode, state.split);
  for (const b of document.querySelectorAll("#mode button")) b.setAttribute("aria-pressed", String(Number(b.dataset.mode) === mode));
  placeOverlays();
}
$("mode").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) setMode(Number(b.dataset.mode));
});

let dragging = false;
const splitFrom = (e) => {
  const r = $("canvas").getBoundingClientRect();
  state.split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  viewer.setMode(state.mode, state.split);
  placeOverlays();
};
$("canvas").addEventListener("pointerdown", (e) => {
  if (state.mode !== 2) return;
  dragging = true;
  $("canvas").setPointerCapture(e.pointerId);
  splitFrom(e);
});
$("canvas").addEventListener("pointermove", (e) => dragging && splitFrom(e));
$("canvas").addEventListener("pointerup", () => {
  dragging = false;
});

const togglePlay = () => (video.paused ? video.play().catch(() => {}) : video.pause());
$("play").addEventListener("click", togglePlay);
function setIcon(button, id, text) {
  button.querySelector("use").setAttribute("href", `#${id}`);
  button.setAttribute("aria-label", text);
  button.title = text;
}
video.addEventListener("play", () => setIcon($("play"), "i-pause", "Pause"));
video.addEventListener("pause", () => setIcon($("play"), "i-play", "Play"));

/** Timecode HH:MM:SS:FF at the clip's frame rate (23.976 counts as 24, non-drop). */
function timecode(seconds) {
  const rate = primaryClip()?.fps || 24;
  const fps = Math.max(1, Math.round(rate));
  const frames = Math.round((seconds || 0) * rate);
  const f = frames % fps;
  const s = Math.floor(frames / fps);
  const two = (n) => String(n).padStart(2, "0");
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}:${two(f)}`;
}
function showTime() {
  const d = video.duration || 0;
  const at = d ? video.currentTime / d : 0;
  if (!scrubbing) $("scrub").value = at;
  $("scrub-rail").style.setProperty("--b", `${at * 100}%`);
  $("tc-now").textContent = timecode(video.currentTime);
  $("tc-dur").textContent = timecode(d);
}
for (const ev of ["timeupdate", "loadedmetadata", "seeked", "emptied"]) video.addEventListener(ev, showTime);
video.addEventListener("play", function tick() {
  if (video.paused) return;
  showTime();
  requestAnimationFrame(tick);
});
let scrubbing = false;
$("scrub").addEventListener("pointerdown", () => {
  scrubbing = true;
});
$("scrub").addEventListener("pointerup", () => {
  scrubbing = false;
});
$("scrub").addEventListener("input", () => {
  if (video.duration) video.currentTime = Number($("scrub").value) * video.duration;
  showTime();
});
$("mute").addEventListener("click", () => {
  video.muted = !video.muted;
  setIcon($("mute"), video.muted ? "i-muted" : "i-sound", video.muted ? "Unmute" : "Mute");
  $("mute").setAttribute("aria-pressed", String(!video.muted));
});
$("loop").addEventListener("click", () => {
  video.loop = !video.loop;
  $("loop").setAttribute("aria-pressed", String(video.loop));
});

// ---- grade panel --------------------------------------------------------------------------------------------------

/** Arrow-key steps: ⇧ moves ten steps, ⌥ a tenth of one. */
function stepMultiplier(e) {
  if (e.shiftKey) return 10;
  if (e.altKey) return 0.1;
  return 1;
}

/** The primary clip's current value for a control. */
function currentValue(c) {
  const clip = primaryClip();
  return clip ? controlValue(c, gradeOf(clip), clip) : c.neutral ?? c.min;
}

function buildControls() {
  for (const c of CONTROLS) {
    const row = document.createElement("div");
    row.className = "ctl";
    row.dataset.field = c.field;
    row.innerHTML =
      `<label class="ctl-label" for="n-${c.field}"><span class="name"></span><span class="mixed" hidden>Mixed</span></label>` +
      `<span class="value"><input class="num" id="n-${c.field}" inputmode="decimal" spellcheck="false" autocomplete="off"><span class="unit"></span></span>` +
      `<span class="rail${c.rail ? ` ${c.rail}` : ""}"><span class="tick" hidden></span><input type="range" id="c-${c.field}" min="${c.min}" max="${c.max}" step="${c.step}"></span>`;
    row.querySelector(".name").textContent = c.label;
    row.querySelector("input[type=range]").setAttribute("aria-label", c.label);
    row.querySelector(".num").setAttribute("aria-label", `${c.label} value`);
    document.querySelector(`.controls[data-group="${c.group}"]`).append(row);

    const range = row.querySelector("input[type=range]");
    range.addEventListener("input", () => setField(c.field, Number(range.value)));
    range.addEventListener("dblclick", () => setField(c.field, c.reset));

    // The number: type a value, Enter or leave to apply, Escape to undo, arrows to step (⇧ ×10, ⌥ ÷10).
    const num = row.querySelector(".num");
    const commit = () => {
      const v = parseValue(num.value);
      if (v === null || snap(c, v) === currentValue(c)) return updatePanel();
      setField(c.field, snap(c, v));
    };
    num.addEventListener("focus", () => num.select());
    num.addEventListener("blur", commit);
    num.addEventListener("keydown", (e) => {
      if (e.key === "Enter") num.blur();
      else if (e.key === "Escape") {
        updatePanel();
        num.blur();
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const v = snap(c, currentValue(c) + (e.key === "ArrowUp" ? 1 : -1) * c.step * stepMultiplier(e));
        setField(c.field, v);
        num.value = formatValue(c, v);
        num.select();
      }
    });

    // The name: drag sideways to scrub the value (⇧ for fine), double-click to reset, click to type.
    const name = row.querySelector(".ctl-label");
    let moved = false;
    name.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const start = e.clientX;
      const from = currentValue(c);
      moved = false;
      name.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = ev.clientX - start;
        if (!moved && Math.abs(dx) < 3) return;
        moved = true;
        setField(c.field, snap(c, from + (dx * (c.max - c.min) * (ev.shiftKey ? 0.2 : 1)) / 320));
      };
      const up = () => {
        name.removeEventListener("pointermove", move);
        name.removeEventListener("pointerup", up);
        name.removeEventListener("pointercancel", up);
      };
      name.addEventListener("pointermove", move);
      name.addEventListener("pointerup", up);
      name.addEventListener("pointercancel", up);
    });
    name.addEventListener("click", (e) => {
      if (moved) e.preventDefault();
    });
    name.addEventListener("dblclick", (e) => {
      e.preventDefault();
      setField(c.field, c.reset);
    });
  }
  for (const b of document.querySelectorAll("[data-reset-group]")) {
    b.addEventListener("click", () => {
      for (const c of CONTROLS.filter((x) => x.group === b.dataset.resetGroup)) setField(c.field, c.reset);
    });
  }
}

function updatePanel() {
  const clip = primaryClip();
  const n = state.selected.size;
  const disabled = !clip;
  for (const el of document.querySelectorAll(".panel input, .panel select, .look-step, #deflicker button, #copy, #reset, [data-reset-group]")) el.disabled = disabled;
  $("paste").disabled = disabled || !state.clipboard;
  renderKept();
  if (!clip) {
    $("editing").textContent = "\u00a0";
    $("clip-title").textContent = "—";
    $("clip-meta").replaceChildren();
    return;
  }
  const g = gradeOf(clip);
  const { title, time } = label(clip);
  $("editing").textContent = n > 1 ? `${n} clips selected · showing` : "Selected clip";
  $("clip-title").textContent = `${title}${time ? ` · ${time}` : ""}`;
  $("clip-meta").replaceChildren(
    ...[
      PROFILE_NAMES[clip.profile],
      clip.iso && `ISO ${clip.iso}`,
      clip.cameraKelvin && `${clip.cameraKelvin} K`,
      `${clip.width}×${clip.height}`,
      `${clip.fps.toFixed(2)} fps`,
      `${clip.duration.toFixed(1)} s`,
    ]
      .filter(Boolean)
      .map((text) => {
        const s = document.createElement("span");
        s.textContent = text;
        return s;
      }),
  );

  const sel = $("base");
  const groups = new Map();
  for (const b of state.bases[clip.profile] ?? []) {
    if (!groups.has(b.group)) groups.set(b.group, []);
    groups.get(b.group).push(b);
  }
  sel.replaceChildren(
    ...[...groups].map(([group, list]) => {
      const og = document.createElement("optgroup");
      og.label = group;
      for (const b of list) {
        const o = document.createElement("option");
        o.value = b.id;
        o.textContent = b.name;
        og.append(o);
      }
      return og;
    }),
  );
  sel.value = g.base;

  const others = [...state.selected].filter((x) => x !== clip.name).map((x) => state.byName.get(x));
  for (const c of CONTROLS) {
    const row = document.querySelector(`.ctl[data-field="${c.field}"]`);
    const value = controlValue(c, g, clip);
    row.querySelector("input[type=range]").value = value;
    const num = row.querySelector(".num");
    if (document.activeElement !== num) num.value = formatValue(c, value);
    row.querySelector(".unit").textContent = c.unit(value);
    const mixed = others.some((o) => controlValue(c, gradeOf(o), o) !== value);
    row.querySelector(".mixed").hidden = !mixed;
    const reference = c.tick ? c.tick(clip) : c.neutral;
    row.classList.toggle("changed", value !== reference);
    const rail = row.querySelector(".rail");
    if (!c.rail) {
      rail.style.setProperty("--a", pct(c, Math.min(c.neutral, value)));
      rail.style.setProperty("--b", pct(c, Math.max(c.neutral, value)));
    }
    const tick = rail.querySelector(".tick");
    tick.hidden = reference === undefined;
    if (reference !== undefined) {
      tick.style.left = pct(c, reference);
      tick.title = c.tickTitle ? c.tickTitle(clip) : "";
    }
  }

  const level = deflickerOf(clip);
  for (const b of document.querySelectorAll("#deflicker button"))
    b.setAttribute("aria-pressed", String(b.dataset.deflicker === level));
  const flicker = document.querySelector('.ctl[data-field="deflicker"]');
  flicker.classList.toggle("changed", level !== "");
  flicker.querySelector(".mixed").hidden = !others.some((o) => deflickerOf(o) !== level);
}

$("base").addEventListener("change", (e) => setField("base", e.target.value));

/** Move the look `delta` places through the picker's own order, wrapping at the ends. */
function stepLook(delta) {
  const sel = $("base");
  const ids = [...sel.options].map((o) => o.value);
  if (!ids.length) return;
  const i = Math.max(0, ids.indexOf(sel.value));
  setField("base", ids[(i + delta + ids.length) % ids.length]);
}
$("base-prev").addEventListener("click", () => stepLook(-1));
$("base-next").addEventListener("click", () => stepLook(1));

// Deflicker: Off, Light or Strong, set on every selected clip. Only renders and Export frame do it, so the preview stays as is.
// ← → step through the choices as they step a slider, and double-clicking the name (or the group's Reset) turns it off.
const deflickerOf = (clip) => gradeOf(clip).deflicker ?? "";
const deflickerLevels = [...document.querySelectorAll("#deflicker button")].map((b) => b.dataset.deflicker);
// Off is no field at all (undefined isn't saved), so a clip turned back off keys as it did before.
const setDeflicker = (level) => setField("deflicker", level || undefined);
$("deflicker").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) setDeflicker(b.dataset.deflicker);
});
$("deflicker").addEventListener("keydown", (e) => {
  const clip = primaryClip();
  if (!clip || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
  e.preventDefault();
  const i = deflickerLevels.indexOf(deflickerOf(clip)) + (e.key === "ArrowRight" ? 1 : -1);
  const level = deflickerLevels[Math.min(deflickerLevels.length - 1, Math.max(0, i))];
  setDeflicker(level);
  document.querySelector(`#deflicker button[data-deflicker="${level}"]`).focus();
});
$("deflicker-name").addEventListener("dblclick", () => setDeflicker(""));
document.querySelector('[data-reset-group="light"]').addEventListener("click", () => setDeflicker(""));

const dirty = new Set();
let saveTimer = null;
function touched(names) {
  for (const name of names) {
    dirty.add(name);
    scheduleThumb(state.byName.get(name));
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
  schedulePreview();
  updatePanel();
  updateRows();
}

function setField(field, value) {
  const names = [];
  for (const name of state.selected) {
    const clip = state.byName.get(name);
    if (field === "base" && !baseIds(clip).includes(value)) continue;
    state.grades[name] = { ...gradeOf(clip), [field]: value };
    names.push(name);
  }
  touched(names);
}

async function save({ keepalive = false } = {}) {
  clearTimeout(saveTimer);
  if (!dirty.size || !state.source) return;
  const names = [...dirty];
  dirty.clear();
  const clips = Object.fromEntries(names.map((n) => [n, state.grades[n]]));
  try {
    await api(`/api/sources/${encodeURIComponent(state.source)}/grades`, { method: "PUT", json: { clips }, keepalive });
  } catch (e) {
    for (const n of names) dirty.add(n);
    showError(e);
  }
}
window.addEventListener("pagehide", () => save({ keepalive: true }));

$("copy").addEventListener("click", copyGrade);
$("paste").addEventListener("click", pasteGrade);
$("reset").addEventListener("click", () => {
  for (const name of state.selected) state.grades[name] = { base: null };
  touched([...state.selected]);
});
function copyGrade() {
  const clip = primaryClip();
  if (!clip) return;
  state.clipboard = gradeOf(clip);
  $("paste").disabled = false;
  setStatus(`Copied the grade of ${label(clip).title}`);
}
function pasteGrade() {
  if (!state.clipboard) return;
  for (const name of state.selected) state.grades[name] = { ...state.clipboard };
  touched([...state.selected]);
}

// ---- Export frame, the bar's menus, jobs ----------------------------------------------------------------------------

/** Save the frame on screen, graded, as a full-size PNG in Movies/Exported. */
async function exportFrame() {
  const clip = primaryClip();
  if (!clip || !state.source) return;
  const frame = Math.floor(video.currentTime * clip.fps + 1e-3);
  await save();
  setStatus(`Exporting frame ${frame} of ${label(clip).title}…`, { first: true });
  try {
    const res = await api("/api/export-frame", { method: "POST", json: { source: state.source, name: clip.name, frame } });
    const { file } = await res.json();
    setStatus(`Saved frame ${frame} of ${label(clip).title} as ${file}`, { first: true });
  } catch (e) {
    showError(e);
  }
}

$("export-frame").addEventListener("click", exportFrame);

/** Open in Finder: the clip on screen, selected in a Finder window. */
$("reveal").addEventListener("click", async () => {
  const clip = primaryClip();
  if (!clip || !state.source) return;
  try {
    await api("/api/reveal", { method: "POST", json: { source: state.source, name: clip.name } });
  } catch (e) {
    showError(e);
  }
});

const encoderButtons = document.querySelectorAll("[data-encoder]");
/** The settings as the server keeps them: what encodes trims and preview copies, and remaking those after a regrade. */
function renderSettings() {
  for (const b of encoderButtons)
    b.setAttribute("aria-pressed", String(b.dataset.encoder === (state.jobs?.export.encoder ?? "gpu")));
  $("previews-remake").checked = Boolean(state.jobs?.previews?.autoRemake);
}

/** The bar's menus, each opened by its button: Offload, and Settings. One is open at a time. */
const menus = [
  { group: $("offload-group"), button: $("offload-more"), menu: $("offload-menu"), opened: () => offload.load() },
  { group: $("settings-group"), button: $("settings-more"), menu: $("settings-menu"), opened: renderSettings },
];
const openMenu = () => menus.find((m) => !m.menu.hidden);
function setMenu(which, open) {
  for (const m of menus) {
    const on = open && m === which;
    m.menu.hidden = !on;
    m.button.setAttribute("aria-expanded", String(on));
  }
  if (open) which.opened();
}
for (const m of menus) m.button.addEventListener("click", () => setMenu(m, m.menu.hidden));
document.addEventListener("pointerdown", (e) => {
  const m = openMenu();
  if (m && !m.group.contains(e.target)) setMenu(m, false);
});
for (const b of encoderButtons)
  b.addEventListener("click", async () => {
    try {
      await api("/api/export/encoder", { method: "POST", json: { encoder: b.dataset.encoder } });
    } catch (e) {
      return showError(e);
    }
    poll();
  });
$("previews-remake").addEventListener("change", async (e) => {
  try {
    await api("/api/previews/options", { method: "POST", json: { autoRemake: e.target.checked } });
  } catch (error) {
    e.target.checked = !e.target.checked;
    return showError(error);
  }
  poll();
});

// ---- moving clips to the Trash (⌘⌫) -------------------------------------------------------------------------------

// More than this many clips at once asks for a second press: a day on the card can hold hundreds.
const CONFIRM_OVER = 10;
/** When a pending ⌘⌫ for more than CONFIRM_OVER clips stops waiting for its confirming second press. */
let trashArmedUntil = 0;
/** A ⌘⌫ is on its way: another press until it lands would send the same clips again. */
let trashBusy = false;

/**
 * Move the selected clips in the list, each with the files the camera wrote beside it (the .LRF), to the Trash: the
 * card's own for a camera day, so Finder can put them back. Their grades and graded copies stay.
 */
async function trashSelected() {
  if (!state.source || trashBusy) return;
  const names = visibleClips().filter((c) => state.selected.has(c.name)).map((c) => c.name);
  if (!names.length) return;
  if (names.length > CONFIRM_OVER && Date.now() > trashArmedUntil) {
    trashArmedUntil = Date.now() + 3000;
    return setStatus(`Press ⌘⌫ again to move ${names.length} clips to the Trash`, { first: true });
  }
  trashArmedUntil = 0;
  // Land on the clip after the one on screen, or the one before it at the end of the list.
  const order = visibleClips().map((c) => c.name).filter((n) => n === state.primary || !names.includes(n));
  const at = order.indexOf(state.primary);
  const land = order[at + 1] ?? order[at - 1] ?? null;
  const one = names.length === 1;
  const what = one ? label(state.byName.get(names[0])).title : `${names.length} clips`;
  trashBusy = true;
  try {
    await save();
    const res = await api(`/api/sources/${encodeURIComponent(state.source)}/trash`, { method: "POST", json: { clips: names } });
    const { trashed } = await res.json();
    store.set(`grade.selection.${state.source}`, land ? [land] : []);
    await loadLibrary();
    // A camera day whose last clip went is no longer a source.
    const id = sourceInfo(state.source) ? state.source : defaultSource();
    if (id) await openSource(id);
    const files = one ? trashed.join(", ") : `${trashed.length} files`;
    setStatus(`Moved ${what} to the Trash: ${files}`, { first: true });
  } catch (e) {
    showError(e);
  } finally {
    trashBusy = false;
  }
}

let statusNote = "";
let statusFirst = false;
let statusTimer = null;
/** A note in the status line for three seconds. `first` shows it ahead of what's in progress. */
function setStatus(text, { first = false } = {}) {
  statusNote = text;
  statusFirst = first;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusNote = "";
    renderStatus();
  }, 3000);
  renderStatus();
}
function showError(e) {
  state.error = String(e.message || e);
  renderStatus();
}
function renderStatus() {
  const j = state.jobs;
  const parts = [];
  offload.renderStop(j?.offload);
  // Paused from the composer's Footage tab: nothing new starts here until it goes on there.
  if (j?.paused) parts.push("Paused from the Footage tab");
  const offloading = offloadLine(j?.offload);
  if (offloading) {
    offloadLink.textContent = offloading;
    parts.push(offloadLink);
  }
  const bringLine = bring.text();
  if (bringLine) parts.push(bringLine);
  if (state.source?.startsWith("camera:") && state.library && !state.library.camera.mounted)
    parts.push(`${state.library.camera.name} disconnected: plug it in to preview and export`);
  const preparing = state.clips.filter((c) => c.proxy === "queued" || c.proxy === "working").length;
  if (preparing) parts.push(`Making preview${preparing === 1 ? "" : "s"} · ${preparing} left`);
  if (j?.thumbs) parts.push(`Reading thumbnails · ${j.thumbs} left`);
  for (const line of [filmLine("Cutting trims", "trim", "trims", j?.trims), filmLine("Making preview copies", "preview copy", "preview copies", j?.previews)])
    if (line) parts.push(line);
  if (state.error) parts.push(state.error);
  if (statusNote && (statusFirst || !parts.length)) parts.unshift(statusNote);
  $("status").replaceChildren(...parts.flatMap((part, i) => (i ? [" · ", part] : [part])));
  $("status").title = $("status").textContent;
  $("transcribing").textContent = transcribingText(j?.transcripts);
  $("transcribing").title = j?.transcripts?.error ?? "";
}
/**
 * How a film's preview copies or trims are coming (server's film.mjs): the one being made and how many wait, or that
 * they wait for the exports; and the last that failed.
 */
function filmLine(doing, one, many, q) {
  if (!q) return "";
  const parts = [];
  const left = q.queued.length;
  const named = (job) => state.byName.get(job.name)?.stem ?? job.name;
  if (q.current) parts.push(`${doing} · ${named(q.current)}${onCpu(q.current)} · ${Math.round(q.current.progress * 100)}%${left ? ` · ${left} queued` : ""}`);
  else if (left) parts.push(`${left} ${left === 1 ? one : many} waiting${q.waiting ? " for the exports" : ""}`);
  if (q.failed.length) parts.push(`${q.failed.length} ${q.failed.length === 1 ? one : many} failed: ${q.failed[0].error}`);
  return parts.join(" · ");
}
/** What Whisper is doing, in a few words: the clip it's on, those waiting for an export to end, or those it couldn't do. */
function transcribingText(t) {
  if (t?.current) return `Transcribing ${t.done + 1} of ${t.total}`;
  if (t?.waiting) return `${t.waiting} to transcribe`;
  return t?.failed ? `${t.failed} not transcribed` : "";
}

// ---- offload (offload.mjs) --------------------------------------------------------------------------------------------

const offload = offloadMenu({ api, fileSize, showError, poll });
/**
 * The offload in the status line links to how it stands in the composer's Footage tab, under This Mac: framed by the
 * composer, the composer opens it; in a tab of its own, it opens in another.
 */
const offloadLink = Object.assign(document.createElement("a"), {
  href: "https://post.kualta.dev/footage#this-mac",
  target: "_blank",
  rel: "noreferrer",
});
offloadLink.addEventListener("click", (event) => {
  if (!composer()) return;
  event.preventDefault();
  tellComposer({ type: "grade-footage" });
});

// ---- ledger and the composer ------------------------------------------------------------------------------------------
// The ledger (every clip, its grade, where its copies are) is shown in the composer's Footage tab, post.kualta.dev/footage;
// here it's the line under the selected clip saying where its copies are. The composer's Grade tab shows this app in a
// frame: it asks for a clip to open, says whether it's light or dark, and hears how far the work is for its title.

/** The pages that may frame the app and talk to it; the server's frame-ancestors names the same. */
const COMPOSERS = ["https://post.kualta.dev", "http://localhost:4321", "http://127.0.0.1:4321"];
const framed = window.parent !== window;

let ledgerAt = 0;
async function loadLedger() {
  ledgerAt = Date.now();
  try {
    state.ledger = await (await api("/api/ledger")).json();
  } catch {
    return;
  }
  state.ledgerByClip = new Map(Object.entries(state.ledger.ledger?.clips ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  renderKept();
}

/** Where the selected clip's copies are, in a line under its details. */
function renderKept() {
  const clip = primaryClip();
  const record = clip && state.ledgerByClip.get(clip.stem.toLowerCase());
  if (!record) {
    $("clip-kept").textContent = "";
    return;
  }
  const places = (pairs) => pairs.filter(([, v]) => v).map(([name, v]) => (v === "earlier" ? `${name} (earlier grade)` : name));
  const original = places([["camera", record.original.camera], ["Mac", record.original.mac], ["cloud", record.original.cloudflare]]);
  let text = `Original: ${original.join(", ") || "nowhere"}`;
  // Graded copies aren't kept, and those left in the cloud are old films': only an export here and YouTube's are named.
  if (record.graded) {
    const youtube = record.graded.youtube && (record.graded.youtube.current ? true : "earlier");
    const graded = places([["Mac", record.graded.mac], ["YouTube", youtube]]);
    if (graded.length) text += ` · Graded: ${graded.join(", ")}`;
  }
  $("clip-kept").textContent = text;
}

/** Opens a clip by its name, in the card's day holding it, else Movies/Original's, else Cloudflare's, and selects it. */
async function openClip(clip) {
  try {
    const { source, name } = await (await api(`/api/find?clip=${encodeURIComponent(clip)}`)).json();
    if (state.source !== source) await openSource(source);
    if (isCloud(source)) return bring.select(name);
    state.selected = new Set([name]);
    setPrimary(name);
    document.querySelector(`.clip[data-name="${CSS.escape(name)}"]`)?.scrollIntoView({ block: "nearest" });
  } catch (e) {
    showError(e);
  }
}
/** A clip the address asks for: #clip=DJI_….MP4. */
function openFromAddress() {
  const clip = new URLSearchParams(location.hash.slice(1)).get("clip");
  if (clip) openClip(clip);
}
window.addEventListener("hashchange", openFromAddress);

/** The composer framing the app, when it's one the app talks to. Chrome and Safari say which page that is. */
function composer() {
  const origin = location.ancestorOrigins?.[0];
  return origin && COMPOSERS.includes(origin) ? origin : null;
}
// index.html marks the page framed before it first paints.
if (framed) {
  window.addEventListener("message", (event) => {
    if (!COMPOSERS.includes(event.origin) || event.source !== window.parent) return;
    const { type, clip, theme } = event.data ?? {};
    if (type === "open" && typeof clip === "string") openClip(clip);
    // Light or dark as the composer is, rather than as the Mac is set.
    if (type === "theme" && (theme === "light" || theme === "dark")) document.documentElement.dataset.theme = theme;
  });
}
/** Posts a message to that composer, and to no other page. */
function tellComposer(message) {
  const origin = framed && composer();
  if (origin) window.parent.postMessage(message, origin);
}
/** Tells it how far the offload and the export are: a share of 1 each, or null for one not going or not known. */
function sayProgress(jobs) {
  tellComposer({
    type: "grade-progress",
    // Paused from the Footage tab, the offload isn't going up, so the title lets go of it.
    offload: jobs?.paused ? null : offloadShare(jobs?.offload),
    export: jobs?.export.current?.progress ?? null,
  });
}

let pollTimer = null;
let lastMoves = "";
let libraryAt = 0;
async function poll() {
  clearTimeout(pollTimer);
  let jobs = null;
  try {
    jobs = await (await api("/api/jobs")).json();
    state.jobs = jobs;
    sayProgress(jobs);
    const arrived = bring.update(jobs);
    const waiting = jobs.thumbs > 0 || state.clips.some((c) => c.proxy === "queued" || c.proxy === "working");
    // The library is re-read every few seconds, so the camera appears when it's plugged in and graded counts update.
    const moves = offloadMoves(jobs.offload);
    if (Date.now() - libraryAt > 4000 || moves !== lastMoves || arrived) {
      libraryAt = Date.now();
      const wasMounted = state.library?.camera.mounted;
      state.library = await (await api("/api/library")).json();
      renderPicker();
      const open = sourceInfo(state.source);
      if (!state.source && allSources().length) await openSource(defaultSource());
      else if (state.source?.startsWith("camera:") && state.library.camera.mounted && !wasMounted && open) await openSource(state.source);
      else if (moves !== lastMoves && state.source && !isCloud(state.source)) {
        // Clips the offload took off the card or the Mac leave the open day, or empty it.
        if (open && open.clips !== state.clips.length) await openSource(state.source);
        else if (!open && defaultSource()) await openSource(defaultSource());
      }
      lastMoves = moves;
    }
    // The ledger changes when the server looks again: every 30 seconds, and after exports.
    if (Date.now() - ledgerAt > 20000) await loadLedger();
    const reachable = !state.source?.startsWith("camera:") || state.library?.camera.mounted;
    if (reachable && (waiting || arrived)) await refreshSource();
    renderStatus();
    updateRows();
    const filming = [jobs.previews, jobs.trims].some((q) => q?.current || q?.queued.length);
    const active = jobs.offload?.running || jobs.bring?.running || waiting || filming;
    if (!$("offload-menu").hidden) offload.render(jobs.offload);
    if (!$("settings-menu").hidden) renderSettings();
    pollTimer = setTimeout(poll, active ? 700 : 2500);
  } catch (e) {
    if (!jobs) sayProgress(null);
    showError(e);
    pollTimer = setTimeout(poll, 3000);
  }
}

/** The source to open: the last one used if it's still there, else the camera's newest day, else a Mac folder. */
function defaultSource() {
  const last = store.get("grade.source");
  return sourceInfo(last) ? last : allSources()[0]?.id;
}

// ---- keyboard -----------------------------------------------------------------------------------------------------

let heldMode = null;
document.addEventListener("keydown", (e) => {
  const t = e.target;
  if (t.matches?.("select, textarea, input:not([type=range]):not([type=checkbox])")) return;
  const open = openMenu();
  if (e.key === "Escape" && open) {
    setMenu(open, false);
    open.button.focus();
  } else if (e.key === " " && !(t instanceof HTMLButtonElement)) {
    e.preventDefault();
    togglePlay();
  } else if ((e.key === "f" || e.key === "F") && !e.repeat && !e.metaKey && !e.ctrlKey) {
    toggleFullscreen();
  } else if ((e.key === "b" || e.key === "B") && !e.repeat && !e.metaKey && !e.ctrlKey) {
    heldMode = state.mode;
    setMode(1);
  } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !(t instanceof HTMLInputElement)) {
    e.preventDefault();
    const names = visibleClips().map((c) => c.name);
    const i = names.indexOf(state.primary) + (e.key === "ArrowDown" ? 1 : -1);
    if (i >= 0 && i < names.length) {
      state.selected = new Set([names[i]]);
      setPrimary(names[i]);
      document.querySelector(`.clip[data-name="${CSS.escape(names[i])}"]`)?.scrollIntoView({ block: "nearest" });
    }
  } else if (e.metaKey && (e.key === "Backspace" || e.key === "Delete") && !e.repeat) {
    e.preventDefault();
    trashSelected();
  } else if ((e.metaKey || e.ctrlKey) && e.key === "a") {
    e.preventDefault();
    state.selected = new Set(visibleClips().map((c) => c.name));
    afterSelection();
  } else if ((e.metaKey || e.ctrlKey) && e.key === "c" && !window.getSelection()?.toString()) copyGrade();
  else if ((e.metaKey || e.ctrlKey) && e.key === "v") pasteGrade();
});
document.addEventListener("keyup", (e) => {
  if ((e.key === "b" || e.key === "B") && heldMode !== null) {
    setMode(heldMode);
    heldMode = null;
  }
});

$("shoot").addEventListener("change", (e) => openSource(e.target.value));

// ---- start --------------------------------------------------------------------------------------------------------

buildControls();
// The composer shows the app once it hears it's there.
tellComposer({ type: "grade-ready" });
loadLedger();
try {
  await calibrate();
  await loadLibrary();
  libraryAt = Date.now();
  const id = defaultSource();
  if (id) await openSource(id);
  else {
    $("empty").textContent = `Plug in the ${state.library.camera.name}, put clips in ${state.library.original}, or pick a day in the cloud.`;
    updatePanel();
  }
  openFromAddress();
} catch (e) {
  showError(e);
}
poll();
