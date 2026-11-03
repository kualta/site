import PublisherAnalytics from "./PublisherAnalytics";
import { exifDateTime } from "@/lib/publisher/photo-date";
import PublisherHistory from "./PublisherHistory";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AlertIcon, CheckIcon, CloseIcon, ImageIcon, VideoIcon, type IconComponent } from "@/components/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import PublisherConnections, { type Connection } from "./PublisherConnections";
import PublisherChinese from "./PublisherChinese";
import PublisherCover, { type Cover } from "./PublisherCover";
import {
  defaultPreferences,
  MAX_PHOTOS,
  MAX_PRESETS,
  parsePreferences,
  platforms,
  needsTitle as titleFor,
  platformNames,
  postFormat,
  postKind,
  publicOnly,
  reframesToShort,
  STORAGE_KEY,
  unsupported,
  videoFormat,
  type VideoShape,
  type Preferences,
  type Preset,
  type Platform,
  type PostKind,
} from "@/lib/publisher/presets";
import "@/styles/publisher.css";
import type { Draft } from "@/lib/publisher/drafts";
import { describeProgress, readWithProgress } from "@/lib/publisher/download";
import { frameAt } from "@/lib/publisher/frame";
import { coverPlatforms, locationPlatforms, MAX_LOCATION, validatePost } from "@/lib/publisher/server";
import { parseTags, problem, renderVariant, usage } from "@/lib/publisher/variants";

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
// Places tagged before, offered first in the location field.
const PLACES_KEY = "publisher.places";
/** Why a video attached with other media waits for the owner's word. */
const carouselRequired =
  "A video with other media isn't posted until you choose Post as one carousel. To post it as a Reel or Short, remove the other media.";
