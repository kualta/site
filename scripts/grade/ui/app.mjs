import { blockMeans, composeLut, gradeKey, inputCurves, resolveGrade, sampleTetra } from "/color.mjs";
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
  shoot: null,
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
const primaryClip = () => state.byName.get(state.primary);
const exporting = (clip) => state.jobs?.export.current?.id === state.shoot && state.jobs.export.current.name === clip.name;
const queued = (clip) => state.jobs?.export.queue.some((j) => j.id === state.shoot && j.name === clip.name);
const stale = (clip) => !clip.exported || clip.exported.key !== gradeKey(gradeOf(clip));

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
 * starts from the same code values the export does. Without it the preview still works, uncorrected.
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
    if (off > 1.5) {
      state.input = inputCurves(measured, cal.expected);
      setStatus(`Preview corrected for this browser's video decoder (it was up to ${off.toFixed(1)} levels off)`);
    }
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
    const coarse = await lutFor(clip, 33, state.input);
    if (v !== previewVersion) return;
    viewer.setLut(33, coarse);
    fineTimer = setTimeout(async () => {
      const fine = await lutFor(clip, 65, state.input);
      if (v === previewVersion) viewer.setLut(65, fine);
    }, 250);
  } catch (e) {
    showError(e);
  }
}

// Clip-list thumbnails: the ungraded still through the clip's own grade, on the CPU.
const thumbImages = new Map();
function thumbImage(clip) {
  const k = `${state.shoot}/${clip.stem}`;
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
        img.src = `/media/${encodeURIComponent(state.shoot)}/thumb/${encodeURIComponent(clip.stem)}.jpg`;
      }),
    );
  return thumbImages.get(k);
}
const thumbTimers = new Map();
function scheduleThumb(clip) {
  clearTimeout(thumbTimers.get(clip.name));
  thumbTimers.set(clip.name, setTimeout(() => drawThumb(clip).catch(() => {}), 120));
}
async function drawThumb(clip) {
  if (clip.proxy !== "ready") return;
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

// ---- library and shoots -------------------------------------------------------------------------------------------

async function loadLibrary() {
  const [library, bases] = await Promise.all([api("/api/library").then((r) => r.json()), api("/api/bases").then((r) => r.json())]);
  state.library = library;
  state.bases = bases;
  const sel = $("shoot");
  sel.replaceChildren(
    ...library.shoots.map((s) => {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = `${s.id} · ${s.clips} clip${s.clips === 1 ? "" : "s"}`;
      return o;
    }),
  );
  if (state.shoot) sel.value = state.shoot;
  renderCamera();
}

async function openShoot(id) {
  await save();
  state.shoot = id;
  $("shoot").value = id;
  store.set("grade.shoot", id);
  const payload = await (await api(`/api/shoots/${encodeURIComponent(id)}`)).json();
  state.clips = payload.clips;
  state.byName = new Map(state.clips.map((c) => [c.name, c]));
  state.grades = payload.grades ?? {};
  const remembered = store.get(`grade.selection.${id}`) ?? [];
  state.selected = new Set(remembered.filter((n) => state.byName.has(n)));
  if (!state.selected.size && state.clips[0]) state.selected.add(state.clips[0].name);
  renderList();
  setPrimary([...state.selected].pop() ?? null);
}

/** Pick up proxies that finished and exports that landed, keeping grades edited here. */
async function refreshShoot() {
  if (!state.shoot) return;
  const payload = await (await api(`/api/shoots/${encodeURIComponent(state.shoot)}`)).json();
  for (const fresh of payload.clips) {
    const clip = state.byName.get(fresh.name);
    if (!clip) continue;
    const becameReady = clip.proxy !== "ready" && fresh.proxy === "ready";
    Object.assign(clip, fresh);
    if (becameReady) {
      scheduleThumb(clip);
      if (clip.name === state.primary) loadVideo(clip);
    }
  }
}

// ---- clip list ----------------------------------------------------------------------------------------------------

function renderList() {
  const list = $("clip-list");
  list.replaceChildren();
  for (const clip of state.clips) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "clip";
    b.dataset.name = clip.name;
    const { title, time } = label(clip);
    b.innerHTML =
      '<canvas class="thumb" width="16" height="9"></canvas><span class="info"><span class="title-row"><b></b><span class="when"></span></span><span class="sub-row"><span class="profile"></span><span class="state"></span></span></span><span class="progress" hidden><i></i></span>';
    b.querySelector("b").textContent = title;
    b.querySelector(".when").textContent = [time, `${clip.duration.toFixed(1)} s`].filter(Boolean).join(" · ");
    b.querySelector(".profile").textContent = PROFILE_NAMES[clip.profile];
    b.title = `${clip.name} · ${clip.width}×${clip.height}`;
    li.append(b);
    list.append(li);
    scheduleThumb(clip);
  }
  updateRows();
}

