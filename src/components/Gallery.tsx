import { useEffect, useRef, useState, type CSSProperties } from "react";
import { FiMinus, FiPlus, FiX, FiArrowUpRight, FiPlay, FiChevronLeft, FiChevronRight } from "react-icons/fi";
import type { GalleryPage, GalleryPost } from "@/lib/gallery";
import type { BlueskyMedia } from "@/lib/activity/bluesky-media";
import "@/styles/gallery.css";

function Video({ media }: { media: BlueskyMedia }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const video = ref.current!;
    let disposed = false;
    let destroy: (() => void) | undefined;
    import("hls.js")
      .then(({ default: Hls }) => {
        if (disposed) return;
        if (!Hls.isSupported()) {
          if (video.canPlayType("application/vnd.apple.mpegurl")) video.src = media.src;
          else setFailed(true);
          return;
        }
        const hls = new Hls();
        hls.loadSource(media.src);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) setFailed(true);
        });
        destroy = () => hls.destroy();
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      destroy?.();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [media.src]);
  return (
    <>
      <video
        ref={ref}
        controls
        playsInline
        preload="metadata"
        poster={media.thumbnail}
        aria-label={media.alt || "Bluesky video"}
        onError={() => setFailed(true)}
      />
      {failed && <p>Video unavailable. Open the post on Bluesky to watch.</p>}
    </>
  );
}

