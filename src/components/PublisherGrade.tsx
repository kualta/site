import { useEffect, useRef, useState } from "react";

/**
 * Where the grade app listens on the Mac. It stays a local app: the frame loads it from there, so it reads the card and
 * ~/Movies itself, previews on this browser's GPU and exports with ffmpeg on the Mac, as it does in a tab of its own.
 */
export const GRADE_APP = "http://127.0.0.1:4777";
/** How long the grade app gets to say it's there before the tab says it can't be reached. */
const PATIENCE = 8000;

interface Props {
  /** A clip to open, from the Footage tab; `n` tells the same clip asked for twice apart. */
  open: { clip: string; n: number } | null;
}

const theme = () => (document.documentElement.classList.contains("dark") ? "dark" : "light");

/**
 * The composer's Grade tab: the grade app on the Mac, in a frame. Chrome asks once to let post.kualta.dev reach this
 * device (the frame is allowed local network access). Away from the Mac, or until that's allowed, it says so.
 */
export default function PublisherGrade({ open }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "away">("loading");
  const [attempt, setAttempt] = useState(0);
  // The first clip asked for goes in the address; later ones by message, so the app isn't loaded again.
  const [src] = useState(() => `${GRADE_APP}/${open ? `#clip=${encodeURIComponent(open.clip)}` : ""}`);
  const post = (message: unknown) => frame.current?.contentWindow?.postMessage(message, GRADE_APP);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt is the trigger to wait again
  useEffect(() => {
    setState("loading");
    const hello = (event: MessageEvent) => {
      if (event.origin !== GRADE_APP || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type !== "grade-ready") return;
      setState("ready");
      post({ type: "theme", theme: theme() });
    };
    window.addEventListener("message", hello);
    const timer = window.setTimeout(() => setState((now) => (now === "ready" ? now : "away")), PATIENCE);
    return () => {
      window.removeEventListener("message", hello);
      clearTimeout(timer);
    };
  }, [attempt]);

  // The composer's light or dark, as it changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: post reads the frame itself
  useEffect(() => {
    if (state !== "ready") return;
    const observer = new MutationObserver(() => post({ type: "theme", theme: theme() }));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [state]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: post reads the frame itself
  useEffect(() => {
    if (state === "ready" && open) post({ type: "open", clip: open.clip });
  }, [open, state]);

  // The frame fills the window below the tabs.
  useEffect(() => {
    const fit = () => {
      const top = box.current?.getBoundingClientRect().top ?? 0;
      box.current?.style.setProperty("--grade-height", `${Math.max(480, window.innerHeight - top - 24)}px`);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  return (
    <section ref={box} className="publisher-grade" aria-label="Grade">
      {state === "away" && (
        <div className="publisher-grade-away" role="status">
          <p>The grade app runs on the Mac. Open this tab there, and allow local network access if Chrome asks.</p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}
      <iframe
        key={attempt}
        ref={frame}
        src={src}
        title="Grade app"
        allow="local-network-access; fullscreen"
        hidden={state === "away"}
      />
    </section>
  );
}
