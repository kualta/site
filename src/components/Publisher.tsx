import { useEffect, useRef, useState } from "react";
import {
  defaultPreferences,
  parsePreferences,
  platforms,
  platformNames,
  support,
  STORAGE_KEY,
  type Preferences,
  type Preset,
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
type Row = {
  id: string;
  payload: string;
  created_at: number;
  platform: keyof typeof platformNames;
  state: string;
  message: string | null;
  url: string | null;
};
export default function Publisher() {
  const [access, setAccess] = useState<"loading" | "owner" | "signin" | "denied">("loading");
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [ready, setReady] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [alt, setAlt] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [token, setToken] = useState("");
  const [helperOnline, setHelperOnline] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
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
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);
  async function refresh() {
    const data = await api("status");
    setRows(data.results);
    setHelperOnline(Boolean(data.helper?.last_seen && Date.now() - data.helper.last_seen < 90_000));
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
      setError(import.meta.env.DEV
        ? "Local Flow ID is unavailable. Start the Auth development stack and configure FLOW_ID_HOST and FLOW_ID_API_URL for this preview."
        : "Flow ID sign-in is unavailable. Please try again shortly.");
    }
  }
  async function submit() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!files.length || !preset.platforms.length || !title.trim())
        throw new Error("Add media, a title, and at least one destination.");
      if (preset.kind === "video" && files.length !== 1) throw new Error("Choose one video.");
      validatePost({
        id: crypto.randomUUID(),
        media: files.map(() => crypto.randomUUID()),
        kind: preset.kind,
        title,
        caption,
        alt,
        platforms: preset.platforms,
        metadata: preset.metadata,
        visibility: preset.visibility,
      });
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
      pending.payload ||= {
        id: pending.id,
        media: pending.media,
        kind: preset.kind,
        title,
        caption,
        alt,
        platforms: preset.platforms,
        metadata: preset.metadata,
        visibility: preset.visibility,
      };
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
    setCaption(preferences.presets.find((p) => p.id === id)?.caption || "");
    setFiles([]);
    submission.current = null;
  }
  const jobs = [...new Set(rows.map((row) => row.id))];
  let publishLabel = `Publish to ${preset.platforms.length} ${preset.platforms.length === 1 ? "place" : "places"}`;
  if (submitted) publishLabel = "Retry queue request";
  if (busy) publishLabel = "Uploading…";
  return (
    <main className="publisher">
      <header className="publisher-header">
        <a href="https://kualta.dev">
          kualta<span> / post</span>
        </a>
        {access === "owner" && (
          <span className="helper-status">
            <i data-online={helperOnline} />
            {helperOnline ? "Laptop connected" : "Laptop offline"}
          </span>
        )}
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
          <div className="publisher-heading">
            <h1>New post</h1>
            <select
              aria-label="Preset"
              value={preset.id}
              disabled={busy || submitted}
              onChange={(e) => selectPreset(e.target.value)}
            >
              {preferences.presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="publisher-compose">
            <section>
              <label className="media-picker">
                <input
                  ref={input}
                  type="file"
                  accept={preset.kind === "photo" ? "image/*" : "video/*"}
                  multiple={preset.kind === "photo"}
                  disabled={busy || submitted}
                  onChange={(e) => {
                    const next = Array.from(e.target.files || []);
                    if (
                      next.length > 4 ||
                      next.some(
                        (f) =>
                          f.size > (preset.kind === "photo" ? 30e6 : 90e6) ||
                          !f.type.startsWith(preset.kind === "photo" ? "image/" : "video/"),
                      )
                    ) {
                      setError("Choose up to four photos (30 MB each) or one video (90 MB).");
                      return;
                    }
                    setFiles(next);
                    submission.current = null;
                    setError("");
                  }}
                />
                <span>
                  {files.length ? "Replace media" : preset.kind === "photo" ? "Choose photos" : "Choose a video"}
                </span>
                <small>{preset.kind === "photo" ? "Up to 4 photos · 30 MB each" : "One video · up to 90 MB"}</small>
              </label>
              {!!previews.length && (
                <div className="publisher-previews">
                  {previews.map((url, i) =>
                    preset.kind === "video" ? (
                      <video key={url} src={url} controls />
                    ) : (
                      <img key={url} src={url} alt={files[i]?.name || "Selected photo"} />
                    ),
                  )}
                </div>
              )}
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
              <label>
                Caption
                <textarea
                  value={caption}
                  maxLength={5000}
                  disabled={busy || submitted}
                  onChange={(e) => {
                    setCaption(e.target.value);
                    submission.current = null;
                  }}
                  placeholder="Say something…"
                  rows={5}
                />
              </label>
              <label>
                Image description (Grain / Bluesky)
                <input
                  value={alt}
                  maxLength={1000}
                  disabled={busy || submitted}
                  onChange={(e) => {
                    setAlt(e.target.value);
                    submission.current = null;
                  }}
                  placeholder="Describe the photos for screen readers"
                />
              </label>
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
                  <input value={preset.name} maxLength={50} onChange={(e) => updatePreset({ name: e.target.value })} />
                </label>
                <label>
                  Default caption
                  <textarea
                    rows={2}
                    value={preset.caption}
                    onChange={(e) => updatePreset({ caption: e.target.value.slice(0, 5000) })}
                  />
                </label>
                <p className="publisher-note">Saved in this browser. Videos remove all optional metadata.</p>
                {preset.platforms.map((p) => (
                  <label key={p}>
                    {platformNames[p]} metadata
                    <select
                      value={preset.metadata[p]}
                      onChange={(e) =>
                        updatePreset({
                          metadata: { ...preset.metadata, [p]: e.target.value as "remove-location" | "remove-all" },
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
                    disabled={busy || submitted || preferences.presets.length >= 20}
                    onClick={() => {
                      const copy = { ...preset, id: crypto.randomUUID(), name: `${preset.name} copy` };
                      setPreferences((p) => ({ ...p, active: copy.id, presets: [...p.presets, copy] }));
                    }}
                  >
                    Duplicate
                  </button>
                  <button
                    disabled={busy || submitted || preferences.presets.length === 1}
                    onClick={() =>
                      setPreferences((p) => {
                        const remaining = p.presets.filter((v) => v.id !== preset.id);
                        return { ...p, active: remaining[0].id, presets: remaining };
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              </details>
              <button
                className="publish-button"
                disabled={busy || !files.length || !preset.platforms.length}
                onClick={submit}
              >
                {publishLabel}
              </button>
              <p className="publisher-note">
                Media stays private in Cloudflare. Your laptop removes metadata before publishing.
              </p>
            </aside>
          </div>
          <details className="publisher-connection">
            <summary>Laptop connection</summary>
            <p>
              Run <code>bun run publisher:setup</code>, then <code>bun run publisher connect</code> on your laptop.
              Paste a pairing key when prompted.
            </p>
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
          {!!jobs.length && (
            <section className="publisher-history">
              <h2>Recent posts</h2>
              {jobs.map((id) => {
                const group = rows.filter((r) => r.id === id);
                return (
                  <article key={id}>
                    <div>
                      <h3>{JSON.parse(group[0].payload).title}</h3>
                      <time>{new Date(group[0].created_at).toLocaleString()}</time>
                    </div>
                    {group.map((row) => (
                      <div className="publisher-result" key={row.platform}>
                        <span>{platformNames[row.platform]}</span>
                        <span title={row.message || ""}>
                          {row.url ? (
                            <a href={row.url} target="_blank" rel="noreferrer">
                              {row.state}
                            </a>
                          ) : (
                            row.state
                          )}
                        </span>
                        {row.message && <small>{row.message}</small>}
                        {["failed", "uncertain"].includes(row.state) && (
                          <button
                            onClick={async () => {
                              if (
                                !window.confirm(
                                  `Check ${
                                    platformNames[row.platform]
                                  } first. Confirm this post is absent before retrying?`,
                                )
                              )
                                return;
                              try {
                                await api("retry", { job: id, platform: row.platform, checked: true });
                                await refresh();
                              } catch (e) {
                                setError((e as Error).message);
                              }
                            }}
                          >
                            Retry this destination
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      disabled={group.some((r) => r.state === "working")}
                      onClick={async () => {
                        if (
                          !window.confirm(
                            "Remove this queued post, stored media, and history? Published posts stay on their platforms.",
                          )
                        )
                          return;
                        try {
                          await api(`jobs/${id}`, undefined, "DELETE");
                          await refresh();
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      Remove stored media & history
                    </button>
                  </article>
                );
              })}
            </section>
          )}
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
