import { useEffect, useRef, useState } from "react";
import { FolderIcon } from "@/components/icons";
import { revealOnMac } from "@/lib/publisher/archive-view";

interface Props {
  /** The clip, by its name without the extension, as the ledger keys it. */
  stem: string;
  /** Says what it does in words beside its icon, where there's room for them. */
  labelled?: boolean;
  disabled?: boolean;
}

/**
 * Open in Finder: the grade app on the Mac shows the clip's original, on the Mac or the camera's card, selected in a
 * Finder window. Where it can't (away from the Mac, or the clip isn't there), it says why beside the button for a few
 * seconds, over what's there, so nothing moves.
 */
export default function PublisherFinder({ stem, labelled = false, disabled = false }: Props) {
  const [why, setWhy] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function reveal() {
    window.clearTimeout(timer.current);
    setWhy(null);
    const failed = await revealOnMac(stem);
    setWhy(failed);
    if (failed) timer.current = window.setTimeout(() => setWhy(null), 4000);
  }
  return (
    <span className="publisher-finder">
      <button
        type="button"
        aria-label="Open in Finder"
        title={labelled ? undefined : "Open in Finder"}
        disabled={disabled}
        onClick={reveal}
      >
        <FolderIcon size={14} />
        {labelled && <span>Open in Finder</span>}
      </button>
      {why && (
        <span className="publisher-finder-note" role="status">
          {why}
        </span>
      )}
    </span>
  );
}