export default function Gallery() {
  const [posts, setPosts] = useState<GalleryPost[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(2);
  const [selected, setSelected] = useState<string>();
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const panel = useRef<HTMLElement>(null);
  const lastTile = useRef<HTMLButtonElement | null>(null);
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const items = posts.flatMap((post) =>
    post.media.map((media, index) => ({ id: `${post.uri}:${index}`, post, media })),
  );
  const selectedIndex = items.findIndex((item) => item.id === selected);
  const current = items[selectedIndex];

  async function load(next?: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(false);
    const abort = new AbortController();
    controller.current = abort;
    try {
      const response = await fetch(`/api/gallery.json${next ? `?cursor=${encodeURIComponent(next)}` : ""}`, {
        signal: abort.signal,
      });
      if (!response.ok) throw new Error("Gallery unavailable");
      const page: GalleryPage = await response.json();
      setPosts((previous) =>
        next ? [...previous, ...page.posts.filter((post) => !previous.some((p) => p.uri === post.uri))] : page.posts,
      );
      setCursor(page.cursor && page.cursor !== next ? page.cursor : undefined);
      setReady(true);
    } catch {
      if (!abort.signal.aborted) setError(true);
    } finally {
      inFlight.current = false;
      if (!abort.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem("gallery-zoom"));
      if (saved >= 1 && saved <= 5) setZoom(saved);
    } catch {}
    load();
    return () => controller.current?.abort();
  }, []);
  function changeZoom(value: number) {
    const next = Math.max(1, Math.min(5, value));
    setZoom(next);
    try {
      localStorage.setItem("gallery-zoom", String(next));
    } catch {}
  }
  function close() {
    setSelected(undefined);
    requestAnimationFrame(() => lastTile.current?.focus());
  }
  useEffect(() => {
    if (!selected) return;
    panel.current?.focus({ preventScroll: true });
  }, [selected]);
  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
      if (event.key === "Tab" && mobile) {
        const controls = panel.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), a[href], video[controls]",
        );
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, mobile]);

  return (
    <section className={`gallery ${current ? "has-selection" : ""}`} aria-label="Grain gallery">
      <header className="gallery-toolbar">
        <div>
          <h1>gallery</h1>
          <p>
            moments from{" "}
            <a href="https://grain.social/profile/kualta.dev" target="_blank" rel="noreferrer">
              Grain
            </a>
          </p>
        </div>
        <div className="gallery-zoom" role="group" aria-label="Grid zoom">
          <button aria-label="Smaller thumbnails" disabled={zoom === 1} onClick={() => changeZoom(zoom - 1)}>
            <FiMinus />
          </button>
          <input
            type="range"
            min="1"
            max="5"
            step="1"
            value={zoom}
            aria-label="Thumbnail size"
            aria-valuetext={`${zoom} of 5`}
            onChange={(event) => changeZoom(Number(event.target.value))}
          />
          <button aria-label="Larger thumbnails" disabled={zoom === 5} onClick={() => changeZoom(zoom + 1)}>
            <FiPlus />
          </button>
        </div>
      </header>
      <div className="gallery-layout">
        <div className="gallery-collection">
          <div
            className="gallery-grid"
            style={{ "--tile-size": `${[0, 90, 140, 200, 280, 400][zoom]}px` } as CSSProperties}
            aria-busy={loading}
          >
            {items.map(({ id, media, post }, index) => (
              <button
                className="gallery-tile"
                key={id}
                aria-label={`${media.kind === "video" ? "Watch" : "View"} ${
                  media.alt || `media from ${post.text.slice(0, 70) || "Grain gallery"}`
                }`}
                aria-pressed={id === selected}
                onClick={(event) => {
                  lastTile.current = event.currentTarget;
                  setSelected(id);
                }}
              >
                {media.thumbnail ? (
                  <img src={media.thumbnail} alt={media.alt} loading={index < 12 ? "eager" : "lazy"} decoding="async" />
                ) : (
                  <span>video</span>
                )}
                {media.kind === "video" && (
                  <span className="gallery-video-mark">
                    <FiPlay aria-hidden="true" />
                  </span>
                )}
              </button>
            ))}
            {!ready && loading && Array.from({ length: 18 }, (_, i) => <div key={i} className="gallery-placeholder" />)}
          </div>
          <div className="gallery-status" role="status">
            {error ? (
              <>
                <p>Couldn’t load the gallery.</p>
                <button onClick={() => load(cursor)}>Try again</button>
              </>
            ) : loading ? (
              <p>Loading moments…</p>
            ) : !items.length && ready ? (
              <p>No Grain photos yet.</p>
            ) : cursor ? (
              <button onClick={() => load(cursor)}>Load more</button>
            ) : ready ? (
              <p>You’re all caught up.</p>
            ) : null}
          </div>
        </div>
        {current && (
          <aside
            role={mobile ? "dialog" : undefined}
            aria-modal={mobile ? true : undefined}
            ref={panel}
            tabIndex={-1}
            className="gallery-detail"
            aria-label="Selected post"
          >
            <div className="gallery-detail-toolbar">
              <span>
                {selectedIndex + 1} / {items.length}
              </span>
              <div>
                <button
                  aria-label="Previous media"
                  disabled={selectedIndex === 0}
                  onClick={() => setSelected(items[selectedIndex - 1].id)}
                >
                  <FiChevronLeft />
                </button>
                <button
                  aria-label="Next media"
                  disabled={selectedIndex === items.length - 1}
                  onClick={() => setSelected(items[selectedIndex + 1].id)}
                >
                  <FiChevronRight />
                </button>
                <button aria-label="Close post" onClick={close}>
                  <FiX />
                </button>
              </div>
            </div>
            <div className="gallery-full-media" key={current.id}>
              {current.media.kind === "video" ? (
                <Video media={current.media} />
              ) : (
                <img src={current.media.src} alt={current.media.alt} />
              )}
            </div>
            <div className="gallery-post">
              <a
                className="gallery-author"
                href={`https://grain.social/profile/${current.post.handle}`}
                target="_blank"
                rel="noreferrer"
              >
                {current.post.author}
                <span>@{current.post.handle}</span>
              </a>
              <p className="gallery-post-text">{current.post.text}</p>
              <div className="gallery-post-footer">
                <time dateTime={current.post.date}>
                  {new Date(current.post.date).toLocaleDateString("en", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </time>
                <a href={current.post.url} target="_blank" rel="noreferrer">
                  View post <FiArrowUpRight />
                </a>
              </div>
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}
