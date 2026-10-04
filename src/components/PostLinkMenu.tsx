import { useEffect, useId, useRef, useState } from "react";
import { FiMoreHorizontal } from "react-icons/fi";
import { blueskyPostUrl, sitePostUrl } from "@/lib/bluesky/urls";

export default function PostLinkMenu({ uri }: { uri: string }) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Link copied.");
      close();
    } catch {
      setNotice("Could not copy the link. Use the post link below.");
    }
  }
  return (
    <div
      ref={container}
      className="post-link-menu"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label="Post options"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="post-menu-trigger"
      >
        <FiMoreHorizontal size={22} aria-hidden="true" />
      </button>
      {open && (
        <div id={id} className="post-menu-panel" role="group" aria-label="Post links">
          <button type="button" onClick={() => void copy(sitePostUrl(uri))}>
            Copy kualta.dev link
          </button>
          <button type="button" onClick={() => void copy(blueskyPostUrl(uri))}>
            Copy Bluesky link
          </button>
          <a href={sitePostUrl(uri)}>Open this post</a>
        </div>
      )}
      <span className="sr-only" role="status">
        {notice}
      </span>
    </div>
  );
}
