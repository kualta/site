import { useEffect, useRef, useState } from "react";
import { ArrowUpRightIcon, CloseIcon, DownloadIcon } from "@/components/icons";
import {
  clipNumber,
  clock,
  type FilmManifest,
  type FilmOutput,
  filmLabel,
  filmOutputs,
  fileSize,
  fileUrl,
} from "@/lib/publisher/archive-view";
import type { PiecePost } from "@/lib/publisher/content";
import { type LedgerClip, type LedgerProject, lost, thumbUrl } from "@/lib/publisher/ledger";
import { platformNames } from "@/lib/publisher/presets";
import PlatformIcon from "./PlatformIcon";
import "@/styles/publisher-archive.css";

interface Props {
  /** The film, by its project's name (013-maybe-later). */
  name: string;
  /** What the ledger says of it, when it knows it. */
  project: LedgerProject | undefined;
  /** The ledger's clips it's cut from, by their keys. */
  clips: [string, LedgerClip][];
  /** The post it went out as, once a Pipeline piece made from it is posted, and what that post went out to. */
  job: string | undefined;
  post: PiecePost | undefined;
  statsHref: (job: string) => string;
  onClose: () => void;
  /** Opens a clip's player. */
  onClip: (key: string) => void;
}

type Read = { manifest: FilmManifest } | { absent: true } | { failed: string } | null;
/* A film's manifest, read once a page: a film isn't archived again once it's off the Mac. One not archived yet is
   asked about again each time its page opens. */
const read = new Map<string, FilmManifest>();
async function readManifest(name: string): Promise<Read> {
  const kept = read.get(name);
  if (kept) return { manifest: kept };
  const response = await fetch(`/api/publisher/archive/projects/${encodeURIComponent(name)}`);
  if (response.status === 404) return { absent: true };
  if (!response.ok) return { failed: `The archive answered ${response.status}` };
  const manifest = (await response.json()) as FilmManifest;
  read.set(name, manifest);
  return { manifest };
}

const date = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
/** When a clip was recorded, by the ledger's local time: "8 Nov, 12:22". */
const recordedAt = (local: string) =>
  `${new Date(`${local.slice(0, 10)}T12:00:00`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  })}, ${local.slice(11, 16)}`;

/** A video the film made, playing in place from the archive, with its size, its length once known, and a download. */
function Output({ output }: { output: FilmOutput }) {
  const [length, setLength] = useState<number | null>(null);
  const url = fileUrl(output.sha256, output.file);
  return (
    <figure className="publisher-project-output">
      <div className="publisher-project-screen">
        {/* biome-ignore lint/a11y/useMediaCaption: a film's subtitles are in its picture */}
        <video
          src={url}
          controls
          preload="metadata"
          playsInline
          aria-label={output.name}
          onLoadedMetadata={(event) => {
            const { duration } = event.currentTarget;
            if (Number.isFinite(duration)) setLength(duration);
          }}
        />
      </div>
      <figcaption>
        <span>
          {output.name}
          <small>
            {` · ${fileSize(output.size)}`}
            {length === null ? "" : ` · ${clock(length)}`}
          </small>
        </span>
        <a href={url} download={output.file} aria-label={`Download ${output.name}`}>
          <DownloadIcon size={14} />
          Download
        </a>
      </figcaption>
    </figure>
  );
}

/** A clip's small picture: from the archive, else its YouTube video's, else an empty frame the same size. */
function ClipThumb({ clip, record }: { clip: string; record: LedgerClip }) {
  const [failed, setFailed] = useState(false);
  const video = record.graded?.youtube?.video;
  let src: string | null = null;
  if (record.thumb) src = thumbUrl(clip, record.thumb);
  else if (video) src = `https://i.ytimg.com/vi/${encodeURIComponent(video)}/mqdefault.jpg`;
  return (
    <span className="publisher-project-thumb">
      {src && !failed && <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />}
    </span>
  );
}

/**
 * A film's page, opened from the footage table: what it made, from its manifest in the archive (its render and its
 * Chinese render, each playing in place and to download), the post it went out as, and the clips it's cut from, each
 * opening its player. A film still only on the Mac says so.
 */
