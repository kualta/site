import PublisherAnalytics from "./PublisherAnalytics";
import { exifDateTime } from "@/lib/publisher/photo-date";
import PublisherHistory from "./PublisherHistory";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ImageIcon, VideoIcon, type IconComponent } from "@/components/icons";
import { useEffect, useRef, useState } from "react";
import PublisherConnections, { type Connection } from "./PublisherConnections";
import {
  defaultPreferences,
  MAX_PHOTOS,
  MAX_PRESETS,
  parsePreferences,
  platforms,
  platformNames,
  postKind,
  STORAGE_KEY,
  titled,
  unsupported,
  type Preferences,
  type Preset,
  type Platform,
  type PostKind,
} from "@/lib/publisher/presets";
import "@/styles/publisher.css";
import { validatePost } from "@/lib/publisher/server";
import { parseTags, problem, renderVariant, usage, xiaohongshuTitleLength } from "@/lib/publisher/variants";

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
const unavailableFor: Record<PostKind, string> = {
  text: "text-only posts",
  photo: "these photos",
  video: "this video",
};
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
/** A toolbar button that opens its own file picker. */
function MediaButton({
  accept,
  multiple = false,
  label,
  hint,
  Icon,
  disabled,
  onFiles,
}: {
  accept: string;
  multiple?: boolean;
  label: string;
  hint: string;
  Icon: IconComponent;
  disabled: boolean;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          event.target.value = "";
          onFiles(files);
        }}
      />
      <button type="button" title={hint} disabled={disabled} onClick={() => input.current?.click()}>
        <Icon size={18} />
        {label}
      </button>
    </>
  );
}
export default function Publisher() {
  const [tab, setTab] = useState<"compose" | "analytics">("compose");
  const [access, setAccess] = useState<"loading" | "owner" | "signin" | "denied">("loading");
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [ready, setReady] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [videoSeconds, setVideoSeconds] = useState<number>();
  const [datesTaken, setDatesTaken] = useState<string[]>([]);
  const [readingDates, setReadingDates] = useState(false);
  const [previews, setPreviews] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [alt, setAlt] = useState("");
  const [alts, setAlts] = useState<string[]>([]);
  const [tagsText, setTagsText] = useState("");
  const [short, setShort] = useState("");
  const [zhTitle, setZhTitle] = useState("");
  const [zhText, setZhText] = useState("");
  const [zhTopicsText, setZhTopicsText] = useState("");
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [token, setToken] = useState("");
  const [helperOnline, setHelperOnline] = useState(false);
  const [connectedPlatforms, setConnectedPlatforms] = useState<Platform[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [dragging, setDragging] = useState(false);
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
      if (typeof draft?.tags === "string") setTagsText(draft.tags.slice(0, 1000));
      if (typeof draft?.short === "string") setShort(draft.short.slice(0, 1000));
      if (typeof draft?.zh?.title === "string") setZhTitle(draft.zh.title.slice(0, 100));
      if (typeof draft?.zh?.text === "string") setZhText(draft.zh.text.slice(0, 5000));
      if (typeof draft?.zh?.topics === "string") setZhTopicsText(draft.zh.topics.slice(0, 500));
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
      const zh = { title: zhTitle, text: zhText, topics: zhTopicsText };
      if (title || caption || tagsText || short || zhTitle || zhText || zhTopicsText)
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ title, caption, tags: tagsText, short, zh }));
      else sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      // Keep the draft in memory.
    }
  }, [title, caption, tagsText, short, zhTitle, zhText, zhTopicsText, ready]);
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
      if (!destinations.length) throw new Error(`None of the selected destinations take ${unavailableFor[kind]}.`);
      if (kind === "text" && !caption.trim()) throw new Error("Write something to post.");
      if (needsTitle && !title.trim()) throw new Error(`Add a title for ${titledNames}.`);
      const photo = kind === "photo";
      const payload = (id: string, media: string[]) => ({
        id,
        media,
        kind,
        ...text,
        alt: kind === "video" ? alt : "",
        alts: photo ? alts : undefined,
        datesTaken: photo ? datesTaken.map((date) => (date ? new Date(date).toISOString() : null)) : undefined,
        platforms: destinations,
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
      clearMedia();
      setTitle("");
      setAlt("");
      setCaption(preset.caption);
      setTagsText("");
      setShort("");
      setZhTitle("");
      setZhText("");
      setZhTopicsText("");
      setNotice("Queued. Your laptop will publish each destination once.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not queue post");
    } finally {
      setBusy(false);
    }
  }
  async function translate() {
    setTranslating(true);
    setError("");
    try {
      const draft = await api("translate", { title, text: caption, tags: parseTags(tagsText) });
      setZhTitle(draft.title);
      setZhText(draft.text);
      setZhTopicsText(draft.topics.join(" "));
      submission.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not translate");
    } finally {
      setTranslating(false);
    }
  }
  function selectPreset(id: string) {
    setPreferences((p) => ({ ...p, active: id }));
    submission.current = null;
  }
  function clearMedia() {
    setFiles([]);
    setVideoSeconds(undefined);
    submission.current = null;
  }
  async function chooseFiles(next: File[]) {
    if (!next.length) return;
    const photos = next.filter((f) => f.type.startsWith("image/"));
    const videos = next.filter((f) => f.type.startsWith("video/"));
    if (
      photos.length + videos.length !== next.length ||
      (videos.length > 0 && next.length > 1) ||
      photos.length > MAX_PHOTOS ||
      photos.some((f) => f.size > 30e6) ||
      videos.some((f) => f.size > 90e6)
    ) {
      setError(`Attach up to ${MAX_PHOTOS} photos (30 MB each) or one video (90 MB).`);
      return;
    }
    setVideoSeconds(videos.length ? await videoDuration(videos[0]) : undefined);
    setFiles(next);
    submission.current = null;
    setError("");
  }
  // The attachments decide the kind; the preset's destinations that can't take it are skipped.
  const kind = postKind(files);
  const reasons = Object.fromEntries(
    platforms.map((p) => [p, unsupported(p, kind, files.length, videoSeconds)]),
  ) as Record<Platform, string | null>;
  const destinations = preset.platforms.filter((p) => !reasons[p]);
  const titledNames = destinations
    .filter((p) => titled.includes(p))
    .map((p) => platformNames[p])
    .join(", ");
  const needsTitle = titledNames !== "";
  const rednote = destinations.includes("xiaohongshu");
  // One text for everyone; X and Bluesky may take a short version, Xiaohongshu its Chinese one.
  const text = {
    title: needsTitle ? title : "",
    caption,
    tags: parseTags(tagsText),
    short: short.trim() ? short : undefined,
    zh: rednote ? { title: zhTitle, text: zhText, topics: parseTags(zhTopicsText) } : undefined,
  };
  const versions = destinations.map((platform) => {
    const variant = renderVariant(platform, text);
    return { platform, variant, issue: problem(platform, variant) };
  });
  const brief: Platform[] = destinations.filter((p) => p === "twitter" || p === "bluesky");
  const needsShort = brief.some((p) => problem(p, renderVariant(p, { ...text, short: undefined }))) || !!short;
  // The counter follows the destination whose limit the main text is closest to.
  const counted = versions
    .filter(({ platform }) => platform !== "xiaohongshu" && !(text.short && brief.includes(platform)))
    .map(({ platform, variant }) => ({ platform, ...usage(platform, variant).at(-1)! }))
    .sort((a, b) => b.used / b.limit - a.used / a.limit)[0];
  const issues = versions.filter(({ issue }) => issue);
  const zhUsage = usage("xiaohongshu", renderVariant("xiaohongshu", text))[1];
  let publishLabel = `Publish to ${destinations.length} ${destinations.length === 1 ? "place" : "places"}`;
  const missingPlatforms = destinations.filter((platform) => !connectedPlatforms.includes(platform));
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
            </div>
            <div className="publisher-compose">
              <section>
                <label htmlFor="publisher-post" className="publisher-composer-label">
                  Post
                </label>
                {/* Files can also be dropped anywhere on the composer. */}
                <div
                  className="publisher-composer"
                  data-dragging={dragging}
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes("Files")) return;
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
                  }}
                  onDrop={(event) => {
                    if (!event.dataTransfer.files.length) return;
                    event.preventDefault();
                    setDragging(false);
                    if (!busy && !submitted) void chooseFiles(Array.from(event.dataTransfer.files));
                  }}
                >
                  <textarea
                    id="publisher-post"
                    value={caption}
                    maxLength={5000}
                    disabled={busy || submitted}
                    onChange={(e) => {
                      setCaption(e.target.value);
                      submission.current = null;
                    }}
                    placeholder="What's happening?"
                    rows={5}
                  />
                  <div className="publisher-composer-tools">
                    <MediaButton
                      accept="image/*"
                      multiple
                      label="Photos"
                      hint={`Up to ${MAX_PHOTOS} photos, 30 MB each`}
                      Icon={ImageIcon}
                      disabled={busy || submitted}
                      onFiles={(next) => void chooseFiles(next)}
                    />
                    <MediaButton
                      accept="video/*"
                      label="Video"
                      hint="One video, up to 90 MB"
                      Icon={VideoIcon}
                      disabled={busy || submitted}
                      onFiles={(next) => void chooseFiles(next)}
                    />
                    {counted && (
                      <small className="publisher-count" data-over={counted.used > counted.limit}>
                        {counted.used} / {counted.limit} · {platformNames[counted.platform]}
                      </small>
                    )}
                  </div>
                </div>
                {!!previews.length && (
                  <div className="publisher-previews">
                    {previews.map((url, i) =>
                      kind === "photo" ? (
                        <img key={url} src={url} alt={files[i]?.name || "Selected photo"} />
                      ) : (
                        <video key={url} src={url} controls />
                      ),
                    )}
                  </div>
                )}
                {!!files.length && (
                  <div className="publisher-actions publisher-media-actions">
                    <button disabled={busy || submitted} onClick={clearMedia}>
                      Remove media
                    </button>
                  </div>
                )}
                {kind === "photo" && (
                  <div className="publisher-photo-details">
                    {destinations.includes("grain") && (
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
                        {destinations.includes("grain") && (
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
                {kind === "video" && (
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
                {needsTitle && (
                  <label>
                    Title · {titledNames}
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
                  Tags
                  <input
                    value={tagsText}
                    maxLength={1000}
                    disabled={busy || submitted}
                    onChange={(e) => {
                      setTagsText(e.target.value);
                      submission.current = null;
                    }}
                    placeholder="#travel #bogota"
                  />
                  <small className="publisher-note">
                    Most important first. Instagram and TikTok take 5, YouTube 3, Bluesky 2 (and 8 hidden), X 1, Grain
                    all.
                  </small>
                </label>
                {needsShort && (
                  <label>
                    Short version · {brief.map((p) => platformNames[p]).join(", ")}
                    <textarea
                      value={short}
                      maxLength={1000}
                      rows={3}
                      disabled={busy || submitted}
                      onChange={(e) => {
                        setShort(e.target.value);
                        submission.current = null;
                      }}
                      placeholder="The post is too long for them; write a shorter one"
                    />
                  </label>
                )}
                {rednote && (
                  <fieldset className="publisher-zh">
                    <legend>Xiaohongshu · Chinese</legend>
                    <button
                      type="button"
                      disabled={busy || submitted || translating || !(title.trim() || caption.trim())}
                      onClick={() => void translate()}
                    >
                      {translating ? "Translating…" : zhTitle || zhText ? "Translate again" : "Translate"}
                    </button>
                    <label>
                      Title
                      <input
                        value={zhTitle}
                        maxLength={100}
                        disabled={busy || submitted}
                        onChange={(e) => {
                          setZhTitle(e.target.value);
                          submission.current = null;
                        }}
                        placeholder="标题"
                      />
                      <small className="publisher-count" data-over={xiaohongshuTitleLength(zhTitle) > 20}>
                        {xiaohongshuTitleLength(zhTitle)} / 20
                      </small>
                    </label>
                    <label>
                      Text
                      <textarea
                        value={zhText}
                        maxLength={5000}
                        rows={5}
                        disabled={busy || submitted}
                        onChange={(e) => {
                          setZhText(e.target.value);
                          submission.current = null;
                        }}
                        placeholder="正文"
                      />
                      <small className="publisher-count" data-over={zhUsage.used > zhUsage.limit}>
                        {zhUsage.used} / {zhUsage.limit}
                      </small>
                    </label>
                    <label>
                      Topics
                      <input
                        value={zhTopicsText}
                        maxLength={500}
                        disabled={busy || submitted}
                        onChange={(e) => {
                          setZhTopicsText(e.target.value);
                          submission.current = null;
                        }}
                        placeholder="#生活美学 #旅行"
                      />
                    </label>
                  </fieldset>
                )}
                {!!versions.length && (
                  <details className="publisher-variants">
                    <summary>What each platform gets</summary>
                    {versions.map(({ platform, variant, issue }) => (
                      <section key={platform}>
                        <h3>
                          {platformNames[platform]}
                          {issue && <small> · {issue}</small>}
                        </h3>
                        {variant.title && <strong>{variant.title}</strong>}
                        <p>{variant.text || "—"}</p>
                        {!!variant.tags.length && (
                          <small>
                            {platform === "bluesky" ? "Hidden tags" : "Topics"}:{" "}
                            {variant.tags.map((tag) => `#${tag}`).join(" ")}
                          </small>
                        )}
                      </section>
                    ))}
                  </details>
                )}
              </section>
              <aside aria-labelledby="publisher-share-to">
                <h2 id="publisher-share-to">Share to</h2>
                <nav className="publisher-presets" aria-label="Presets">
                  {preferences.presets.map((p) => (
                    <button
                      key={p.id}
                      aria-pressed={p.id === preset.id}
                      disabled={busy || submitted}
                      onClick={() => selectPreset(p.id)}
                    >
                      {p.name}
                    </button>
                  ))}
                </nav>
                <div className="publisher-destinations">
                  {platforms.map((p) => (
                    <label key={p} data-unavailable={Boolean(reasons[p])}>
                      <span>
                        {platformNames[p]}
                        {reasons[p] && <small>{reasons[p]}</small>}
                      </span>
                      <input
                        type="checkbox"
                        checked={preset.platforms.includes(p) && !reasons[p]}
                        disabled={busy || submitted || Boolean(reasons[p])}
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
                {destinations.includes("youtube") && (
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
                  <p className="publisher-note">Saved in this browser. Videos remove all optional metadata.</p>
                  {preset.platforms.map((p) => (
                    <label key={p}>
                      {platformNames[p]} photo metadata
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
                  disabled={busy || !destinations.length || (kind === "text" && !caption.trim())}
                  onClick={submit}
                >
                  {publishLabel}
                </button>
                {!destinations.length && (
                  <p className="publisher-note">None of the selected destinations take {unavailableFor[kind]}.</p>
                )}
                {issues.map(({ platform, issue }) => (
                  <p key={platform} className="publisher-problem">
                    {platformNames[platform]}: {issue}
                  </p>
                ))}
                {!!files.length && (
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