function updateRows() {
  for (const b of document.querySelectorAll(".clip")) {
    const clip = state.byName.get(b.dataset.name);
    if (!clip) continue;
    b.setAttribute("aria-pressed", String(state.selected.has(clip.name)));
    b.classList.toggle("primary-clip", clip.name === state.primary && state.selected.size > 1);
    const chip = b.querySelector(".state");
    let text = "exported";
    let kind = "ok";
    if (clip.proxy === "failed") [text, kind] = ["preview failed", "bad"];
    else if (clip.proxy !== "ready") [text, kind] = ["preparing", "busy"];
    else if (exporting(clip)) [text, kind] = [`exporting ${Math.round((state.jobs.export.current.progress ?? 0) * 100)}%`, "busy"];
    else if (queued(clip)) [text, kind] = ["queued", "busy"];
    else if (!clip.exported) [text, kind] = ["not exported", ""];
    else if (stale(clip)) [text, kind] = ["changed", "changed"];
    chip.textContent = text;
    chip.className = `state ${kind}`.trim();
    const bar = b.querySelector(".progress");
    bar.hidden = !exporting(clip);
    if (!bar.hidden) bar.firstElementChild.style.width = `${(state.jobs.export.current.progress ?? 0) * 100}%`;
  }
  const n = state.selected.size;
  $("clip-count").textContent = n > 1 ? `${n} of ${state.clips.length}` : String(state.clips.length);
  $("select-all").textContent = n === state.clips.length && n > 1 ? "Select one" : "Select all";
  const changed = state.clips.filter((c) => stale(c) && !exporting(c) && !queued(c)).length;
  const btn = $("export");
  btn.disabled = changed === 0;
  $("export-label").textContent = changed ? `Export ${changed} clip${changed === 1 ? "" : "s"}` : "All exported";
  $("export-selected").textContent = n > 1 ? `Export ${n} selected` : "Export this clip";
  $("export-selected").disabled = n === 0;
}