export default function PublisherProject({ name, project, clips, job, post, statsHref, onClose, onClip }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<Read>(() => {
    const kept = read.get(name);
    return kept ? { manifest: kept } : null;
  });
  const [tries, setTries] = useState(0);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tries` asks again
  useEffect(() => {
    let active = true;
    readManifest(name)
      .catch((error: Error) => ({ failed: error.message }))
      .then((next) => {
        if (active) setState(next);
      });
    return () => {
      active = false;
    };
  }, [name, tries]);

  const manifest = state && "manifest" in state ? state.manifest : null;
  const outputs = manifest ? filmOutputs(name, manifest) : [];
  // Where the film is, under its name, and what stands in for its outputs while there are none to show.
  let where = "Reading…";
  let empty: string | null = "Reading…";
  if (manifest) {
    where = `Archived ${date(manifest.archivedAt)}${project?.local ? " · on the Mac" : ""}`;
    empty = outputs.length ? null : "No render archived";
  } else if (state && "absent" in state) {
    where = project?.local ? "On the Mac" : "Not archived";
    empty = project?.local ? "Not archived yet" : "Not in the archive";
  } else if (state && "failed" in state) {
    where = "Couldn't read the archive";
    empty = state.failed;
  }

  return (
    <dialog ref={dialog} className="publisher-project" aria-labelledby="publisher-project-title" onClose={onClose}>
      <div className="publisher-archive-player-head">
        <h2 id="publisher-project-title">
          {filmLabel(name)}
          <small>{where}</small>
        </h2>
        <button type="button" aria-label="Close" onClick={() => dialog.current?.close()}>
          <CloseIcon size={16} />
        </button>
      </div>
      <div className="publisher-project-body">
        <section className="publisher-project-outputs" aria-label="Outputs">
          {empty === null ? (
            outputs.map((output) => <Output key={output.file} output={output} />)
          ) : (
            <div className="publisher-project-empty">
              <p key={empty}>{empty}</p>
              {state && "failed" in state && (
                <button type="button" onClick={() => setTries((n) => n + 1)}>
                  Try again
                </button>
              )}
            </div>
          )}
        </section>
        <aside className="publisher-project-side">
          <section aria-labelledby="publisher-project-post">
            <div className="publisher-project-side-head">
              <h3 id="publisher-project-post">Post</h3>
              {job && (
                <a href={statsHref(job)}>
                  Analytics
                  <ArrowUpRightIcon size={14} />
                </a>
              )}
            </div>
            {post?.targets.length ? (
              <ul className="publisher-project-targets">
                {post.targets.map((target) => {
                  const label = (
                    <>
                      <PlatformIcon platform={target.platform} size={14} />
                      {platformNames[target.platform]}
                    </>
                  );
                  return (
                    <li key={target.id} data-deleted={target.deleted || undefined}>
                      {target.url ? (
                        <a href={target.url} target="_blank" rel="noreferrer">
                          {label}
                        </a>
                      ) : (
                        <span>{label}</span>
                      )}
                      {target.deleted && <small> · deleted</small>}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="publisher-note">{job ? "Not out anywhere" : "Not posted"}</p>
            )}
          </section>
          <section className="publisher-project-clips" aria-labelledby="publisher-project-clips">
            <h3 id="publisher-project-clips">
              Clips <span>{clips.length}</span>
            </h3>
            {clips.length ? (
              <ul>
                {clips.map(([key, record]) => (
                  <li key={key}>
                    <button
                      type="button"
                      disabled={lost(record)}
                      aria-label={`Play clip ${clipNumber(record.name)}`}
                      onClick={() => onClip(key)}
                    >
                      <ClipThumb clip={key} record={record} />
                      <b>{clipNumber(record.name)}</b>
                      <small>
                        {record.recorded ? recordedAt(record.recorded) : ""}
                        {record.duration ? ` · ${clock(record.duration)}` : ""}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="publisher-note">None in the ledger</p>
            )}
          </section>
        </aside>
      </div>
    </dialog>
  );
}