const unavailableFor: Record<PostKind, string> = {
  text: "text-only posts",
  photo: "these photos",
  video: "this video",
  mixed: "photos and videos together",
};
/** Resolves undefined when this browser cannot read the file; the laptop checks it again. */
function videoShape(file: File): Promise<VideoShape | undefined> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (shape?: VideoShape) => {
      URL.revokeObjectURL(url);
      resolve(shape);
    };
    video.preload = "metadata";
    // Chrome can read a file's container without its codec, or not know how long it is: that's no shape at all.
    video.onloadedmetadata = () =>
      done(
        video.videoWidth && video.videoHeight && Number.isFinite(video.duration)
          ? { seconds: video.duration, width: video.videoWidth, height: video.videoHeight }
          : undefined,
      );
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
/** A message held at the bottom of the window: errors are announced at once, notices when the reader is free. */
function Toast({ tone, text, onDismiss }: { tone: "error" | "notice"; text: string; onDismiss: () => void }) {
  const Icon = tone === "error" ? AlertIcon : CheckIcon;
  return (
    <div className="publisher-toast" data-tone={tone}>
      <Icon size={18} />
      <p role={tone === "error" ? "alert" : "status"}>{text}</p>
      <button type="button" aria-label="Dismiss" onClick={onDismiss}>
        <CloseIcon size={16} />
      </button>
    </div>
  );
}
type Access = "loading" | "owner" | "signin" | "denied";
/** What the page already knows from rendering on the server; without it the composer asks from the browser. */
interface Props {
  initialAccess?: Access;
  initialHelper?: { online: boolean; platforms: Platform[] };
}
export default function Publisher({ initialAccess = "loading", initialHelper }: Props) {
  const [tab, setTab] = useState<"compose" | "analytics">("compose");
  const [access, setAccess] = useState<Access>(initialAccess);
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [ready, setReady] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [video, setVideo] = useState<VideoShape>();
  // The owner's answer to "Post as a Short"; until they give one, the preset decides.
  const [shortChoice, setShortChoice] = useState<boolean>();
  // A video goes in a carousel only when the owner says so for exactly these attachments.
  const [asCarousel, setAsCarousel] = useState(false);
  const [datesTaken, setDatesTaken] = useState<string[]>([]);
  const [readingDates, setReadingDates] = useState(false);
  const datesRead = useRef(new WeakSet<File>());
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
  // A version of the video made for Chinese audiences, which Xiaohongshu gets in place of the original.
  const [chineseVideo, setChineseVideo] = useState<File>();
  const [cover, setCover] = useState<Cover>();
  const [place, setPlace] = useState("");
  // Xiaohongshu's own name for the place, in Chinese.
  const [zhPlace, setZhPlace] = useState("");
  const [recentPlaces, setRecentPlaces] = useState<string[]>([]);
  const chinesePreview = useMemo(() => chineseVideo && URL.createObjectURL(chineseVideo), [chineseVideo]);
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [token, setToken] = useState("");
  const [helperOnline, setHelperOnline] = useState(initialHelper?.online ?? false);
  const [connectedPlatforms, setConnectedPlatforms] = useState<Platform[]>(initialHelper?.platforms ?? []);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [dragging, setDragging] = useState(false);
  const submission = useRef<{
    id: string;
    media: string[];
    zhVideo?: string;
    cover?: string;
    zhCover?: string;
    payload?: unknown;
  } | null>(null);
  const [openingDraft, setOpeningDraft] = useState(false);
  // How far a draft's videos have come down, so a large one doesn't look like an empty page.
  const [draftLoad, setDraftLoad] = useState<{ video: number; videos: number; loaded: number; total?: number }>();
  const draftId = useRef<string | null>(null);
  // A draft's video is already in Cloudflare, so publishing it doesn't upload it again.
  const storedMedia = useRef(new WeakMap<File, string>());
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
      if (typeof draft?.location === "string") setPlace(draft.location.slice(0, MAX_LOCATION));
    } catch {
      // A draft is a convenience; start empty without it.
    }
    try {
      const saved = JSON.parse(localStorage.getItem(PLACES_KEY) ?? "[]");
      if (Array.isArray(saved)) setRecentPlaces(saved.filter((place) => typeof place === "string").slice(0, 8));
    } catch {
      // Recent places are a convenience too.
    }
    setReady(true);
    if (initialAccess !== "loading") return;
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
      if (title || caption || tagsText || short || zhTitle || zhText || zhTopicsText || place)
        sessionStorage.setItem(
          DRAFT_KEY,
          JSON.stringify({ title, caption, tags: tagsText, short, zh, location: place }),
        );
      else sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      // Keep the draft in memory.
    }
  }, [title, caption, tagsText, short, zhTitle, zhText, zhTopicsText, place, ready]);
  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);
  useEffect(() => {
    if (chinesePreview) return () => URL.revokeObjectURL(chinesePreview);
  }, [chinesePreview]);
  // A notice is good news that needs no answer, so it steps aside on its own; errors wait to be read.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 8000);
    return () => clearTimeout(timer);
  }, [notice]);
  // Each photo's date is read once, so adding more media keeps dates already read or edited.
  useEffect(() => {
    const unread = files.filter((file) => file.type.startsWith("image/") && !datesRead.current.has(file));
    if (!unread.length) return;
    let active = true;
    setReadingDates(true);
    async function readDates() {
      try {
        const { parse } = await import("exifr");
        const found = new Map(
          await Promise.all(
            unread.map(async (file) => {
              try {
                const exif = await parse(file, {
                  pick: ["DateTimeOriginal", "OffsetTimeOriginal"],
                  reviveValues: false,
                });
                return [file, exifDateTime(exif?.DateTimeOriginal, exif?.OffsetTimeOriginal)] as const;
              } catch {
                return [file, ""] as const;
              }
            }),
          ),
        );
        if (!active) return;
        for (const file of unread) datesRead.current.add(file);
        setDatesTaken((dates) => files.map((file, i) => dates[i] || found.get(file) || ""));
      } catch {
        // Reading EXIF is optional; manual capture dates remain available.
      } finally {
        if (active) setReadingDates(false);
      }
    }
    void readDates();
    return () => {
      active = false;
      setReadingDates(false);
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
  // A draft sent from the terminal opens with its video and text in place, all at once: until the video
  // arrives the composer stays locked, so it can't go out as a text post.
  useEffect(() => {
    if (access !== "owner") return;
    const id = new URLSearchParams(location.search).get("draft");
    if (!id) return;
    /** A draft's upload as a file. Videos show their progress; covers are small and come down without. */
    async function storedFile(media: string, name: string, progress?: { video: number; videos: number }) {
      if (progress) setDraftLoad({ ...progress, loaded: 0 });
      const response = await fetch(`/api/publisher/media/${media}`);
      if (!response.ok) throw new Error(`This draft's ${progress ? "video" : "cover"} has expired`);
      // A render per percent (or per megabyte without a total), not per network chunk.
      let shown = -1;
      const blob = progress
        ? await readWithProgress(response, (loaded, total) => {
            const step = total ? Math.floor((loaded / total) * 100) : Math.floor(loaded / 1e6);
            if (step === shown) return;
            shown = step;
            setDraftLoad({ ...progress, loaded, total });
          })
        : await response.blob();
      const file = new File([blob], name, { type: blob.type });
      storedMedia.current.set(file, media);
      return file;
    }
    async function openDraft(id: string) {
      setBusy(true);
      setOpeningDraft(true);
      try {
        const draft: Draft = await api(`drafts/${id}`);
        const videos = draft.zh?.video ? 2 : 1;
        const file = await storedFile(draft.video, draft.title, { video: 1, videos });
        const chinese = draft.zh?.video
          ? await storedFile(draft.zh.video, `${draft.title} (Chinese)`, { video: 2, videos })
          : undefined;
        const coverFile = draft.cover ? await storedFile(draft.cover, "cover.jpg") : undefined;
        const zhCoverFile = draft.zh?.cover ? await storedFile(draft.zh.cover, "cover-zh.jpg") : undefined;
        await showMedia([file], [""], [""]);
        setChineseVideo(chinese);
        setCover(coverFile && { file: coverFile, zh: zhCoverFile });
        setPlace(draft.location ?? "");
        setZhPlace(draft.zh?.location ?? "");
        const active = draft.preset;
        if (active) setPreferences((p) => (p.presets.some((item) => item.id === active) ? { ...p, active } : p));
        setTitle(draft.title);
        setCaption(draft.caption);
        setAlt(draft.alt);
        setTagsText(draft.tags?.join(" ") ?? "");
        setShort(draft.short ?? "");
        setZhTitle(draft.zh?.title ?? "");
        setZhText(draft.zh?.text ?? "");
        setZhTopicsText(draft.zh?.topics.join(" ") ?? "");
        draftId.current = id;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not open this draft");
      } finally {
        setOpeningDraft(false);
        setDraftLoad(undefined);
        setBusy(false);
      }
    }
    void openDraft(id);
  }, [access]);
  async function signIn() {
    setError("");
    try {
      const { createFlow } = await import("@flow-industries/id");
      await createFlow().login({ returnTo: location.pathname + location.search });
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
      if (kind === "mixed" && !asCarousel) throw new Error(carouselRequired);
      if (needsTitle && !title.trim()) throw new Error(`Add a title for ${titledNames}.`);
      const photo = kind === "photo";
      const mediaKinds = files.map((file) => (file.type.startsWith("video/") ? "video" : "photo"));
      const payload = (id: string, media: string[], zhVideo?: string, coverId?: string, zhCoverId?: string) => ({
        id,
        media,
        kind,
        mediaKinds: kind === "mixed" ? mediaKinds : undefined,
        carousel: kind === "mixed" ? (true as const) : undefined,
        ...text,
        zh: text.zh && zhVideo ? { ...text.zh, video: zhVideo, ...(zhCoverId ? { cover: zhCoverId } : {}) } : text.zh,
        alt: kind === "video" ? alt : "",
        alts: photo ? alts : undefined,
        datesTaken: photo ? datesTaken.map((date) => (date ? new Date(date).toISOString() : null)) : undefined,
        platforms: destinations,
        metadata: preset.metadata,
        visibility: preset.visibility,
        youtubeShort: youtubeShort || undefined,
        cover: coverId,
        location: sentLocation || undefined,
      });
      validatePost(
        payload(
          crypto.randomUUID(),
          files.map(() => crypto.randomUUID()),
          sentChineseVideo && crypto.randomUUID(),
          sentCover && crypto.randomUUID(),
          sendsZhCover ? crypto.randomUUID() : undefined,
        ),
      );
      const uploadMedia = async (file: File): Promise<string> => {
        const stored = storedMedia.current.get(file);
        if (stored) return stored;
        const response = await fetch("/api/publisher/media", {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Upload failed");
        return result.id;
      };
      const pending = (submission.current ||= { id: crypto.randomUUID(), media: [] });
      for (let i = pending.media.length; i < files.length; i++) pending.media.push(await uploadMedia(files[i]));
      if (sentChineseVideo) pending.zhVideo ||= await uploadMedia(sentChineseVideo);
      if (sentCover) pending.cover ||= await uploadMedia(sentCover.file);
      // Xiaohongshu's Chinese version shows its own frame from the same moment.
      if (sendsZhCover && sentCover && sentChineseVideo && !pending.zhCover)
        pending.zhCover = await uploadMedia(
          sentCover.zh ?? (await frameAt(sentChineseVideo, sentCover.at ?? 0, "cover-zh.jpg")),
        );
      // Freeze the request after uploading. A lost response retries the same job.
      pending.payload ||= payload(pending.id, pending.media, pending.zhVideo, pending.cover, pending.zhCover);
      setSubmitted(true);
      await api("jobs", pending.payload);
      setSubmitted(false);
      if (draftId.current) {
        // If this delete is lost, the server still refuses to queue the same video twice.
        api(`drafts/${draftId.current}`, undefined, "DELETE").catch(() => {});
        draftId.current = null;
        window.history.replaceState(null, "", location.pathname);
      }
      clearMedia();
      if (sentLocation) {
        const next = [sentLocation, ...recentPlaces.filter((recent) => recent !== sentLocation)].slice(0, 8);
        setRecentPlaces(next);
        try {
          localStorage.setItem(PLACES_KEY, JSON.stringify(next));
        } catch {
          // The place is still offered for this visit.
        }
      }
      setPlace("");
      setZhPlace("");
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
    setShortChoice(undefined);
    submission.current = null;
  }
  function clearMedia() {
    setFiles([]);
    setChineseVideo(undefined);
    setCover(undefined);
    setVideo(undefined);
    setShortChoice(undefined);
    setAsCarousel(false);
    setAlts([]);
    setDatesTaken([]);
    submission.current = null;
  }
  /** Media lists stay index-aligned with each photo's description and date. */
  async function showMedia(next: File[], nextAlts: string[], nextDates: string[]) {
    const first = next.find((file) => file.type.startsWith("video/"));
    // A cover belongs to the video it was taken from.
    if (first !== files.find((file) => file.type.startsWith("video/"))) setCover(undefined);
    // A Chinese version belongs to the video it translates, so it goes when no video is left.
    if (!first) setChineseVideo(undefined);
    setVideo(first ? await videoShape(first) : undefined);
    setShortChoice(undefined);
    setAsCarousel(false);
    setFiles(next);
    setAlts(nextAlts);
    setDatesTaken(nextDates);
    submission.current = null;
    setError("");
  }
  function removeFile(index: number) {
    const keep = (_: unknown, i: number) => i !== index;
    void showMedia(files.filter(keep), alts.filter(keep), datesTaken.filter(keep));
  }
  // Picked media adds to what's attached, so photos and videos can go out together.
  async function chooseFiles(picked: File[]) {
    if (!picked.length) return;
    const next = [...files, ...picked];
    if (
      next.length > MAX_PHOTOS ||
      next.some((f) => !f.type.startsWith("image/") && !f.type.startsWith("video/")) ||
      next.some((f) => f.size > (f.type.startsWith("video/") ? 90e6 : 30e6))
    ) {
      setError(`Attach up to ${MAX_PHOTOS} photos and videos: photos up to 30 MB, videos up to 90 MB.`);
      return;
    }
    const blank = picked.map(() => "");
    await showMedia(next, [...alts, ...blank], [...datesTaken, ...blank]);
  }
  function chooseChineseVideo(file: File) {
    if (!file.type.startsWith("video/") || file.size > 90e6) {
      setError("The Chinese version is one video, up to 90 MB.");
      return;
    }
    setChineseVideo(file);
    submission.current = null;
    setError("");
  }
  // The attachments decide the kind; the preset's destinations that can't take it are skipped.
  const kind = postKind(files);
  const reasons = Object.fromEntries(
    platforms.map((p) => [p, unsupported(p, kind, files.length, video?.seconds)]),
  ) as Record<Platform, string | null>;
  const destinations = preset.platforms.filter((p) => !reasons[p]);
  const titledNames = destinations
    .filter((p) => titleFor(p, kind))
    .map((p) => platformNames[p])
    .join(", ");
  const needsTitle = titledNames !== "";
  const rednote = destinations.includes("xiaohongshu");
  const sentChineseVideo = rednote && kind === "video" ? chineseVideo : undefined;
  const namesOf = (list: Platform[]) => list.map((p) => platformNames[p]).join(", ");
  const coverTargets = kind === "video" ? destinations.filter((p) => coverPlatforms.includes(p)) : [];
  const sentCover = coverTargets.length ? cover : undefined;
  const locationTargets = destinations.filter((p) => locationPlatforms.includes(p));
  const sentLocation = locationTargets.length ? place.trim() : "";
  // Xiaohongshu's Chinese version gets its own cover: the draft's, or its frame at the chosen moment.
  const sendsZhCover = Boolean(sentCover && sentChineseVideo && (sentCover.zh || sentCover.at !== undefined));
  const toYouTube = kind === "video" && destinations.includes("youtube");
  const canReframe = toYouTube && reframesToShort(video);
  const youtubeShort = canReframe && (shortChoice ?? preset.id === "short");
  const videoLabel = (p: Platform) => (p === "youtube" && youtubeShort ? "Short" : videoFormat(p, video));
  const formatLabel = (p: Platform) => (kind === "video" ? videoLabel(p) : postFormat(p, kind, files.length));
  // Where a video sent with other media goes out as one post.
  const carouselNames = namesOf(destinations);
  // One text for everyone; X, Bluesky and Farcaster may take a short version, Xiaohongshu its Chinese one.
  const text = {
    title: needsTitle ? title : "",
    caption,
    tags: parseTags(tagsText),
    short: short.trim() ? short : undefined,
    zh: rednote
      ? {
          title: zhTitle,
          text: zhText,
          topics: parseTags(zhTopicsText),
          ...(zhPlace.trim() ? { location: zhPlace.trim() } : {}),
        }
      : undefined,
  };
  const versions = destinations.map((platform) => {
    const variant = renderVariant(platform, text);
    return { platform, variant, issue: problem(platform, variant) };
  });
  const brief: Platform[] = destinations.filter((p) => p === "twitter" || p === "bluesky" || p === "farcaster");
  const needsShort = brief.some((p) => problem(p, renderVariant(p, { ...text, short: undefined }))) || !!short;
  // The counter follows the destination whose limit the main text is closest to.
  const counted = versions
    .filter(({ platform }) => platform !== "xiaohongshu" && !(text.short && brief.includes(platform)))
    .map(({ platform, variant }) => ({ platform, ...usage(platform, variant).at(-1)! }))
    .sort((a, b) => b.used / b.limit - a.used / a.limit)[0];
  const issues = versions.filter(({ issue }) => issue);
  if (preset.visibility !== "PUBLIC" && destinations.some((p) => publicOnly(p, kind)))
    issues.push({
      platform: "youtube",
      variant: renderVariant("youtube", text),
      issue: "shows photo posts to everyone: set YouTube visibility to Public",
    });
  let publishLabel = `Publish to ${destinations.length} ${destinations.length === 1 ? "place" : "places"}`;
  const missingPlatforms = destinations.filter((platform) => !connectedPlatforms.includes(platform));
  if (!helperOnline || missingPlatforms.length) publishLabel = "Queue post";
  if (submitted) publishLabel = "Retry queue request";
  if (busy && !openingDraft) publishLabel = "Uploading…";
  if (busy && openingDraft) {
    const which = draftLoad && draftLoad.videos > 1 ? `video ${draftLoad.video} of ${draftLoad.videos}` : "video";
    const percent = draftLoad?.total ? ` ${Math.floor((draftLoad.loaded / draftLoad.total) * 100)}%` : "";
    publishLabel = `Loading ${which}…${percent}`;
  }
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
                    placeholder={openingDraft ? "Opening draft…" : "What's happening?"}
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
                      multiple
                      label="Video"
                      hint="Videos up to 90 MB each"
                      Icon={VideoIcon}
                      disabled={busy || submitted}
                      onFiles={(next) => void chooseFiles(next)}
                    />
                    {!!files.length && (
                      <button type="button" disabled={busy || submitted} onClick={clearMedia}>
                        <CloseIcon size={16} />
                        Remove media
                      </button>
                    )}
                    {counted && (
                      <small className="publisher-count" data-over={counted.used > counted.limit}>
                        {counted.used} / {counted.limit} · {platformNames[counted.platform]}
                      </small>
                    )}
                  </div>
                </div>
                {openingDraft && (
                  <div className="publisher-draft-loading" role="status" aria-live="polite">
                    <p>
                      Opening draft
                      {draftLoad && draftLoad.videos > 1 && (
                        <span>
                          {" "}
                          · Video {draftLoad.video} of {draftLoad.videos}
                        </span>
                      )}
                    </p>
                    <progress
                      value={draftLoad?.total ? draftLoad.loaded : undefined}
                      max={draftLoad?.total}
                      aria-label="Draft video downloaded"
                    />
                    <small>
                      {draftLoad ? describeProgress(draftLoad.loaded, draftLoad.total) : "Reading the draft…"}
                    </small>
                  </div>
                )}
                {!!previews.length && (
                  <div className="publisher-previews" data-single-video={kind === "video" || undefined}>
                    {previews.map((url, i) => (
                      <figure key={url}>
                        {files[i]?.type.startsWith("video/") ? (
                          <video src={url} controls={kind === "video"} muted={kind !== "video"} playsInline />
                        ) : (
                          <img src={url} alt={files[i]?.name || "Selected photo"} />
                        )}
                        <button
                          type="button"
                          aria-label={`Remove ${files[i]?.name || "media"}`}
                          disabled={busy || submitted}
                          onClick={() => removeFile(i)}
                        >
                          <CloseIcon aria-hidden="true" />
                        </button>
                      </figure>
                    ))}
                  </div>
                )}
                {kind === "mixed" && (
                  <div className="publisher-carousel">
                    <label className="publisher-option">
                      Post as one carousel
                      <input
                        type="checkbox"
                        checked={asCarousel}
                        disabled={busy || submitted}
                        onChange={(e) => {
                          setAsCarousel(e.target.checked);
                          submission.current = null;
                        }}
                      />
                    </label>
                    <p className="publisher-note">
                      {asCarousel
                        ? `The video and the other ${files.length - 1} go out together${
                            carouselNames ? ` on ${carouselNames}` : ""
                          }, not as a Reel or Short.`
                        : carouselRequired}
                    </p>
                  </div>
                )}
                {kind === "video" && (
                  <label>
                    Video description<span className="publisher-for"> · Bluesky, Lens</span>
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
                    Title<span className="publisher-for"> · {titledNames}</span>
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
                    Most important first. Instagram and TikTok add 5 at the end, YouTube 3 to the description, Bluesky
                    and Lens keep 8 hidden. X, Grain and Farcaster get none.
                  </small>
                </label>
                {!!locationTargets.length && (
                  <label>
                    Location<span className="publisher-for"> · {namesOf(locationTargets)}</span>
                    <input
                      value={place}
                      maxLength={MAX_LOCATION}
                      list="publisher-places"
                      disabled={busy || submitted}
                      onChange={(e) => {
                        setPlace(e.target.value);
                        submission.current = null;
                      }}
                      placeholder="Bogotá, Colombia"
                    />
                    <datalist id="publisher-places">
                      {recentPlaces.map((recent) => (
                        <option key={recent} value={recent} />
                      ))}
                    </datalist>
                    <small className="publisher-note">
                      Each platform tags its closest match from its own list of places.
                    </small>
                  </label>
                )}
                {needsShort && (
                  <label>
                    Short version<span className="publisher-for"> · {namesOf(brief)}</span>
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
                {kind === "photo" && (
                  <div className="publisher-photo-details publisher-group">
                    {destinations.includes("grain") && (
                      <p className="publisher-note">
                        Date taken · Grain · {Intl.DateTimeFormat().resolvedOptions().timeZone}. Photos without a
                        timezone use this timezone. Read from the original photo; edit or clear before posting.
                      </p>
                    )}
                    {files.map((file, index) => (
                      <fieldset key={`${file.name}-${index}`} className="publisher-photo">
                        <legend>
                          Photo {index + 1}
                          <span className="publisher-for"> · {file.name}</span>
                        </legend>
                        <label>
                          Description<span className="publisher-for"> · Grain, Bluesky, Lens</span>
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
                {kind === "video" && files[0] && !!coverTargets.length && (
                  <PublisherCover
                    video={files[0]}
                    value={cover}
                    onChange={(next) => {
                      setCover(next);
                      submission.current = null;
                    }}
                    platforms={namesOf(coverTargets)}
                    others={namesOf(destinations.filter((p) => !coverPlatforms.includes(p)))}
                    disabled={busy || submitted}
                    onError={setError}
                  />
                )}
                {rednote && (
                  <PublisherChinese
                    value={{ title: zhTitle, text: zhText, topics: zhTopicsText }}
                    onChange={(zh) => {
                      setZhTitle(zh.title);
                      setZhText(zh.text);
                      setZhTopicsText(zh.topics);
                      submission.current = null;
                    }}
                    onTranslate={() => void translate()}
                    translating={translating}
                    canTranslate={Boolean(title.trim() || caption.trim())}
                    disabled={busy || submitted}
                  >
                    {locationTargets.includes("xiaohongshu") && (
                      <label>
                        地点
                        <input
                          value={zhPlace}
                          maxLength={MAX_LOCATION}
                          disabled={busy || submitted}
                          onChange={(e) => {
                            setZhPlace(e.target.value);
                            submission.current = null;
                          }}
                          placeholder="波哥大"
                        />
                        <small className="publisher-note">
                          Xiaohongshu lists places by their Chinese names. Without one, it searches the location above.
                        </small>
                      </label>
                    )}
                    {kind === "video" && (
                      <div className="publisher-zh-video">
                        {chineseVideo ? (
                          <div className="publisher-previews" data-single-video>
                            <figure>
                              <video src={chinesePreview} controls playsInline />
                              <button
                                type="button"
                                aria-label="Remove the Chinese version"
                                disabled={busy || submitted}
                                onClick={() => {
                                  setChineseVideo(undefined);
                                  submission.current = null;
                                }}
                              >
                                <CloseIcon aria-hidden="true" />
                              </button>
                            </figure>
                          </div>
                        ) : (
                          <MediaButton
                            accept="video/*"
                            label="Chinese version"
                            hint="The same video made for Chinese audiences, up to 90 MB"
                            Icon={VideoIcon}
                            disabled={busy || submitted}
                            onFiles={([file]) => file && chooseChineseVideo(file)}
                          />
                        )}
                        <small className="publisher-note">
                          {chineseVideo
                            ? "Xiaohongshu gets this video. Every other destination gets the one above."
                            : "Have one made for Chinese audiences? Xiaohongshu gets it, and every other destination keeps the video above."}
                        </small>
                      </div>
                    )}
                  </PublisherChinese>
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
                        {platform === "xiaohongshu" && sentChineseVideo && <small>Video: the Chinese version</small>}
                        {sentCover && coverTargets.includes(platform) && (
                          <small>
                            Cover:{" "}
                            {platform === "xiaohongshu" && sendsZhCover
                              ? "the same moment of the Chinese version"
                              : "the one chosen above"}
                          </small>
                        )}
                        {sentLocation && locationTargets.includes(platform) && <small>Location: {sentLocation}</small>}
                        {!!variant.tags.length && (
                          <small>
                            {platform === "bluesky" || platform === "lens" ? "Hidden tags" : "Topics"}:{" "}
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
                        {reasons[p] ? <small>{reasons[p]}</small> : formatLabel(p) && <small>{formatLabel(p)}</small>}
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
                {canReframe && (
                  <label className="publisher-option">
                    Post as a Short
                    <input
                      type="checkbox"
                      checked={youtubeShort}
                      disabled={busy || submitted}
                      onChange={(e) => {
                        setShortChoice(e.target.checked);
                        submission.current = null;
                      }}
                    />
                  </label>
                )}
                {toYouTube && preset.id === "short" && !!video && video.seconds > 180 && (
                  <p className="publisher-note">Over 3 minutes, so YouTube gets this as a regular video.</p>
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
                  disabled={
                    busy ||
                    !destinations.length ||
                    (kind === "text" && !caption.trim()) ||
                    (kind === "mixed" && !asCarousel)
                  }
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
      {/* Messages float at the bottom of the window, so they show beside whatever was just pressed. */}
      <div className="publisher-toasts">
        {error && <Toast tone="error" text={error} onDismiss={() => setError("")} />}
        {notice && <Toast tone="notice" text={notice} onDismiss={() => setNotice("")} />}
      </div>
    </main>
  );
}
