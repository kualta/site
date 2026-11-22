// Bring to Mac: the picker's Cloudflare days, the ones with clips the archive has and this Mac doesn't. An open day lists
// those clips with a Bring button for each original and graded copy, and one for all of each; a clip brought back is in
// its day under "On this Mac" again (an original) or among the exports (a graded copy).
const $ = (id) => document.getElementById(id);
const KINDS = { original: "Original", graded: "Graded" };
const PREFIX = "cloud:";
/** How often the list is looked at again: this Mac's files change under it. The server keeps what the archive said. */
const EVERY = 60_000;
const NOTE = "The next offload takes clips brought here off this Mac again: they're already in Cloudflare.";

export const isCloud = (id) => Boolean(id?.startsWith(PREFIX));

const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const stemOf = (name) => name.replace(/\.[^.]+$/, "");
const keyOf = ({ what, day, name }) => `${what}/${day}/${name}`;

function timeLeft(seconds) {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min left`;
  return `${(seconds / 3600).toFixed(1)} h left`;
}

/**
 * `api` asks the server, `fileSize` and `label` word a clip as the clip list does, `openClip` opens one that's here,
 * `say` puts a note in the status line, `poll` reads the jobs now, and `changed` hears that the picker's days changed.
 */
export function bringView({ api, fileSize, label, openClip, say, poll, changed }) {
  /** /api/cloud's last answer. */
  let list = null;
  /** The day open, and its clips by name without extension. */
  let open = null;
  let clips = new Map();
  /** The open day's rows: a clip keeps its row once it's here, so nothing moves under the pointer. */
  let rows = new Map();
  let selected = null;
  /** Why the last clips asked for weren't brought. */
  let refused = "";
  /** /api/jobs' last answer on bringing, and on the offload. */
  let run = null;
  let offloading = false;
  /** How many clips had landed at the last poll; null before the first. */
  let seen = null;
  let askedAt = 0;

  /** The picker's group, if there's anything to list: the open day stays listed once all of it is here. */
  function groups() {
    const days = (list?.days ?? []).filter((d) => d.away || d.day === open);
    const options = days.map((d) => new Option(`${d.day} · ${plural(d.away, "clip")}`, d.id));
    if (open && !days.some((d) => d.day === open)) options.push(new Option(open, PREFIX + open));
    if (!options.length && list?.error) {
      options.push(new Option("Can't be read", ""));
      options[0].disabled = true;
      options[0].title = list.error;
    }
    if (!options.length) return [];
    const group = document.createElement("optgroup");
    group.label = "Cloudflare";
    group.append(...options);
    return [group];
  }

  async function load({ refresh = false } = {}) {
    askedAt = Date.now();
    const day = open;
    const query = new URLSearchParams();
    if (day) query.set("day", day);
    if (refresh) query.set("refresh", "1");
    let answer;
    try {
      answer = await (await api(`/api/cloud?${query}`)).json();
    } catch {
      // The poll says what's wrong with the server.
      return;
    }
    // Another day was opened meanwhile, and asks for itself.
    if (day !== open) return;
    list = answer;
    clips = new Map((answer.clips ?? []).map((clip) => [clip.stem, clip]));
    changed();
    render();
  }

  /** Opens a Cloudflare day in the clip list's place, or with null puts the clip list back. */
  async function show(id) {
    open = id ? id.slice(PREFIX.length) : null;
    document.querySelector(".bin").classList.toggle("cloud", Boolean(open));
    clips = new Map();
    rows = new Map();
    selected = null;
    refused = "";
    $("cloud-list").replaceChildren();
    if (!open) return;
    $("empty").textContent = "In Cloudflare, not on this Mac. Bring a clip here to grade it.";
    render();
    await load();
  }

  /** Points out a clip of the open day. */
  function select(name) {
    selected = stemOf(name);
    render();
    rows.get(selected)?.scrollIntoView({ block: "center" });
  }

  // ---- the open day ----------------------------------------------------------------------------------------------

  function makeRow({ stem, transcript, thumb, ...copies }) {
    const { title, time } = label({ stem });
    const li = document.createElement("li");
    li.className = "cloud-clip";
    li.dataset.stem = stem;
    li.innerHTML =
      '<span class="thumb"></span><span class="info"><span class="title-row"><b></b><span class="when"></span></span></span><span class="progress" hidden><i></i></span>';
    if (thumb) {
      const img = Object.assign(new Image(), { className: "thumb", loading: "lazy", alt: "" });
      img.src = `/media/cloud/${encodeURIComponent(stem)}.jpg`;
      li.firstChild.replaceWith(img);
    }
    li.querySelector("b").textContent = title;
    li.querySelector(".when").textContent = [time, transcript && "transcript"].filter(Boolean).join(" · ");
    for (const [what, kind] of Object.entries(KINDS)) {
      if (!copies[what]) continue;
      const line = document.createElement("span");
      line.className = "cloud-file";
      line.dataset.what = what;
      line.innerHTML = '<span></span><span class="size"></span><button type="button" class="btn small"></button>';
      line.firstChild.textContent = kind;
      line.title = copies[what].name;
      line.querySelector(".size").textContent = fileSize(copies[what].size);
      li.querySelector(".info").append(line);
    }
    return li;
  }

  /** How much of a copy has come, a share of 1; null when it isn't the one coming. */
  function shareOf(key) {
    const { current } = run ?? {};
    return current && keyOf(current) === key ? current.got / current.size : null;
  }

  /** What a copy's button says and does: `[text, action, title]`, with no action when there's nothing to do. */
  function buttonOf(what, copy, key, busy) {
    const share = shareOf(key);
    if (share !== null) return [`${Math.floor(share * 100)}%`, null, "On its way to this Mac"];
    if (busy.has(key)) return ["Queued", null, "Waiting for the clips before it"];
    if (copy.here === "yes" && what === "original") return ["Grade", "grade", "On this Mac: open it in its day"];
    if (copy.here === "yes") return ["Here", null, "On this Mac, in Exported"];
    if (copy.here === "different") return ["Differs", null, "Another file of this name is on this Mac"];
    const failed = run?.failed.find((one) => keyOf(one) === key);
    return failed ? ["Retry", "bring", failed.why] : ["Bring", "bring", `Bring ${copy.name} to this Mac`];
  }

  function renderRow(clip, li, busy) {
    li.setAttribute("aria-current", String(clip.stem === selected));
    const { title } = label(clip);
    let coming = null;
    for (const line of li.querySelectorAll(".cloud-file")) {
      const { what } = line.dataset;
      const key = keyOf({ what, day: open, name: clip[what].name });
      const [text, action, about] = buttonOf(what, clip[what], key, busy);
      const button = line.querySelector("button");
      button.textContent = text;
      button.title = about;
      button.disabled = !action;
      button.dataset.action = action ?? "";
      button.setAttribute("aria-label", `${text} · ${KINDS[what]} of ${title}`);
      coming ??= shareOf(key);
    }
    const bar = li.querySelector(".progress");
    bar.hidden = coming === null;
    bar.firstElementChild.style.width = `${(coming ?? 0) * 100}%`;
  }

  function renderHead(busy) {
    const of = list?.days.find((d) => d.day === open);
    $("cloud-count").textContent = of ? `${of.away} not here` : "";
    for (const what of Object.keys(KINDS)) {
      const part = of?.[what];
      const missing = part?.missing.clips ?? 0;
      let text = "None";
      if (missing) text = `${missing} · ${fileSize(part.missing.bytes)}`;
      else if (part?.clips) text = "All here";
      $(`cloud-${what}`).textContent = text;
      const waiting = [...busy].filter((key) => key.startsWith(`${what}/${open}/`)).length;
      $(`bring-${what}`).disabled = waiting >= missing;
    }
    const spare = list ? Math.max(0, list.room.free - list.room.keepFree) : 0;
    $("cloud-room").textContent = list ? fileSize(spare) : "";
    const note = refused || run?.error || list?.error || NOTE;
    $("cloud-note").textContent = note;
    $("cloud-note").title = note;
  }

  function render() {
    $("stop-bring").hidden = !run?.running;
    if (!open) return;
    const busy = new Set([...(run?.queued ?? []), run?.current].filter(Boolean).map(keyOf));
    for (const [stem, clip] of clips) {
      const missing = Object.keys(KINDS).some((what) => clip[what]?.here === "no");
      if (!rows.has(stem) && (missing || stem === selected)) rows.set(stem, makeRow(clip));
    }
    const order = [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([, li]) => li);
    if (order.some((li, i) => $("cloud-list").children[i] !== li)) $("cloud-list").replaceChildren(...order);
    for (const [stem, li] of rows) if (clips.has(stem)) renderRow(clips.get(stem), li, busy);
    renderHead(busy);
  }

  // ---- bringing ----------------------------------------------------------------------------------------------------

  async function bring(json) {
    refused = "";
    try {
      run = (await (await api("/api/bring", { method: "POST", json: { ...json, day: open } })).json()).bring;
    } catch (error) {
      refused = error.message;
    }
    render();
    poll();
  }

  $("cloud-list").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    const clip = clips.get(button?.closest(".cloud-clip").dataset.stem);
    if (!clip) return;
    const { what } = button.closest(".cloud-file").dataset;
    if (button.dataset.action === "grade") openClip(clip[what].name);
    else if (button.dataset.action === "bring") bring({ what, names: [clip[what].name] });
  });
  for (const what of Object.keys(KINDS)) $(`bring-${what}`).addEventListener("click", () => bring({ what }));
  $("cloud-refresh").addEventListener("click", () => load({ refresh: true }));
  $("stop-bring").addEventListener("click", async () => {
    await api("/api/bring/stop", { method: "POST" }).catch((error) => say(error.message));
    poll();
  });

  /** The status line while clips come, or after a run that ran into something. */
  function text() {
    if (!run) return "";
    if (!run.running) {
      if (run.error) return `Bringing stopped: ${run.error}`;
      if (run.failed.length) return `${plural(run.failed.length, "clip")} not brought: ${run.failed[0].why}`;
      return "";
    }
    const at = Math.min(run.total, run.landed + run.skipped + run.failed.length + 1);
    const parts = [`Bringing ${at} of ${run.total}`];
    if (run.current) parts.push(label({ stem: stemOf(run.current.name) }).title);
    parts.push(`${run.gotBytes ? fileSize(run.gotBytes) : "0 GB"} of ${fileSize(run.bytes)}`);
    if (run.speed) {
      const mbit = (run.speed * 8) / 1e6;
      parts.push(`${mbit.toFixed(mbit < 10 ? 1 : 0)} Mbit/s`, timeLeft((run.bytes - run.gotBytes) / run.speed));
    }
    return parts.join(" · ");
  }

  /** Takes /api/jobs' answer. Says whether a clip has landed on this Mac since the last. */
  function update(jobs) {
    // A server from before this, until it's restarted.
    if (!jobs.bring) return false;
    const before = run;
    const wasOffloading = offloading;
    run = jobs.bring;
    offloading = Boolean(jobs.offload?.running);
    const arrived = seen !== null && run.arrived !== seen;
    seen = run.arrived;
    const ended = (before?.running && !run.running) || (wasOffloading && !offloading);
    if (arrived || ended || Date.now() - askedAt > EVERY) load();
    if (before?.running && run.finished === "done" && run.landed)
      say(`Brought ${plural(run.landed, "clip")} to this Mac`);
    render();
    return arrived;
  }

  return { groups, show, select, text, update };
}
