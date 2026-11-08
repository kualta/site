import { useEffect, useMemo, useRef, useState } from "react";
import { frameAt } from "@/lib/publisher/frame";

/** The cover a video post goes out with, where the platform lets a post choose one. */
export interface Cover {
  file: File;
  /** The second it was taken at, so the Chinese version gets its own frame from the same moment. */
  at?: number;
  /** The Chinese version's frame, when it came ready-made with a draft. */
  zh?: File;
}
interface Props {
  video: File;
  value?: Cover;
  onChange: (cover?: Cover) => void;
  /** The destinations that use it, named. */
  platforms: string;
  disabled: boolean;
  onError: (message: string) => void;
}

const COVER_TYPES = ["image/jpeg", "image/png"];

/** Pick a frame of the video, or upload an image, as its cover. */
export default function PublisherCover({ video, value, onChange, platforms, disabled, onError }: Props) {
  const videoUrl = useMemo(() => URL.createObjectURL(video), [video]);
  const coverUrl = useMemo(() => value && URL.createObjectURL(value.file), [value]);
  useEffect(() => () => URL.revokeObjectURL(videoUrl), [videoUrl]);
  useEffect(
    () => () => {
      if (coverUrl) URL.revokeObjectURL(coverUrl);
    },
    [coverUrl],
  );
  const player = useRef<HTMLVideoElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [taking, setTaking] = useState(false);

  async function takeFrame() {
    setTaking(true);
    try {
      onChange({ file: await frameAt(video, time), at: time });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not take the frame");
    } finally {
      setTaking(false);
    }
  }
  function upload(file?: File) {
    if (!file) return;
    if (!COVER_TYPES.includes(file.type) || file.size > 30e6) return onError("A cover is a JPEG or PNG, up to 30 MB.");
    onChange({ file });
  }

  return (
    <fieldset className="publisher-cover publisher-group">
      <legend>
        Cover<span className="publisher-for"> · {platforms}</span>
      </legend>
      {value ? (
        <div className="publisher-cover-chosen">
          <img src={coverUrl} alt="The chosen cover" />
          <div>
            <p>{value.at === undefined ? "Uploaded image" : `Frame at ${value.at.toFixed(1)} s`}</p>
            <button type="button" disabled={disabled} onClick={() => onChange(undefined)}>
              Choose another
            </button>
          </div>
        </div>
      ) : (
        <>
          <video
            ref={player}
            src={videoUrl}
            muted
            playsInline
            preload="auto"
            onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
          />
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.04}
            value={time}
            disabled={disabled || !duration}
            aria-label="Frame to use as the cover"
            onChange={(event) => {
              const seconds = Number(event.target.value);
              setTime(seconds);
              if (player.current) player.current.currentTime = seconds;
            }}
          />
          <div className="publisher-actions">
            <button type="button" disabled={disabled || taking || !duration} onClick={() => void takeFrame()}>
              {taking ? "Taking the frame…" : `Use the frame at ${time.toFixed(1)} s`}
            </button>
            <input
              ref={picker}
              type="file"
              accept={COVER_TYPES.join(",")}
              hidden
              onChange={(event) => {
                const [file] = Array.from(event.target.files || []);
                event.target.value = "";
                upload(file);
              }}
            />
            <button type="button" disabled={disabled} onClick={() => picker.current?.click()}>
              Upload an image
            </button>
          </div>
        </>
      )}
    </fieldset>
  );
}
