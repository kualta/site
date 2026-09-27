import { useEffect, useState } from "react";
import { FiX } from "react-icons/fi";
import type { ComposerAttachment } from "@/lib/bluesky/media";
export default function ComposerMedia({
  image,
  disabled,
  onChange,
  onRemove,
}: { image: ComposerAttachment; disabled: boolean; onChange: (alt: string) => void; onRemove: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const value = URL.createObjectURL(image.file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [image.file]);
  return (
    <div className="relative min-w-0">
      {image.file.type.startsWith("video/") ? (
        <video src={url} controls playsInline className="h-32 w-full rounded-lg" />
      ) : (
        <img src={url} alt={image.alt || "Attached image"} className="h-32 w-full rounded-lg object-cover" />
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        aria-label="Remove attachment"
        className="absolute right-1 top-1 rounded-full bg-secondary dark:bg-dark-secondary p-2"
      >
        <FiX />
      </button>
      <input
        aria-label="Media description"
        placeholder="Add description…"
        value={image.alt}
        maxLength={2000}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-lg bg-transparent p-2 text-sm"
      />
    </div>
  );
}
