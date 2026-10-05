import { useEffect, useId, useRef, useState } from "react";
import { FiMoreHorizontal } from "react-icons/fi";
import { blueskyPostUrl, sitePostUrl } from "@/lib/bluesky/urls";

export default function PostLinkMenu({ uri }: { uri: string }) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    const menu = panel.current;
    if (!menu) return;
    function position() {
      const button = trigger.current;
      if (!button || !menu) return;
      const rect = button.getBoundingClientRect();
      menu.style.right = `${Math.max(8, innerWidth - rect.right)}px`;
      menu.style.top = `${rect.bottom + 4}px`;
      if (menu.matches(":popover-open")) {
        const height = menu.getBoundingClientRect().height;
        menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - height - 8))}px`;
      }
    }
    const toggle = (event: Event) => {
      const visible = (event as ToggleEvent).newState === "open";
      setOpen(visible);
      if (visible) {
        position();
        window.addEventListener("scroll", position, { passive: true });
        window.addEventListener("resize", position, { passive: true });
      } else {
        window.removeEventListener("scroll", position);
        window.removeEventListener("resize", position);
      }
    };
    menu.addEventListener("beforetoggle", position);
    menu.addEventListener("toggle", toggle);
    return () => {
      menu.removeEventListener("beforetoggle", position);
      menu.removeEventListener("toggle", toggle);
      window.removeEventListener("scroll", position);
      window.removeEventListener("resize", position);
    };
  }, []);

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Link copied.");
      panel.current?.hidePopover();
      trigger.current?.focus();
    } catch {
      setNotice("Could not copy the link. Use the post link below.");
    }
  }

  return (
    <div className="post-link-menu">
      <button
        ref={trigger}
        type="button"
        aria-label="Post options"
        aria-expanded={open}
        aria-controls={id}
        popoverTarget={id}
        className="post-menu-trigger"
      >
        <FiMoreHorizontal size={14} aria-hidden="true" />
      </button>
      <div ref={panel} id={id} popover="auto" className="post-menu-panel" role="group" aria-label="Post links">
        <button type="button" onClick={() => void copy(sitePostUrl(uri))}>
          Copy kualta.dev link
        </button>
        <button type="button" onClick={() => void copy(blueskyPostUrl(uri))}>
          Copy Bluesky link
        </button>
        <a href={sitePostUrl(uri)}>Open this post</a>
      </div>
      <span className="sr-only" role="status">{notice}</span>
    </div>
  );
}
