import { useId, useRef, useState } from "react";
import { MoreIcon } from "@/components/icons";
import { blueskyPostUrl, sitePostUrl } from "@/lib/bluesky/urls";
import { usePopoverMenu } from "@/lib/popover-menu";

export default function PostLinkMenu({ uri }: { uri: string }) {
  const [notice, setNotice] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const open = usePopoverMenu(trigger, panel);

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
        <MoreIcon size={14} aria-hidden="true" />
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