$("clip-list").addEventListener("click", (e) => {
  const b = e.target.closest(".clip");
  if (!b) return;
  const name = b.dataset.name;
  if (e.shiftKey && state.primary) {
    const names = state.clips.map((c) => c.name);
    const [a, z] = [names.indexOf(state.primary), names.indexOf(name)].sort((x, y) => x - y);
    for (const n of names.slice(a, z + 1)) state.selected.add(n);
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
  const all = state.selected.size === state.clips.length && state.clips.length > 1;
  state.selected = all ? new Set(state.primary ? [state.primary] : []) : new Set(state.clips.map((c) => c.name));
  afterSelection();
});

function afterSelection() {
  store.set(`grade.selection.${state.shoot}`, [...state.selected]);
  updateRows();
  updatePanel();
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

function loadVideo(clip) {
  const playing = !video.paused;
  viewer.hasFrame = false;
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
  video.src = `/media/${encodeURIComponent(state.shoot)}/proxy/${encodeURIComponent(clip.stem)}.mp4`;
  if (playing) video.play().catch(() => {});
}

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
  for (const el of document.querySelectorAll(".panel input, .panel select, #copy, #reset, [data-reset-group]")) el.disabled = disabled;
  $("paste").disabled = disabled || !state.clipboard;
  if (!clip) {
    $("editing").textContent = "Nothing selected";
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
}

$("base").addEventListener("change", (e) => setField("base", e.target.value));

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
  if (!dirty.size || !state.shoot) return;
  const names = [...dirty];
  dirty.clear();
  const clips = Object.fromEntries(names.map((n) => [n, state.grades[n]]));
  try {
    await api(`/api/shoots/${encodeURIComponent(state.shoot)}/grades`, { method: "PUT", json: { clips }, keepalive });
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

// ---- export, jobs, camera -----------------------------------------------------------------------------------------

async function exportNames(names) {
  if (!names.length) return;
  await save();
  try {
    await api("/api/export", { method: "POST", json: { shoot: state.shoot, names } });
  } catch (e) {
    return showError(e);
  }
  poll();
}
$("export").addEventListener("click", () => exportNames(state.clips.filter((c) => stale(c) && !exporting(c) && !queued(c)).map((c) => c.name)));
$("export-selected").addEventListener("click", () => exportNames([...state.selected]));

let statusNote = "";
let statusTimer = null;
function setStatus(text) {
  statusNote = text;
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
  if (j?.import.running) parts.push(`Importing ${j.import.done} of ${j.import.total} from the camera`);
  if (j?.export.current) {
    const c = state.byName.get(j.export.current.name);
    const who = c && j.export.current.id === state.shoot ? label(c).title : j.export.current.name;
    parts.push(`Exporting ${who} · ${Math.round((j.export.current.progress ?? 0) * 100)}%${j.export.queue.length ? ` · ${j.export.queue.length} queued` : ""}`);
  }
  const preparing = state.clips.filter((c) => c.proxy === "queued" || c.proxy === "working").length;
  if (preparing) parts.push(`Making previews · ${preparing} left`);
  const failed = j?.export.failed.filter((f) => f.id === state.shoot) ?? [];
  if (failed.length) parts.push(`${failed.length} export${failed.length === 1 ? "" : "s"} failed: ${failed[0].error}`);
  if (state.error) parts.push(state.error);
  if (!parts.length && statusNote) parts.push(statusNote);
  $("status").textContent = parts.join(" · ");
  $("status").title = $("status").textContent;
}

let pollTimer = null;
let wasImporting = false;
let lastDone = 0;
async function poll() {
  clearTimeout(pollTimer);
  try {
    const jobs = await (await api("/api/jobs")).json();
    state.jobs = jobs;
    const done = jobs.export.done.length;
    const preparing = state.clips.some((c) => c.proxy === "queued" || c.proxy === "working");
    if (done !== lastDone || preparing) await refreshShoot();
    lastDone = done;
    if (wasImporting && !jobs.import.running) {
      const shoot = jobs.import.shoot;
      await loadLibrary();
      if (shoot && state.library.shoots.some((s) => s.id === shoot)) await openShoot(shoot);
      setStatus(`Imported ${jobs.import.done - jobs.import.failed.length} clip${jobs.import.done === 1 ? "" : "s"}${jobs.import.failed.length ? `, ${jobs.import.failed.length} failed` : ""}`);
    }
    wasImporting = jobs.import.running;
    renderCamera();
    renderStatus();
    updateRows();
    const active = jobs.export.current || jobs.export.queue.length || jobs.import.running || state.clips.some((c) => c.proxy === "queued" || c.proxy === "working");
    pollTimer = setTimeout(poll, active ? 700 : 5000);
  } catch (e) {
    showError(e);
    pollTimer = setTimeout(poll, 3000);
  }
}

function renderCamera() {
  const cam = state.library?.camera;
  const btn = $("camera");
  btn.hidden = !cam?.mounted;
  if (!cam?.mounted) return;
  const running = state.jobs?.import.running;
  const badge = $("camera-badge");
  badge.hidden = running || !cam.newClips;
  badge.textContent = String(cam.newClips);
  if (running) $("camera-label").textContent = `Importing ${state.jobs.import.done} of ${state.jobs.import.total}`;
  else $("camera-label").textContent = cam.newClips ? "Camera" : "Camera · all imported";
  const pop = $("camera-pop");
  pop.replaceChildren();
  const intro = document.createElement("p");
  intro.textContent = cam.newClips ? "New clips on the camera, by shoot day. Import copies a day into the library and checks each copy." : "Everything on the camera is in the library.";
  pop.append(intro);
  for (const s of cam.shoots) {
    const row = document.createElement("div");
    row.className = "pop-row";
    const text = document.createElement("div");
    const day = document.createElement("b");
    day.textContent = s.shoot;
    const detail = document.createElement("span");
    detail.textContent = `${s.clips} clip${s.clips === 1 ? "" : "s"} · ${(s.bytes / 1e9).toFixed(1)} GB`;
    text.append(day, detail);
    const go = document.createElement("button");
    go.type = "button";
    go.className = "btn";
    go.textContent = "Import";
    go.disabled = Boolean(running);
    go.addEventListener("click", async () => {
      try {
        await api("/api/import", { method: "POST", json: { shoot: s.shoot } });
        wasImporting = true;
        togglePop(false);
        poll();
      } catch (e) {
        showError(e);
      }
    });
    row.append(text, go);
    pop.append(row);
  }
}
function togglePop(open) {
  $("camera-pop").hidden = !open;
  $("camera").setAttribute("aria-expanded", String(open));
}
$("camera").addEventListener("click", async () => {
  const open = $("camera-pop").hidden;
  if (open) {
    state.library = await (await api("/api/library")).json();
    renderCamera();
  }
  togglePop(open);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".camera")) togglePop(false);
});

// ---- keyboard -----------------------------------------------------------------------------------------------------

let heldMode = null;
document.addEventListener("keydown", (e) => {
  const t = e.target;
  if (t.matches?.("select, textarea, input:not([type=range]):not([type=checkbox])")) return;
  if (e.key === " " && !(t instanceof HTMLButtonElement)) {
    e.preventDefault();
    togglePlay();
  } else if ((e.key === "b" || e.key === "B") && !e.repeat && !e.metaKey && !e.ctrlKey) {
    heldMode = state.mode;
    setMode(1);
  } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !(t instanceof HTMLInputElement)) {
    e.preventDefault();
    const names = state.clips.map((c) => c.name);
    const i = names.indexOf(state.primary) + (e.key === "ArrowDown" ? 1 : -1);
    if (i >= 0 && i < names.length) {
      state.selected = new Set([names[i]]);
      setPrimary(names[i]);
      document.querySelector(`.clip[data-name="${CSS.escape(names[i])}"]`)?.scrollIntoView({ block: "nearest" });
    }
  } else if ((e.metaKey || e.ctrlKey) && e.key === "c" && !window.getSelection()?.toString()) copyGrade();
  else if ((e.metaKey || e.ctrlKey) && e.key === "v") pasteGrade();
});
document.addEventListener("keyup", (e) => {
  if ((e.key === "b" || e.key === "B") && heldMode !== null) {
    setMode(heldMode);
    heldMode = null;
  }
});

$("shoot").addEventListener("change", (e) => openShoot(e.target.value));

// ---- start --------------------------------------------------------------------------------------------------------

buildControls();
try {
  await calibrate();
  await loadLibrary();
  const ids = state.library.shoots.map((s) => s.id);
  const last = store.get("grade.shoot");
  const id = ids.includes(last) ? last : ids[0];
  if (id) await openShoot(id);
  else {
    $("empty").textContent = `No shoots yet. Put clips in ${state.library.root}/<shoot>/originals, or import them from the camera.`;
    updatePanel();
  }
} catch (e) {
  showError(e);
}
poll();
