import PublisherAnalytics from "./PublisherAnalytics";
import PublisherCalendar from "./PublisherCalendar";
import { exifDateTime } from "@/lib/publisher/photo-date";
import PublisherHistory from "./PublisherHistory";
import PlatformIcon from "./PlatformIcon";
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
  support,
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
import { readPath, tabPath, type Tab } from "@/lib/publisher/route";
import {
  defaultSchedule,
  localInput,
  nextSlot,
  parseSchedule,
  parseTimes,
  SCHEDULE_KEY,
  slotOnDay,
  type Schedule,
  validTimeZone,
} from "@/lib/publisher/schedule";
import { saveThumbnail, thumbnailOf } from "@/lib/publisher/thumbnail";

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
/**
 * The composer's text as this tab keeps it, so a reload keeps what was typed. For an open draft it also names the
 * draft and says whether it has edits the draft hasn't saved yet; opening that draft again puts them back.
 */
interface StoredText {
  title?: string;
  caption?: string;
  alt?: string;
  tags?: string;
  short?: string;
  zh?: { title?: string; text?: string; topics?: string; location?: string };
  location?: string;
  draft?: string;
  pending?: boolean;
}
/** How long the composer waits after the last edit before it saves the open draft. */
const AUTOSAVE_MS = 1000;
// Places tagged before, offered first in the location field.
const PLACES_KEY = "publisher.places";
/** Why a video attached with other media waits for the owner's word. */
const carouselRequired = "Choose Post as one carousel, or remove the other media.";
const unavailableFor: Record<PostKind, string> = {
  text: "text-only posts",
  photo: "these photos",
  video: "this video",
  mixed: "photos and videos together",
};
/** How long a video's shape is waited for before the composer goes on without it. */
const SHAPE_WAIT_MS = 10_000;
/** Resolves undefined when this browser cannot read the file; the laptop checks it again. */
function videoShape(file: File): Promise<VideoShape | undefined> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    let timer: number | undefined;
    const done = (shape?: VideoShape) => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", read);
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
    // A background tab defers media loading, and a video outside the page never gets it back once the tab is shown,
    // so a draft opened behind other tabs waited forever. Read the file once the tab is visible, and never for long.
    const read = () => {
      if (document.hidden || timer !== undefined) return;
      timer = window.setTimeout(done, SHAPE_WAIT_MS);
      video.src = url;
    };
    document.addEventListener("visibilitychange", read);
    read();
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
  /** The tab the server rendered, from the path; the browser reads the address itself. */
  initialTab?: Tab;
}
type Address = { pathname: string; search: string };
const currentAddress = (): Address => ({ pathname: location.pathname, search: location.search });
export default function Publisher({ initialAccess = "loading", initialHelper, initialTab = "compose" }: Props) {
  // The address says which tab is open and, in Analytics, what it shows; Back and Forward move between them.
  const [address, setAddress] = useState<Address>(() =>
    typeof window === "undefined" ? { pathname: tabPath("", initialTab), search: "" } : currentAddress(),
  );
  const { base, tab } = readPath(address.pathname);
  // Where each tab was left, so switching back returns to it.
  const tabSearch = useRef<Partial<Record<Tab, string>>>({});
  useEffect(() => {
    const sync = () => setAddress(currentAddress());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  useEffect(() => {
    document.title = tab === "analytics" ? "analytics · kualta" : "post · kualta";
  }, [tab]);
  function navigate(pathname: string, search: string, replace = false) {
    if (pathname === location.pathname && search === location.search) return;
    window.history[replace ? "replaceState" : "pushState"](null, "", pathname + search);
    setAddress(currentAddress());
  }
  function openTab(next: Tab) {
    if (next === tab) return;
    tabSearch.current[tab] = location.search;
    navigate(tabPath(base, next), tabSearch.current[next] ?? "");
  }
  const [access, setAccess] = useState<Access>(initialAccess);
  // On a narrow phone the tabs scroll sideways; the open one is kept in view.
  const tabsBar = useRef<HTMLElement>(null);
  useEffect(() => {
    const bar = tabsBar.current;
    const open = bar?.querySelector('[aria-pressed="true"]');
    if (!bar || !open) return;
    const shown = bar.getBoundingClientRect();
    const button = open.getBoundingClientRect();
    bar.scrollLeft += Math.max(0, button.right - shown.right) + Math.min(0, button.left - shown.left);
  }, [tab, access]);
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
  // When the post goes out: now, at each platform's next free slot, or on a chosen day, at local times.
  const [when, setWhen] = useState<"now" | "next" | "day">("now");
  const [day, setDay] = useState("");
  // Times the owner set by hand, over the computed ones.
  const [ownTimes, setOwnTimes] = useState<Partial<Record<Platform, number>>>({});
  // Each platform's best times of day and the hours its posts keep apart.
  const [postingTimes, setPostingTimes] = useState<Schedule>(defaultSchedule);
  const [busyTimes, setBusyTimes] = useState<Record<string, number[]>>({});
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
  // What an opening draft still has coming once its text is in place; it's a video post from the start.
  const [pendingDraft, setPendingDraft] = useState<{ zhVideo: boolean; cover: boolean }>();
  // The draft in the composer, which the drafts list marks rather than offers, and a nudge to list them again.
  const [openDraftId, setOpenDraftId] = useState<string | null>(null);
  const [draftsVersion, setDraftsVersion] = useState(0);
  const [postsVersion, setPostsVersion] = useState(0);
  const draftId = useRef<string | null>(null);
  // A draft's video is already in Cloudflare, so publishing it doesn't upload it again.
  const storedMedia = useRef(new WeakMap<File, string>());
  // Each file goes up once, whether a draft or the post takes it first.
  const uploads = useRef(new WeakMap<File, Promise<string>>());
  // An open draft's edits from before a reload, read before the composer starts saving over them.
  const storedText = useRef<StoredText | null>(null);
  // What the open draft holds now, so an edit that changes nothing saves nothing.
  const savedDraft = useRef("");
  const autosaving = useRef<Promise<void>>(undefined);
  const [draftStatus, setDraftStatus] = useState<"saving" | "saved" | { failed: string }>();
  const [saving, setSaving] = useState(false);
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
      const stored: StoredText | null = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "null");
      // An open draft's text comes back when the draft opens again, over the draft's own. Without the draft, a new
      // post starts empty.
      if (stored?.draft) {
        if (new URLSearchParams(location.search).get("draft") === stored.draft) storedText.current = stored;
      } else if (stored) fillText(stored);
    } catch {
      // A draft is a convenience; start empty without it.
    }
    try {
      const saved = JSON.parse(localStorage.getItem(PLACES_KEY) ?? "[]");
      if (Array.isArray(saved)) setRecentPlaces(saved.filter((place) => typeof place === "string").slice(0, 8));
    } catch {
      // Recent places are a convenience too.
    }
    try {
      setPostingTimes(parseSchedule(localStorage.getItem(SCHEDULE_KEY)));
    } catch {
      // The defaults stand in.
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
      localStorage.setItem(SCHEDULE_KEY, JSON.stringify(postingTimes));
    } catch {
      // They last for this visit.
    }
  }, [postingTimes, ready]);
  // What each platform has out or scheduled already, read when a post is to be scheduled and after each one is.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new post is the trigger to read them again
  useEffect(() => {
    if (access !== "owner" || when === "now") return;
    api("schedule")
      .then((data) => setBusyTimes(data.busy ?? {}))
      .catch((e) => setError(e.message));
  }, [access, when, postsVersion]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the text and the draft's status are the trigger; draftJson reads them
  useEffect(() => {
    // Until a draft opens and takes back its edits, they stay stored; while it opens, its text isn't the owner's yet.
    if (!ready || openingDraft || storedText.current) return;
    try {
      const zh = { title: zhTitle, text: zhText, topics: zhTopicsText, location: zhPlace };
      const stored: StoredText = { title, caption, alt, tags: tagsText, short, zh, location: place };
      if (openDraftId) {
        stored.draft = openDraftId;
        stored.pending = draftJson() !== savedDraft.current;
      }
      if (openDraftId || title || caption || alt || tagsText || short || zhTitle || zhText || zhTopicsText || place)
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify(stored));
      else sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      // Keep the draft in memory.
    }
  }, [
    title,
    caption,
    alt,
    tagsText,
    short,
    zhTitle,
    zhText,
    zhTopicsText,
    place,
    zhPlace,
    ready,
    openingDraft,
    openDraftId,
    draftStatus,
  ]);
  // The open draft keeps the owner's edits a moment after each one, so a reload or another device opens them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: every field of the draft is the trigger; draftJson and autosave read them
  useEffect(() => {
    if (!openDraftId || openingDraft || busy || submitted || draftJson() === savedDraft.current) return;
    const timer = window.setTimeout(() => {
      // One save at a time, so an older one never lands after a newer one.
      autosaving.current = (autosaving.current ?? Promise.resolve()).then(() => autosave(openDraftId));
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [
    openDraftId,
    openingDraft,
    busy,
    submitted,
    preset.id,
    title,
    caption,
    alt,
    tagsText,
    short,
    zhTitle,
    zhText,
    zhTopicsText,
    place,
    zhPlace,
    cover,
    chineseVideo,
    files,
  ]);
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
    // A hidden tab reads nothing, since every read counts against D1's daily cap, and catches up when it's shown.
    const poll = () => {
      if (!document.hidden) refresh().catch(() => setHelperOnline(false));
    };
    const timer = window.setInterval(poll, 10_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [access]);
  // A draft sent from the terminal shows its text and settings as soon as they arrive, then its videos follow.
  // Until they're in the composer stays locked, so it can't go out as a text post.
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
      let filled = false;
      try {
        const draft: Draft = await api(`drafts/${id}`);
        filled = true;
        setPendingDraft({ zhVideo: Boolean(draft.zh?.video), cover: Boolean(draft.cover) });
        setOpenDraftId(id);
        const active = draft.preset;
        if (active) setPreferences((p) => (p.presets.some((item) => item.id === active) ? { ...p, active } : p));
        // Edits this tab made before a reload that the draft didn't get in time win over its saved text.
        const edits = storedText.current?.draft === id && storedText.current.pending ? storedText.current : null;
        storedText.current = null;
        fillText(
          edits ?? {
            draft: id,
            title: draft.title,
            caption: draft.caption,
            alt: draft.alt,
            tags: draft.tagsText ?? draft.tags?.join(" ") ?? "",
            short: draft.short ?? "",
            zh: {
              title: draft.zh?.title ?? "",
              text: draft.zh?.text ?? "",
              topics: draft.zhTopicsText ?? draft.zh?.topics.join(" ") ?? "",
              location: draft.zh?.location ?? "",
            },
            location: draft.location ?? "",
          },
        );
        const videos = draft.zh?.video ? 2 : 1;
        const file = await storedFile(draft.video, draft.title, { video: 1, videos });
        const chinese = draft.zh?.video
          ? await storedFile(draft.zh.video, `${draft.title} (Chinese)`, { video: 2, videos })
          : undefined;
        const coverFile = draft.cover ? await storedFile(draft.cover, "cover.jpg") : undefined;
        const zhCoverFile = draft.zh?.cover ? await storedFile(draft.zh.cover, "cover-zh.jpg") : undefined;
        await showMedia([file], [""], [""]);
        setChineseVideo(chinese);
        setCover(coverFile && { file: coverFile, zh: zhCoverFile, at: draft.coverAt });
        draftId.current = id;
      } catch (e) {
        // Without its video the draft can't go out as written, so its text goes too, rather than wait to be sent as text.
        if (filled) {
          setTitle("");
          setCaption("");
          setAlt("");
          setTagsText("");
          setShort("");
          setZhTitle("");
          setZhText("");
          setZhTopicsText("");
          setPlace("");
          setZhPlace("");
          setOpenDraftId(null);
        }
        setError(e instanceof Error ? e.message : "Could not open this draft");
      } finally {
        storedText.current = null;
        setPendingDraft(undefined);
        setOpeningDraft(false);
        setDraftLoad(undefined);
        setBusy(false);
      }
    }
    void openDraft(id);
  }, [access]);
  // Photos and videos pasted anywhere on Compose attach like the buttons do, and text pasted outside any field goes
  // into the post. Read through a ref so the listener always sees what's attached now.
  const paste = useRef<(event: ClipboardEvent) => void>(undefined);
  paste.current = (event) => {
    if (tab !== "compose" || busy || submitted) return;
    const pasted = Array.from(event.clipboardData?.files ?? []);
    if (pasted.length) {
      event.preventDefault();
      void chooseFiles(pasted);
      return;
    }
    const text = event.clipboardData?.getData("text/plain");
    const post = document.getElementById("publisher-post");
    if (!text || !(post instanceof HTMLTextAreaElement)) return;
    if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) return;
    event.preventDefault();
    post.focus();
    // Inserted as typing, so it lands at the cursor and undo takes it back out.
    if (!document.execCommand("insertText", false, text)) {
      setCaption((current) => (current + text).slice(0, 5000));
      submission.current = null;
    }
  };
  useEffect(() => {
    if (access !== "owner") return;
    const listener = (event: ClipboardEvent) => paste.current?.(event);
    document.addEventListener("paste", listener);
    return () => document.removeEventListener("paste", listener);
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
      if (unplanned.length)
        throw new Error(
          when === "day"
            ? `Pick a day, or a time for ${unplanned.join(", ")}: none of its times are left that day.`
            : `${unplanned.join(", ")} has no free slot in the next two weeks. Pick a time for it.`,
        );
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
        schedule,
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
      setPostsVersion((v) => v + 1);
      // Uploads expire in a week; a small picture stays with the post for Analytics.
      const picture = cover?.file ?? files[0];
      if (picture)
        thumbnailOf(picture)
          .then((thumbnail) => saveThumbnail(pending.id, thumbnail))
          .catch(() => {});
      if (draftId.current) {
        const posted = draftId.current;
        // After any autosave on its way, which would put the draft back. If this delete is lost, the server still
        // refuses to queue the same video twice.
        (autosaving.current ?? Promise.resolve())
          .then(() => api(`drafts/${posted}`, undefined, "DELETE"))
          .catch(() => {})
          .finally(() => setDraftsVersion((v) => v + 1));
      }
      if (sentLocation) {
        const next = [sentLocation, ...recentPlaces.filter((recent) => recent !== sentLocation)].slice(0, 8);
        setRecentPlaces(next);
        try {
          localStorage.setItem(PLACES_KEY, JSON.stringify(next));
        } catch {
          // The place is still offered for this visit.
        }
      }
      clearComposer();
      setNotice(schedule ? "Post scheduled." : "Post queued.");
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
  /** Empties the composer for the next post, letting go of the draft it held. */
  function clearComposer() {
    if (draftId.current) {
      draftId.current = null;
      setOpenDraftId(null);
      window.history.replaceState(null, "", location.pathname);
    }
    savedDraft.current = "";
    setDraftStatus(undefined);
    clearMedia();
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
    // "When" stays, so the next post can follow this one; times set by hand were for this one.
    setOwnTimes({});
  }
  /** Changes one platform's posting times, which "Next free slot" and "On a day" follow. */
  function updatePostingTimes(platform: Platform, patch: Partial<Schedule[Platform]>) {
    setPostingTimes((times) => ({ ...times, [platform]: { ...times[platform], ...patch } }));
    submission.current = null;
  }
  /** Puts text back in the composer. An empty caption keeps the preset's, unless it's a draft's. */
  function fillText(text: StoredText) {
    const field = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
    setTitle(field(text.title, 100));
    if (text.caption || text.draft) setCaption(field(text.caption, 5000));
    setAlt(field(text.alt, 1000));
    setTagsText(field(text.tags, 1000));
    setShort(field(text.short, 1000));
    setZhTitle(field(text.zh?.title, 100));
    setZhText(field(text.zh?.text, 5000));
    setZhTopicsText(field(text.zh?.topics, 500));
    setPlace(field(text.location, MAX_LOCATION));
    setZhPlace(field(text.zh?.location, MAX_LOCATION));
  }
  /** Uploads a file once; a draft or the post that takes it again gets the same id. */
  function uploadMedia(file: File): Promise<string> {
    const stored = storedMedia.current.get(file);
    if (stored) return Promise.resolve(stored);
    let upload = uploads.current.get(file);
    if (!upload) {
      upload = (async () => {
        const response = await fetch("/api/publisher/media", {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Upload failed");
        storedMedia.current.set(file, result.id);
        return result.id as string;
      })();
      // A failed upload can be tried again.
      upload.catch(() => uploads.current.delete(file));
      uploads.current.set(file, upload);
    }
    return upload;
  }
  /** The composer as a draft, with `idOf` naming each upload. A draft is one video and its text. */
  function draftFields(idOf: (file: File) => string | undefined) {
    if (kind !== "video" || files.length !== 1) return null;
    const words = (text: string) =>
      parseTags(text)
        .filter((word) => word.length <= 100)
        .slice(0, 30);
    const zhVideo = chineseVideo && idOf(chineseVideo);
    const coverId = cover && idOf(cover.file);
    const zhCover = zhVideo && coverId && cover?.zh && idOf(cover.zh);
    return {
      video: idOf(files[0]),
      preset: preset.id,
      title,
      caption,
      alt,
      tags: words(tagsText),
      tagsText,
      short,
      zh: {
        title: zhTitle,
        text: zhText,
        topics: words(zhTopicsText),
        ...(zhVideo ? { video: zhVideo } : {}),
        ...(zhCover ? { cover: zhCover } : {}),
        ...(zhPlace.trim() ? { location: zhPlace.trim() } : {}),
      },
      zhTopicsText,
      ...(coverId ? { cover: coverId, ...(cover?.at !== undefined ? { coverAt: cover.at } : {}) } : {}),
      location: place.trim(),
    };
  }
  /** The open draft as the composer has it, with anything not uploaded yet marked, to tell whether it's saved. */
  function draftJson() {
    return JSON.stringify(draftFields((file) => storedMedia.current.get(file) ?? "unsaved"));
  }
  /** Saves the composer's edits to the open draft. A new cover goes up with them; a new video waits for Save. */
  async function autosave(id: string) {
    setDraftStatus("saving");
    try {
      if (cover) await uploadMedia(cover.file);
      if (cover?.zh && chineseVideo) await uploadMedia(cover.zh);
      const body = draftFields((file) => storedMedia.current.get(file));
      if (!body?.video || (chineseVideo && !body.zh.video)) {
        setDraftStatus(undefined);
        return;
      }
      const json = JSON.stringify(body);
      if (json !== savedDraft.current) await api(`drafts/${id}`, body, "PUT");
      if (draftId.current !== id) return;
      savedDraft.current = json;
      setDraftStatus("saved");
    } catch (e) {
      if (draftId.current === id) setDraftStatus({ failed: e instanceof Error ? e.message : "Could not save" });
    }
  }
  /** Saves the post as a draft, the open one or a new one, uploading what it needs, and starts a new post. */
  async function saveToDrafts() {
    setBusy(true);
    setSaving(true);
    setError("");
    setNotice("");
    try {
      // An autosave still on its way could land after this save and undo it.
      await autosaving.current;
      for (const file of [files[0], chineseVideo, cover?.file, chineseVideo && cover?.zh])
        if (file) await uploadMedia(file);
      const body = draftFields((file) => storedMedia.current.get(file));
      if (!body?.video) throw new Error("A draft is one video and its text.");
      const id = draftId.current;
      if (id) await api(`drafts/${id}`, body, "PUT");
      else await api("drafts", body);
      clearComposer();
      setDraftsVersion((v) => v + 1);
      setNotice("Saved to drafts.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the draft");
    } finally {
      setSaving(false);
      setBusy(false);
    }
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
  // The attachments decide the kind; the preset's destinations that can't take it are skipped. A draft is a video post
  // while its video is still coming down.
  const kind: PostKind = !files.length && pendingDraft ? "video" : postKind(files);
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
  // Photo descriptions go to Grain, Bluesky and Lens; Grain also shows when each photo was taken.
  const describedFor = destinations.filter((p) => p === "grain" || p === "bluesky" || p === "lens");
  const dated = destinations.includes("grain");
  const sentLocation = locationTargets.length ? place.trim() : "";
  // Xiaohongshu's Chinese version gets its own cover: the draft's, or its frame at the chosen moment.
  const sendsZhCover = Boolean(sentCover && sentChineseVideo && (sentCover.zh || sentCover.at !== undefined));
  const toYouTube = kind === "video" && destinations.includes("youtube");
  const canReframe = toYouTube && reframesToShort(video);
  const youtubeShort = canReframe && (shortChoice ?? preset.id === "short");
  const videoLabel = (p: Platform) => {
    if (p !== "youtube") return videoFormat(p, video);
    if (youtubeShort) return "Short";
    // Short-form video expects a Short; past three minutes YouTube keeps it a regular video.
    if (preset.id === "short" && video && video.seconds > 180) return "Video · over 3 minutes";
    return videoFormat(p, video);
  };
  const formatLabel = (p: Platform) => (kind === "video" ? videoLabel(p) : postFormat(p, kind, files.length));
  // A destination's toggle names what the post becomes there. One it can't take is dimmed, and when the preset wanted
  // it the limit it's over is said under the row, unless the attachments already say why; a mixed post's never do.
  const overLimit = platforms.filter(
    (p) => reasons[p] && preset.platforms.includes(p) && (support[p].includes(kind) || kind === "mixed"),
  );
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
  // A scheduled post's time on each destination: the owner's own, else the platform's next free slot or its first
  // time on the chosen day, at least ten minutes out.
  const earliest = Date.now() + 10 * 60_000;
  const plan =
    when === "now"
      ? []
      : destinations.map((platform) => ({
          platform,
          at:
            ownTimes[platform] ??
            (when === "next"
              ? nextSlot(postingTimes[platform], busyTimes[platform] ?? [], earliest)
              : slotOnDay(postingTimes[platform], day, earliest)),
        }));
  const unplanned = plan.filter(({ at }) => at === null).map(({ platform }) => platformNames[platform]);
  const schedule =
    when === "now" ? undefined : Object.fromEntries(plan.flatMap(({ platform, at }) => (at ? [[platform, at]] : [])));
  let publishLabel = `Publish to ${destinations.length} ${destinations.length === 1 ? "place" : "places"}`;
  const missingPlatforms = destinations.filter((platform) => !connectedPlatforms.includes(platform));
  if (!helperOnline || missingPlatforms.length) publishLabel = "Queue post";
  if (when !== "now")
    publishLabel = `Schedule for ${destinations.length} ${destinations.length === 1 ? "place" : "places"}`;
  if (submitted) publishLabel = "Retry queue request";
  if (busy && !openingDraft && !saving) publishLabel = "Uploading…";
  // An open draft says whether the owner's edits are in it yet.
  const newVideo = [files[0], chineseVideo].some((file) => file && !storedMedia.current.has(file));
  let draftNote = "";
  if (draftStatus === "saving") draftNote = "Saving draft…";
  if (draftStatus === "saved") draftNote = "Draft saved";
  if (typeof draftStatus === "object") draftNote = `Couldn't save the draft: ${draftStatus.failed}`;
  if (newVideo) draftNote = "Save draft to keep the new video";
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
          <ThemeToggle />
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
          <nav ref={tabsBar} className="publisher-tabs" aria-label="Publisher sections">
            <button aria-pressed={tab === "compose"} onClick={() => openTab("compose")}>
              Compose
            </button>
            <button aria-pressed={tab === "history"} onClick={() => openTab("history")}>
              History
            </button>
            <button aria-pressed={tab === "calendar"} onClick={() => openTab("calendar")}>
              Calendar
            </button>
            <button aria-pressed={tab === "analytics"} onClick={() => openTab("analytics")}>
              Analytics
            </button>
            <button aria-pressed={tab === "accounts"} onClick={() => openTab("accounts")}>
              Accounts
            </button>
          </nav>
          {tab === "history" && (
            <PublisherHistory
              request={api}
              onError={setError}
              composer={tabPath(base, "compose")}
              openDraft={openDraftId}
              draftsVersion={draftsVersion}
              postsVersion={postsVersion}
            />
          )}
          {tab === "analytics" && (
            <PublisherAnalytics
              request={api}
              online={helperOnline}
              search={address.search}
              onNavigate={(search, replace) => navigate(tabPath(base, "analytics"), search, replace)}
            />
          )}
          {tab === "calendar" && (
            <PublisherCalendar
              request={api}
              onError={setError}
              search={address.search}
              onNavigate={(search, replace) => navigate(tabPath(base, "calendar"), search, replace)}
              postsVersion={postsVersion}
            />
          )}
          {tab === "accounts" && (
            <>
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
                    Pair with <code>bun run publisher connect</code>
                  </p>
                )}
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
                    Pairing key · shown once · replaces the previous one
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
            </>
          )}
          <div hidden={tab !== "compose"}>
            <h1 className="publisher-hidden">New post</h1>
            <div className="publisher-compose">
              {/* Files can also be dropped anywhere on the composer, or pasted anywhere on Compose. */}
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
                  aria-label="Post"
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
                </div>
              )}
              <div className="publisher-destinations" role="group" aria-label="Share to">
                {platforms.map((p) => {
                  const format = !reasons[p] && formatLabel(p);
                  return (
                    <label key={p} data-unavailable={Boolean(reasons[p])} title={reasons[p] ?? undefined}>
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
                      <PlatformIcon platform={p} size={15} />
                      {platformNames[p]}
                      {format && (
                        <>
                          {" "}
                          <small>{format}</small>
                        </>
                      )}
                    </label>
                  );
                })}
                <div className="publisher-send-actions">
                  {kind === "video" && (
                    <button
                      type="button"
                      className="publisher-save"
                      disabled={busy || submitted || files.length !== 1}
                      onClick={saveToDrafts}
                    >
                      {saving ? "Saving…" : "Save draft"}
                    </button>
                  )}
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
                </div>
              </div>
              <div className="publisher-send-notes">
                {openDraftId && !openingDraft && draftNote && (
                  <p className="publisher-note" role="status">
                    {draftNote}
                  </p>
                )}
                {!destinations.length && (
                  <p className="publisher-note">None of the selected destinations take {unavailableFor[kind]}.</p>
                )}
                {overLimit.map((p) => (
                  <p key={p} className="publisher-note">
                    {platformNames[p]} {reasons[p]}.
                  </p>
                ))}
                {issues.map(({ platform, issue }) => (
                  <p key={platform} className="publisher-problem">
                    {platformNames[platform]}: {issue}
                  </p>
                ))}
                {!!missingPlatforms.length && (
                  <p className="publisher-note">
                    Waiting for {missingPlatforms.map((platform) => platformNames[platform]).join(", ")} sign-in.
                  </p>
                )}
              </div>
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
                  />
                </label>
              )}
              {kind === "photo" && !!describedFor.length && (
                <fieldset className="publisher-photo-details publisher-group">
                  <legend>
                    Photos<span className="publisher-for"> · {namesOf(describedFor)}</span>
                  </legend>
                  {files.map((file, index) => (
                    <div key={`${file.name}-${index}`} className="publisher-photo" data-dated={dated || undefined}>
                      <img src={previews[index]} alt="" />
                      <input
                        aria-label={`Description of ${file.name}`}
                        placeholder="Description"
                        value={alts[index] || ""}
                        maxLength={1000}
                        disabled={busy || submitted}
                        onChange={(event) => {
                          const value = event.target.value;
                          setAlts((list) => list.map((item, i) => (i === index ? value : item)));
                          submission.current = null;
                        }}
                      />
                      {dated && (
                        <input
                          type="datetime-local"
                          step="1"
                          aria-label={`Date taken for ${file.name}`}
                          title="Date taken"
                          disabled={busy || submitted || readingDates}
                          value={datesTaken[index] || ""}
                          onChange={(event) => {
                            const value = event.target.value;
                            setDatesTaken((dates) => dates.map((date, i) => (i === index ? value : date)));
                            submission.current = null;
                          }}
                        />
                      )}
                    </div>
                  ))}
                </fieldset>
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
                  disabled={busy || submitted}
                  onError={setError}
                />
              )}
              {kind === "video" && !files[0] && pendingDraft?.cover && !!coverTargets.length && (
                <fieldset className="publisher-cover publisher-group">
                  <legend>
                    Cover<span className="publisher-for"> · {namesOf(coverTargets)}</span>
                  </legend>
                  <p className="publisher-note">Loading the draft's cover…</p>
                </fieldset>
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
                  place={
                    locationTargets.includes("xiaohongshu") && (
                      <label>
                        Location
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
                      </label>
                    )
                  }
                >
                  {kind === "video" && (
                    <div className="publisher-zh-video">
                      {chineseVideo && (
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
                      )}
                      {!chineseVideo && pendingDraft?.zhVideo && (
                        <p className="publisher-note">Loading the Chinese version…</p>
                      )}
                      {!chineseVideo && !pendingDraft?.zhVideo && (
                        <MediaButton
                          accept="video/*"
                          label="Chinese version"
                          hint="The same video made for Chinese audiences, up to 90 MB"
                          Icon={VideoIcon}
                          disabled={busy || submitted}
                          onFiles={([file]) => file && chooseChineseVideo(file)}
                        />
                      )}
                    </div>
                  )}
                </PublisherChinese>
              )}
              <div className="publisher-options">
                <span id="publisher-presets" className="publisher-field-name">
                  Presets
                </span>
                <nav className="publisher-presets" aria-labelledby="publisher-presets">
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
                <label>
                  When
                  <select
                    value={when}
                    disabled={busy || submitted}
                    onChange={(e) => {
                      setWhen(e.target.value as typeof when);
                      // A day to start from: tomorrow.
                      if (e.target.value === "day" && !day) setDay(localInput(Date.now() + 86_400_000).slice(0, 10));
                      setOwnTimes({});
                      submission.current = null;
                    }}
                  >
                    <option value="now">Now</option>
                    <option value="next">Next free slot on each platform</option>
                    <option value="day">On a day</option>
                  </select>
                </label>
                {when === "day" && (
                  <label>
                    Day
                    <input
                      type="date"
                      value={day}
                      min={localInput(Date.now()).slice(0, 10)}
                      max={localInput(Date.now() + 6 * 86_400_000).slice(0, 10)}
                      disabled={busy || submitted}
                      onChange={(e) => {
                        setDay(e.target.value);
                        setOwnTimes({});
                        submission.current = null;
                      }}
                    />
                  </label>
                )}
                {!!plan.length && (
                  <fieldset className="publisher-schedule">
                    <legend>Publishes</legend>
                    {plan.map(({ platform, at }) => (
                      <label key={platform}>
                        {platformNames[platform]}
                        <input
                          type="datetime-local"
                          value={at ? localInput(at) : ""}
                          min={localInput(Date.now())}
                          max={localInput(Date.now() + 7 * 86_400_000)}
                          disabled={busy || submitted}
                          onChange={(e) => {
                            const time = new Date(e.target.value).getTime();
                            setOwnTimes((times) => ({
                              ...times,
                              [platform]: Number.isFinite(time) ? time : undefined,
                            }));
                            submission.current = null;
                          }}
                        />
                      </label>
                    ))}
                  </fieldset>
                )}
                {when !== "now" && !!destinations.length && (
                  <details>
                    <summary>Posting times</summary>
                    {destinations.map((platform) => {
                      const times = postingTimes[platform];
                      return (
                        <fieldset key={platform} className="publisher-posting-times">
                          <legend>{platformNames[platform]}</legend>
                          <label>
                            Times
                            <input
                              key={times.times.join()}
                              defaultValue={times.times.join(", ")}
                              onBlur={(e) => {
                                const parsed = parseTimes(e.target.value);
                                if (parsed) updatePostingTimes(platform, { times: parsed });
                                else {
                                  e.target.value = times.times.join(", ");
                                  setError(`Write ${platformNames[platform]}'s times as HH:MM, such as 9:00, 18:30.`);
                                }
                              }}
                            />
                          </label>
                          <label>
                            Hours apart
                            <input
                              type="number"
                              min={0}
                              max={168}
                              value={times.minGapHours}
                              onChange={(e) => {
                                const hours = Number(e.target.value);
                                if (Number.isFinite(hours) && hours >= 0 && hours <= 168)
                                  updatePostingTimes(platform, { minGapHours: hours });
                              }}
                            />
                          </label>
                          <label>
                            Per week
                            <input
                              type="number"
                              min={1}
                              max={50}
                              value={times.perWeek}
                              onChange={(e) => {
                                const count = Number(e.target.value);
                                if (Number.isInteger(count) && count >= 1 && count <= 50)
                                  updatePostingTimes(platform, { perWeek: count });
                              }}
                            />
                          </label>
                          <div className="publisher-days" role="group" aria-label={`${platformNames[platform]} days`}>
                            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((name, weekday) => (
                              <button
                                type="button"
                                key={name}
                                aria-pressed={times.days.includes(weekday)}
                                onClick={() =>
                                  updatePostingTimes(platform, {
                                    days: times.days.includes(weekday)
                                      ? times.days.filter((d) => d !== weekday)
                                      : [...times.days, weekday].sort(),
                                  })
                                }
                              >
                                {name}
                              </button>
                            ))}
                          </div>
                          <label>
                            Time zone
                            <input
                              key={times.timeZone}
                              defaultValue={times.timeZone}
                              placeholder="Yours"
                              onBlur={(e) => {
                                const zone = e.target.value.trim();
                                if (!zone || validTimeZone(zone)) updatePostingTimes(platform, { timeZone: zone });
                                else {
                                  e.target.value = times.timeZone;
                                  setError(`${zone} isn't a time zone. Use one like America/New_York.`);
                                }
                              }}
                            />
                          </label>
                        </fieldset>
                      );
                    })}
                    <div className="publisher-actions">
                      <button type="button" onClick={() => setPostingTimes(defaultSchedule())}>
                        Reset to defaults
                      </button>
                    </div>
                  </details>
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
                  {!!preset.platforms.length && (
                    <fieldset className="publisher-metadata">
                      <legend>Photo metadata</legend>
                      {preset.platforms.map((p) => (
                        <label key={p}>
                          {platformNames[p]}
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
                            <option value="remove-location">Remove location</option>
                            <option value="remove-all">Remove all</option>
                          </select>
                        </label>
                      ))}
                    </fieldset>
                  )}
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
              </div>
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
            </div>
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
