import PublisherAnalytics from "./PublisherAnalytics";
import { exifDateTime } from "@/lib/publisher/photo-date";
import PublisherHistory from "./PublisherHistory";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useEffect, useRef, useState } from "react";
import PublisherConnections, { type Connection } from "./PublisherConnections";
import {
  defaultPreferences,
  kindNames,
  kinds,
  MAX_PHOTOS,
  MAX_PRESETS,
  parsePreferences,
  photoLimits,
  platforms,
  platformNames,
  SHORT_MAX_SECONDS,
  support,
  STORAGE_KEY,
  type Preferences,
  type Preset,
  type Platform,
  type PostKind,
} from "@/lib/publisher/presets";
import "@/styles/publisher.css";
import { validatePost } from "@/lib/publisher/server";

async function api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`/api/publisher/${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
const DRAFT_KEY = "publisher.draft";
/** Resolves undefined when this browser cannot read the file; the laptop checks it again. */
function videoDuration(file: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (duration?: number) => {
      URL.revokeObjectURL(url);
      resolve(duration);
    };
    video.preload = "metadata";
    video.onloadedmetadata = () => done(video.duration);
    video.onerror = () => done();
    video.src = url;
  });
}
export default function Publisher() {
  const [tab, setTab] = useState<"compose" | "analytics">("compose");
  const [access, setAccess] = useState<"loading" | "owner" | "signin" | "denied">("loading");
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [ready, setReady] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [datesTaken, setDatesTaken] = useState<string[]>([]);
  const [readingDates, setReadingDates] = useState(false);
  const [previews, setPreviews] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [alt, setAlt] = useState("");
  const [alts, setAlts] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [token, setToken] = useState("");
  const [helperOnline, setHelperOnline] = useState(false);
  const [connectedPlatforms, setConnectedPlatforms] = useState<Platform[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const submission = useRef<{ id: string; media: string[]; payload?: unknown } | null>(null);
  const preset = preferences.presets.find((p) => p.id === preferences.active) || preferences.presets[0];
  function updatePreset(patch: Partial<Preset>) {
    if (busy || submitted) return;
    setPreferences((p) => ({
      ...p,
      presets: p.presets.map((item) => (item.id === preset.id ? { ...item, ...patch } : item)),
    }));
  }
  useEffect(() => {
    try {
      const p = parsePreferences(localStorage.getItem(STORAGE_KEY));
      setPreferences(p);
      setCaption(p.presets.find((item) => item.id === p.active)?.caption || "");
    } catch {
      setError("Browser storage is unavailable. Presets will last for this visit.");
    }
    try {
      const draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "null");
      if (typeof draft?.title === "string") setTitle(draft.title.slice(0, 100));
      if (typeof draft?.caption === "string" && draft.caption) setCaption(draft.caption.slice(0, 5000));
    } catch {
      // A draft is a convenience; start empty without it.
    }
    setReady(true);
    api("session")
      .then((data) => setAccess(data.allowed ? "owner" : data.signedIn ? "denied" : "signin"))
      .catch((e) => {
        setError(e.message);
        setAccess("signin");
      });
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      setError("Could not save presets in this browser.");
    }
  }, [preferences, ready]);
  useEffect(() => {
    if (!ready) return;
    try {
      if (title || caption) sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ title, caption }));
      else sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      // Keep the draft in memory.
    }
  }, [title, caption, ready]);
  useEffect(() => {
    setAlts(files.map(() => ""));
  }, [files]);
  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);
  useEffect(() => {
    let active = true;
    setDatesTaken(files.map(() => ""));
    setReadingDates(true);
    async function readDates() {
      try {
        const { parse } = await import("exifr");
        const dates = await Promise.all(
          files.map(async (file) => {
            if (!file.type.startsWith("image/")) return "";
            try {
              const exif = await parse(file, { pick: ["DateTimeOriginal", "OffsetTimeOriginal"], reviveValues: false });
              return exifDateTime(exif?.DateTimeOriginal, exif?.OffsetTimeOriginal);
            } catch {
              return "";
            }
          }),
        );
        if (active) setDatesTaken(dates);
      } catch {
        // Reading EXIF is optional; manual capture dates remain available.
      } finally {
        if (active) setReadingDates(false);
      }
    }
    void readDates();
    return () => {
      active = false;
    };
  }, [files]);
  async function refresh() {
    const data = await api("status");
    setHelperOnline(Boolean(data.helper?.last_seen && Date.now() - data.helper.last_seen < 90_000));
    setConnectedPlatforms(JSON.parse(data.helper?.platforms || "[]"));
    setConnections(data.connections || []);
  }
  useEffect(() => {
    if (access !== "owner") return;
    refresh().catch((e) => setError(e.message));
    const timer = window.setInterval(() => refresh().catch(() => setHelperOnline(false)), 10_000);
    return () => clearInterval(timer);
  }, [access]);
  async function signIn() {
    setError("");
    try {
      const { createFlow } = await import("@flow-industries/id");
      await createFlow().login({ returnTo: location.pathname });
    } catch {
      setError(
        import.meta.env.DEV
          ? "Local Flow ID is unavailable. Start the Auth development stack and configure FLOW_ID_HOST and FLOW_ID_API_URL for this preview."
          : "Flow ID sign-in is unavailable. Please try again shortly.",
      );
    }
  }
  async function submit() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (readingDates) throw new Error("Reading photo dates. Try again in a moment.");
      if (!preset.platforms.length) throw new Error("Choose at least one destination.");
      const text = preset.kind === "text";
      const photo = preset.kind === "photo";
      if (text) {
        if (!caption.trim()) throw new Error("Write something to post.");
      } else if (!files.length || !title.trim()) throw new Error("Add media and a title.");
      const payload = (id: string, media: string[]) => ({
        id,
        media,
        kind: preset.kind,
        title: text ? "" : title,
        caption,
        alt: photo ? "" : alt,
        alts: photo ? alts : undefined,
        datesTaken: photo ? datesTaken.map((date) => (date ? new Date(date).toISOString() : null)) : undefined,
        platforms: preset.platforms,
        metadata: preset.metadata,
        visibility: preset.visibility,
      });
      validatePost(
        payload(
          crypto.randomUUID(),
          files.map(() => crypto.randomUUID()),
        ),
      );
      const pending = (submission.current ||= { id: crypto.randomUUID(), media: [] });
      for (let i = pending.media.length; i < files.length; i++) {
        const response = await fetch("/api/publisher/media", {
          method: "POST",
          headers: { "Content-Type": files[i].type },
          body: files[i],
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Upload failed");
        pending.media.push(result.id);
      }
      // Freeze the request after uploading. A lost response retries the same job.
      pending.payload ||= payload(pending.id, pending.media);
      setSubmitted(true);
      await api("jobs", pending.payload);
      setSubmitted(false);
      submission.current = null;
      setFiles([]);
      setTitle("");
      setAlt("");
      setCaption(preset.caption);
      if (input.current) input.current.value = "";
      setNotice("Queued. Your laptop will publish each destination once.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not queue post");
    } finally {
      setBusy(false);
    }
  }
  function selectPreset(id: string) {
    setPreferences((p) => ({ ...p, active: id }));
    // Keep what was typed; only swap one default caption for another.
    if (!caption.trim() || caption === preset.caption)
      setCaption(preferences.presets.find((p) => p.id === id)?.caption || "");
    setFiles([]);
    if (input.current) input.current.value = "";
    submission.current = null;
  }
  function selectKind(kind: PostKind) {
    if (preset.kind === kind) return;
    const next = preferences.presets.find((p) => p.kind === kind);
    if (next) selectPreset(next.id);
  }
  const photoLimit = Math.min(MAX_PHOTOS, ...preset.platforms.map((p) => photoLimits[p] ?? MAX_PHOTOS));
  async function chooseFiles(next: File[]) {
    const photo = preset.kind === "photo";
    if (
      next.length > (photo ? photoLimit : 1) ||
      next.some((f) => f.size > (photo ? 30e6 : 90e6) || !f.type.startsWith(photo ? "image/" : "video/"))
    ) {
      setError(photo ? `Choose up to ${photoLimit} photos, 30 MB each.` : "Choose one video of up to 90 MB.");
      return;
    }
    if (preset.kind === "short" && next.length && ((await videoDuration(next[0])) ?? 0) > SHORT_MAX_SECONDS) {
      setError("Short videos are up to 3 minutes. Use Video for longer clips.");
      return;
    }
    setFiles(next);
    submission.current = null;
    setError("");
  }
  const kindPresets = preferences.presets.filter((p) => p.kind === preset.kind);
  const textLimit = preset.platforms.includes("twitter") ? 280 : 300;
  const pickerHint = {
    text: "",
    photo: `Up to ${photoLimit} photos · 30 MB each`,
    video: "One video · up to 90 MB",
    short: "One video · up to 3 minutes · 90 MB",
  }[preset.kind];
  let publishLabel = `Publish to ${preset.platforms.length} ${preset.platforms.length === 1 ? "place" : "places"}`;
  const missingPlatforms = preset.platforms.filter((platform) => !connectedPlatforms.includes(platform));
  if (!helperOnline || missingPlatforms.length) publishLabel = "Queue post";
  if (submitted) publishLabel = "Retry queue request";
  if (busy) publishLabel = "Uploading…";
  return (
    <main className="publisher">
      <header className="publisher-header">
        <a href="https://kualta.dev">
          kualta<span> / post</span>
        </a>
        <div className="publisher-header-tools">
          {access === "owner" && (
            <span className="helper-status">
              <i data-online={helperOnline} />
              {helperOnline ? "Laptop connected" : "Laptop offline"}
            </span>
          )}
          <ThemeToggle path="/publish" showOnHome />
        </div>
      </header>
      {access !== "owner" ? (
        <section className="publisher-login">
          <h1>Post</h1>
          <p>{access === "denied" ? "This space belongs to kualta." : "Sign in to publish."}</p>
          <button disabled={access === "loading"} onClick={signIn}>
            {access === "loading" ? "Loading…" : "Continue with Flow ID"}
          </button>
        </section>
      ) : (
        <>
          <nav className="publisher-tabs" aria-label="Publisher sections">
            <button aria-pressed={tab === "compose"} onClick={() => setTab("compose")}>
              Compose
            </button>
            <button aria-pressed={tab === "analytics"} onClick={() => setTab("analytics")}>
              Analytics
            </button>
          </nav>
          {tab === "analytics" && <PublisherAnalytics request={api} online={helperOnline} />}
          <div hidden={tab !== "compose"}>
            <div className="publisher-heading">
              <h1>New post</h1>
              {kindPresets.length > 1 && (
                <select
                  aria-label="Preset"
                  value={preset.id}
                  disabled={busy || submitted}
                  onChange={(e) => selectPreset(e.target.value)}
                >
                  {kindPresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <nav className="publisher-kinds" aria-label="Content type">
              {kinds.map((kind) => (
                <button
                  key={kind}
                  aria-pressed={preset.kind === kind}
                  disabled={busy || submitted}
                  onClick={() => selectKind(kind)}
                >
                  {kindNames[kind]}
                </button>
              ))}
            </nav>
            <div className="publisher-compose">
              <section>
                {preset.kind !== "text" && (
                  <label className="media-picker">
                    <input
                      ref={input}
                      type="file"
                      accept={preset.kind === "photo" ? "image/*" : "video/*"}
                      multiple={preset.kind === "photo"}
                      disabled={busy || submitted}
                      onChange={(e) => void chooseFiles(Array.from(e.target.files || []))}
                    />
                    <span>
                      {files.length ? "Replace media" : preset.kind === "photo" ? "Choose photos" : "Choose a video"}
                    </span>
                    <small>{pickerHint}</small>
                  </label>
                )}
                {!!previews.length && (
                  <div className="publisher-previews">
                    {previews.map((url, i) =>
                      preset.kind === "photo" ? (
                        <img key={url} src={url} alt={files[i]?.name || "Selected photo"} />
                      ) : (
                        <video key={url} src={url} controls />
                      ),
                    )}
                  </div>
                )}
                {preset.kind === "photo" && files.length > 0 && (
                  <div className="publisher-photo-details">
                    {preset.platforms.includes("grain") && (
                      <p className="publisher-note">
                        Date taken · Grain · {Intl.DateTimeFormat().resolvedOptions().timeZone}. Photos without a
                        timezone use this timezone. Read from the original photo; edit or clear before posting.
                      </p>
                    )}
                    {files.map((file, index) => (
                      <fieldset key={`${file.name}-${index}`}>
                        <legend>
                          Photo {index + 1} · {file.name}
                        </legend>
                        <label>
                          Description (Grain / Bluesky)
                          <input
                            value={alts[index] || ""}
                            maxLength={1000}
                            disabled={busy || submitted}
                            onChange={(event) => {
                              const value = event.target.value;
                              setAlts((list) => list.map((item, i) => (i === index ? value : item)));
                              submission.current = null;
                            }}
                            placeholder="Describe this photo for screen readers"
                          />
                        </label>
                        {preset.platforms.includes("grain") && (
                          <label>
                            Date taken
                            <input
                              type="datetime-local"
                              step="1"
                              aria-label={`Date taken for ${file.name}`}
                              disabled={busy || submitted || readingDates}
                              value={datesTaken[index] || ""}
                              onChange={(event) => {
                                const value = event.target.value;
                                setDatesTaken((dates) => dates.map((date, i) => (i === index ? value : date)));
                                submission.current = null;
                              }}
                            />
                          </label>
                        )}
                      </fieldset>
                    ))}
                  </div>
                )}
                {preset.kind !== "text" && (
                  <label>
                    Title
                    <input
                      value={title}
                      maxLength={100}
                      disabled={busy || submitted}
                      onChange={(e) => {
                        setTitle(e.target.value);
                        submission.current = null;
                      }}
                      placeholder="A moment worth sharing"
                    />
                  </label>
                )}
                <label>
                  {preset.kind === "text" ? "Post" : "Caption"}
                  <textarea
                    value={caption}
                    maxLength={5000}
                    disabled={busy || submitted}
                    onChange={(e) => {
                      setCaption(e.target.value);
                      submission.current = null;
                    }}
                    placeholder={preset.kind === "text" ? "What's happening?" : "Say something…"}
                    rows={5}
                  />
                  {preset.kind === "text" && (
                    <small className="publisher-count" data-over={[...caption].length > textLimit}>
                      {[...caption].length} / {textLimit}
                    </small>
                  )}
                </label>
                {(preset.kind === "video" || preset.kind === "short") && (
                  <label>
                    Video description (Bluesky)
                    <input
                      value={alt}
                      maxLength={1000}
                      disabled={busy || submitted}
                      onChange={(e) => {
                        setAlt(e.target.value);
                        submission.current = null;
                      }}
                      placeholder="Describe the video for screen readers"
                    />
                  </label>
                )}
              </section>
              <aside>
                <h2>Share to</h2>
                <div className="publisher-destinations">
                  {platforms
                    .filter((p) => support[p].includes(preset.kind))
                    .map((p) => (
                      <label key={p}>
                        <span>{platformNames[p]}</span>
                        <input
                          type="checkbox"
                          checked={preset.platforms.includes(p)}
                          disabled={busy || submitted}
                          onChange={() => {
                            submission.current = null;
                            updatePreset({
                              platforms: preset.platforms.includes(p)
                                ? preset.platforms.filter((v) => v !== p)
                                : [...preset.platforms, p],
                            });
                          }}
                        />
                      </label>
                    ))}
                </div>
                {preset.platforms.includes("youtube") && (
                  <label>
                    YouTube visibility
                    <select
                      value={preset.visibility}
                      disabled={busy || submitted}
                      onChange={(e) => updatePreset({ visibility: e.target.value as Preset["visibility"] })}
                    >
                      <option value="PRIVATE">Private</option>
                      <option value="UNLISTED">Unlisted</option>
                      <option value="PUBLIC">Public</option>
                    </select>
                  </label>
                )}
                <details>
                  <summary>Preset settings</summary>
                  <label>
                    Name
                    <input
                      value={preset.name}
                      maxLength={50}
                      onChange={(e) => updatePreset({ name: e.target.value })}
                    />
                  </label>
                  <label>
                    Default caption
                    <textarea
                      rows={2}
                      value={preset.caption}
                      onChange={(e) => updatePreset({ caption: e.target.value.slice(0, 5000) })}
                    />
                  </label>
                  <p className="publisher-note">
                    {preset.kind === "text"
                      ? "Saved in this browser."
                      : "Saved in this browser. Videos remove all optional metadata."}
                  </p>
                  {preset.kind !== "text" &&
                    preset.platforms.map((p) => (
                      <label key={p}>
                        {platformNames[p]} metadata
                        <select
                          value={preset.metadata[p]}
                          onChange={(e) =>
                            updatePreset({
                              metadata: {
                                ...preset.metadata,
                                [p]: e.target.value as "remove-location" | "remove-all",
                              },
                            })
                          }
                        >
                          <option value="remove-location">Remove location · keep camera settings</option>
                          <option value="remove-all">Remove all optional metadata</option>
                        </select>
                      </label>
                    ))}
                  <div className="publisher-actions">
                    <button
                      disabled={busy || submitted || preferences.presets.length >= MAX_PRESETS}
                      onClick={() => {
                        const copy = { ...preset, id: crypto.randomUUID(), name: `${preset.name} copy` };
                        setPreferences((p) => ({ ...p, active: copy.id, presets: [...p.presets, copy] }));
                      }}
                    >
                      Duplicate
                    </button>
                    <button
                      disabled={busy || submitted || kindPresets.length === 1}
                      onClick={() =>
                        setPreferences((p) => {
                          // Each content tab keeps at least one preset.
                          const remaining = p.presets.filter((v) => v.id !== preset.id);
                          const next = remaining.find((v) => v.kind === preset.kind) ?? remaining[0];
                          return { ...p, active: next.id, presets: remaining };
                        })
                      }
                    >
                      Delete
                    </button>
                  </div>
                </details>
                <button
                  className="publish-button"
                  disabled={
                    busy || !preset.platforms.length || (preset.kind === "text" ? !caption.trim() : !files.length)
                  }
                  onClick={submit}
                >
                  {publishLabel}
                </button>
                {preset.kind !== "text" && (
                  <p className="publisher-note">
                    Media stays private in Cloudflare. Your laptop removes metadata before publishing.
                  </p>
                )}
                {!!missingPlatforms.length && (
                  <p className="publisher-note">
                    Waiting for {missingPlatforms.map((platform) => platformNames[platform]).join(", ")} sign-in.
                  </p>
                )}
              </aside>
            </div>
            <PublisherHistory request={api} onError={setError} />
            <PublisherConnections
              online={helperOnline}
              connected={connectedPlatforms}
              connections={connections}
              request={api}
              refresh={refresh}
              onError={setError}
            />
            <details className="publisher-connection">
              <summary>Laptop connection</summary>
              {!helperOnline && (
                <p>
                  Run <code>bun run publisher:setup</code>, then <code>bun run publisher connect</code> on your laptop.
                  Paste a pairing key when prompted.
                </p>
              )}
              {helperOnline && <p>Laptop paired and running.</p>}
              <button
                onClick={async () => {
                  try {
                    setToken((await api("pair", {})).token);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Generate pairing key
              </button>
              {token && (
                <label>
                  One-time display · replaces the previous key
                  <input readOnly value={token} onFocus={(e) => e.target.select()} autoComplete="off" />
                </label>
              )}
              <button
                onClick={async () => {
                  try {
                    await api("pair", undefined, "DELETE");
                    setToken("");
                    setHelperOnline(false);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Disconnect laptop
              </button>
            </details>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="publisher-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="publisher-notice">
          {notice}
        </p>
      )}
    </main>
  );
}
