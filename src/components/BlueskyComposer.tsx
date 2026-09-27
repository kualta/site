import { FiImage, FiVideo } from "react-icons/fi";
import ComposerMedia from "./ComposerMedia";
import { sanitizeAttachment, MAX_IMAGES, type ComposerAttachment } from "@/lib/bluesky/media";
import { blueskyProfileUrl } from "@/lib/bluesky/urls";
import {
  useState,
  useId,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
  type Ref,
} from "react";
import { RichText } from "@atproto/api";
import BlueskyLogin from "./BlueskyLogin";
import { signIn, getBlueskyAuthSnapshot, getBlueskyAuthServerSnapshot, subscribeBlueskyAuth } from "@/lib/bluesky/auth";

export default function BlueskyComposer({
  className = "mb-6",
  text,
  onChange,
  onSubmit,
  busy,
  label = "Your post",
  placeholder = "What's on your mind?",
  loginLabel = "Log in to post",
  submitLabel = "Post",
  textareaRef,
  context,
  children,
  mediaTextSuffix = "",
  images,
  onImagesChange,
}: {
  mediaTextSuffix?: string;
  images: ComposerAttachment[];
  onImagesChange: (images: ComposerAttachment[]) => void;
  className?: string;
  text: string;
  onChange: (text: string) => void;
  onSubmit: (event: FormEvent) => void;
  busy: boolean;
  label?: string;
  placeholder?: string;
  loginLabel?: string;
  submitLabel?: string;
  textareaRef?: Ref<HTMLTextAreaElement>;
  context?: ReactNode;
  children?: ReactNode;
}) {
  const auth = useSyncExternalStore(subscribeBlueskyAuth, getBlueskyAuthSnapshot, getBlueskyAuthServerSnapshot);
  const id = useId();
  const picker = useRef<HTMLInputElement>(null);
  const videoPicker = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);
  const [mediaError, setMediaError] = useState("");
  async function attach(files: File[]) {
    if (preparing || busy) return;
    if (
      [...images.map((image) => image.file), ...files].some((file) => file.type.startsWith("video/")) &&
      images.length + files.length > 1
    ) {
      setMediaError("Attach one video or up to ten images.");
      return;
    }
    if (images.length + files.length > MAX_IMAGES) {
      setMediaError("Attach up to ten images.");
      return;
    }
    setPreparing(true);
    setMediaError("");
    try {
      const prepared: ComposerAttachment[] = [];
      for (const file of files) prepared.push(await sanitizeAttachment(file));
      onImagesChange([...images, ...prepared]);
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : "Could not prepare images.");
    } finally {
      setPreparing(false);
    }
  }

  const input = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    const resize = () => {
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight}px`;
    };
    resize();
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) {
        width = element.clientWidth;
        resize();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, auth.agent]);
  const length = new RichText({
    text: text.trim() + (images.length ? `${text.trim() && mediaTextSuffix ? "\n\n" : ""}${mediaTextSuffix}` : ""),
  }).graphemeLength;
  const submitDisabled = busy || preparing || (length === 0 && images.length === 0) || length > 300;

  if (!auth.agent) {
    return (
      <div className={className}>
        <BlueskyLogin fullWidth label={loginLabel} />
      </div>
    );
  }

  return (
    <section className={`${className} rounded-xl bg-secondary p-4 dark:bg-dark-secondary`} aria-label={label}>
      <div className={`flex min-h-10 items-center gap-3 ${auth.agent ? "mb-4" : ""}`} aria-label="Post author">
        {auth.profile ? (
          <a
            className="flex min-w-0 items-center gap-3"
            href={blueskyProfileUrl(auth.profile.did)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {auth.profile.avatar ? (
              <img
                src={auth.profile.avatar}
                alt=""
                width={40}
                height={40}
                className="h-10 w-10 shrink-0 rounded-full object-cover"
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-bg dark:bg-dark-bg"
              >
                {(auth.profile.displayName || auth.profile.handle).slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold">
                {auth.profile.displayName || auth.profile.handle}
              </span>
              <span className="block truncate text-xs text-secondary-text">@{auth.profile.handle}</span>
            </span>
          </a>
        ) : (
          <BlueskyLogin fullWidth label={loginLabel} />
        )}
      </div>
      {auth.agent && context}
      {auth.agent && (
        <form
          id={`${id}-form`}
          onSubmit={(event) => {
            if (submitDisabled) event.preventDefault();
            else onSubmit(event);
          }}
          className="relative"
        >
          <label htmlFor={id} className="sr-only">
            {label}
          </label>
          <textarea
            id={id}
            ref={(element) => {
              input.current = element;
              if (typeof textareaRef === "function") textareaRef(element);
              else if (textareaRef) textareaRef.current = element;
            }}
            rows={1}
            placeholder={placeholder}
            value={text}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (!submitDisabled && !event.repeat) event.currentTarget.form?.requestSubmit();
            }}
            disabled={busy}
            aria-describedby={`${id}-count`}
            style={{ background: "transparent", color: "inherit" }}
            className="block w-full resize-none overflow-hidden rounded-lg border-0 p-3 pb-10 text-base leading-relaxed focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2"
          />
          <span
            id={`${id}-count`}
            className="pointer-events-none absolute bottom-3 right-5 text-xs tabular-nums text-secondary-text"
          >
            {length}/300
          </span>
        </form>
      )}
      {images.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          {images.map((image, index) => (
            <ComposerMedia
              key={image.file.name}
              image={image}
              disabled={busy || preparing}
              onRemove={() => onImagesChange(images.filter((_, i) => i !== index))}
              onChange={(alt) => onImagesChange(images.map((value, i) => (i === index ? { ...value, alt } : value)))}
            />
          ))}
        </div>
      )}
      {mediaError && (
        <p role="alert" className="mt-2 text-sm">
          {mediaError}
        </p>
      )}
      {auth.agent && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <input
              ref={picker}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                void attach(files);
              }}
            />
            <button
              type="button"
              aria-label="Attach images"
              title="Attach images"
              disabled={
                busy ||
                preparing ||
                images.length >= MAX_IMAGES ||
                images.some((image) => image.file.type.startsWith("video/"))
              }
              onClick={() => {
                if (!auth.canUploadMedia && auth.profile)
                  void signIn(auth.profile.handle).catch((error) => setMediaError(String(error)));
                else picker.current?.click();
              }}
              className="p-2 disabled:opacity-50"
            >
              <FiImage size={20} />
            </button>
            <input
              ref={videoPicker}
              type="file"
              accept="video/mp4,video/quicktime,video/webm"
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                void attach(files);
              }}
            />
            <button
              type="button"
              aria-label="Attach video"
              title="Attach video"
              disabled={busy || preparing || images.length > 0}
              onClick={() => {
                if (!auth.canUploadMedia && auth.profile)
                  void signIn(auth.profile.handle).catch((error) => setMediaError(String(error)));
                else videoPicker.current?.click();
              }}
              className="p-2 disabled:opacity-50"
            >
              <FiVideo size={20} />
            </button>
          </div>
          {preparing && (
            <span role="status" className="text-xs">
              Preparing media…
            </span>
          )}
          {auth.agent && (
            <button
              type="submit"
              form={`${id}-form`}
              disabled={submitDisabled}
              aria-keyshortcuts="Meta+Enter Control+Enter"
              className="rounded-lg bg-text text-bg dark:bg-dark-text dark:text-dark-bg px-4 py-2 text-sm hover:opacity-80 disabled:opacity-50"
            >
              {busy ? "Posting…" : submitLabel}
            </button>
          )}
        </div>
      )}
      {children}
    </section>
  );
}
