// Offloading in the app: the foot of the Export menu, with a switch each for Camera → Mac and Mac → Cloudflare, what's
// kept out of it, and how it goes; the status line while it does; and Stop in the bar.

const $ = (id) => document.getElementById(id);
const LANES = ["copy", "send"];
const NAMES = { copy: "Camera → Mac", send: "Mac → Cloudflare" };

const clips = (count) => `${count} clip${count === 1 ? "" : "s"}`;
function timeLeft(seconds) {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min left`;
  return `${(seconds / 3600).toFixed(1)} h left`;
}
/** When a lane tries again, by the clock. */
function again({ until }) {
  if (!until) return "";
  return `, tries again ${new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
/** What a lane is waiting for, in a few words. */
function waitingText(waiting) {
  if (waiting.for === "room") return "waiting for room on this Mac";
  if (waiting.for === "camera") return `camera unplugged${again(waiting)}`;
  if (waiting.for === "network") return `can't reach Cloudflare${again(waiting)}`;
  if (waiting.for === "cloudflare") return "keeping clips on the camera until Cloudflare has them";
  if (waiting.for === "page") return "paused while no Grade page was open";
  return `${waiting.why}${again(waiting)}`;
}
/** What a stopping lane is doing about what's in flight. */
function stoppingText(lane, { mode, current }) {
  if (mode === "stopping") return "stopping now";
  if (lane === "copy") return current ? "finishing the clip being copied" : "stopping";
  if (current.length > 1) return `finishing ${current.length} uploads`;
  return current.length ? "finishing the upload" : "stopping";
}
const stayText = (count) => `${clips(count)} on the camera until Cloudflare has them`;
const passedOver = (o) => LANES.flatMap((lane) => o[lane]?.skipped ?? []);

/** How far the offload has moved clips: when it changes, the days they left are read again. */
export function offloadMoves(o) {
  if (!o) return "";
  return [o.running, ...LANES.map((lane) => o[lane]?.done), ...Object.values(o.freed ?? {})].join("/");
}

/** How much of a lane's is done, with what's in flight. */
function bytesDone(o, lane) {
  return lane === "copy" ? o.copy.doneBytes + (o.copy.current?.sent ?? 0) : o.sentBytes;
}
/** What Mac → Cloudflare has to send while it's on, and how much of it is sent. */
function sending(o) {
  return o.send?.on ? { bytes: o.send.bytes, sent: o.sentBytes } : { bytes: 0, sent: 0 };
}

/** How much of what the offload sends is sent, a share of 1; null with nothing to send. */
export function offloadShare(o) {
  if (!o?.running) return null;
  const { bytes, sent } = sending(o);
  return bytes > 0 ? Math.min(1, sent / bytes) : null;
}

/**
 * Sets up the menu's part and the bar's Stop. `api` asks the server, `fileSize` writes bytes, `showError` says what went
 * wrong and `poll` reads the jobs again.
 */
export function offloadMenu({ api, fileSize, showError, poll }) {
  const weight = (bytes) => (bytes ? fileSize(bytes) : "0 GB");
  const clipsAndSize = (count, bytes) => `${clips(count)} · ${weight(bytes)}`;
  /** The server's /api/offload answer, and the run as last heard of. */
  let info = null;
  let run = null;
  /** Whether a run is to go on with the tab closed: asked anew for each. */
  let unattended = false;

  /** A lane's progress while it's on. */
  function progress(lane, o) {
    const { done, total, bytes, waiting, mode } = o[lane];
    const parts = [`${done} of ${total}`, `${weight(bytesDone(o, lane))} of ${weight(bytes)}`];
    if (mode !== "on") parts.unshift(stoppingText(lane, o[lane]));
    else if (waiting) parts.unshift(waitingText(waiting));
    return parts;
  }

  /** The status line while an offload goes, or after one that ran into something. */
  function text(o) {
    if (!o) return "";
    const passed = passedOver(o);
    const over = passed.length ? `${clips(passed.length)} passed over, ${passed[0].name}: ${passed[0].why}` : "";
    if (!o.running) {
      if (o.error) return `Offload stopped: ${o.error}`;
      if (over) return `Offload: ${over}`;
      return o.transcripts?.error ? `Transcripts not sent: ${o.transcripts.error}` : "";
    }
    const parts = [];
    for (const lane of LANES) if (o[lane]?.on) parts.push(`${NAMES[lane]} ${progress(lane, o).join(" · ")}`);
    if (!o.copy.on && o.copy.onCamera) parts.push(stayText(o.copy.onCamera));
    else if (!o.copy.on && o.copy.total) parts.push("camera done: unplug it whenever");
    if (o.speed && !o.paused) {
      const mbit = (o.speed * 8) / 1e6;
      const { bytes, sent } = sending(o);
      parts.push(`${mbit.toFixed(mbit < 10 ? 1 : 0)} Mbit/s`, timeLeft((bytes - sent) / o.speed));
    }
    if (over) parts.push(over);
    return parts.join(" · ");
  }

  /** What an idle lane has to do, or how it left things. */
  function idle(lane) {
    const { camera, mac } = info;
    const passed = run?.[lane]?.skipped ?? [];
    if (passed.length) return `${clips(passed.length)} passed over: ${passed[0].why}`;
    if (lane === "copy") {
      if (!camera.mounted) return "Not plugged in";
      if (run?.copy.onCamera) return stayText(run.copy.onCamera);
      return camera.clips ? clipsAndSize(camera.clips, camera.bytes) : "Nothing to copy";
    }
    if (mac.clips) return `${clipsAndSize(mac.clips, mac.bytes)} to send`;
    return mac.sent ? `${clips(mac.sent)} sent, still here` : "Nothing to send";
  }
  function hasWork(lane) {
    const { camera, mac, transcripts } = info;
    if (lane === "copy") return camera.mounted && camera.clips > 0;
    return mac.clips + mac.sent + transcripts.toSend > 0 || Boolean(run?.running && run.copy.on);
  }
  const LABELS = { off: "Start", on: "Stop", finishing: "Stop now", stopping: "Stopping" };

  function renderLane(lane) {
    const row = document.querySelector(`.lane[data-lane="${lane}"]`);
    const mode = (run?.running && run[lane]?.mode) || "off";
    const said = mode === "off" ? idle(lane) : progress(lane, run).join(" · ");
    const note = row.querySelector("output");
    note.textContent = said.charAt(0).toUpperCase() + said.slice(1);
    const passed = run?.[lane]?.skipped ?? [];
    note.title = [note.textContent, ...passed.map(({ name, why }) => `${name}: ${why}`)].join("\n");
    const button = row.querySelector("button");
    button.textContent = LABELS[mode];
    button.setAttribute("aria-label", `${LABELS[mode]} ${NAMES[lane]}`);
    button.disabled = mode === "stopping" || (mode === "off" && !hasWork(lane));
  }

  function renderDays() {
    const list = $("offload-days");
    const key = JSON.stringify(info.days);
    if (list.dataset.key === key) return;
    list.dataset.key = key;
    const rows = info.days.map(({ day, clips: count, bytes, kept, keptClips }) => {
      const row = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = kept;
      // Some of its clips are kept by name, as those brought back are: a click lets them go.
      box.indeterminate = !kept && keptClips.length > 0;
      box.dataset.day = day;
      const name = document.createElement("span");
      name.textContent = day || "Others";
      const size = document.createElement("span");
      size.className = "menu-note";
      size.textContent = box.indeterminate ? `${clips(keptClips.length)} kept` : clipsAndSize(count, bytes);
      row.title = keptClips.join("\n");
      row.append(box, name, size);
      return row;
    });
    list.replaceChildren(...rows);
  }

  function render(now = run) {
    const moved = offloadMoves(now) !== offloadMoves(run);
    run = now ?? null;
    if (run?.running) unattended = run.unattended;
    else if (moved) unattended = false;
    if (!info) return;
    if (moved) void load();
    for (const lane of LANES) renderLane(lane);
    const { room, transcripts, kept } = info;
    $("offload-room").textContent = `${weight(Math.max(0, room.free - room.keepFree))} (${weight(
      room.keepFree,
    )} kept free)`;
    $("offload-transcripts").textContent = transcripts.toSend ? `${transcripts.toSend} to send` : "Nothing to send";
    $("offload-kept").textContent = kept.count ? clips(kept.count) : "None";
    $("offload-unattended").checked = unattended;
    const after = run?.running ? run.clearCardAfter : info.clearCardAfter;
    for (const button of document.querySelectorAll("[data-clear-after]"))
      button.setAttribute("aria-pressed", String(button.dataset.clearAfter === after));
    renderDays();
  }

  /** The bar's Stop: what's in flight is finished first, then cut on a second click. */
  function renderStop(o) {
    const button = $("stop-offload");
    const on = LANES.map((lane) => o?.[lane]).filter((lane) => lane?.on);
    button.hidden = !o?.running;
    let label = "Stop offloading";
    if (on.length && on.every(({ mode }) => mode === "stopping")) label = "Stopping…";
    else if (on.length && on.every(({ mode }) => mode !== "on")) label = "Stop now";
    button.textContent = label;
    button.title =
      label === "Stop now" ? "Cuts what's in flight" : "Finishes the files in flight; click again to stop at once";
  }

  async function load() {
    try {
      info = await (await api("/api/offload")).json();
      render(info.run);
    } catch (e) {
      showError(e);
    }
  }
  /** Asks for something, then reads how things are: what came of it, or what went wrong. */
  async function ask(path, json) {
    try {
      await api(path, { method: "POST", json });
      poll();
    } catch (e) {
      showError(e);
    }
    await load();
  }

  for (const lane of LANES)
    document.querySelector(`.lane[data-lane="${lane}"] button`).addEventListener("click", (event) => {
      event.target.disabled = true;
      if (run?.running && run[lane]?.on) void ask("/api/offload/stop", { lanes: [lane] });
      else void ask("/api/offload", { lanes: [lane], ...(run?.running ? {} : { unattended }) });
    });
  $("stop-offload").addEventListener("click", () => void ask("/api/offload/stop", {}));
  $("offload-unattended").addEventListener("change", (event) => {
    unattended = event.target.checked;
    // A run that's going is told at once; the next one, as it starts.
    if (run?.running) void ask("/api/offload", { lanes: [], unattended });
  });
  for (const button of document.querySelectorAll("[data-clear-after]"))
    button.addEventListener(
      "click",
      () => void ask("/api/offload", { lanes: [], clearCardAfter: button.dataset.clearAfter }),
    );
  $("offload-days").addEventListener("change", ({ target }) => {
    const { day, kept, keptClips } = info.days.find((one) => one.day === target.dataset.day);
    if (!kept && !keptClips.length) return void ask("/api/offload/keep", { days: [...info.kept.days, day] });
    void ask("/api/offload/keep", {
      days: info.kept.days.filter((one) => one !== day),
      clips: info.kept.clips.filter((one) => !keptClips.includes(one)),
    });
  });

  return { text, load, render, renderStop };
}
