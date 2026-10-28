import type { ReactElement, ReactNode, SVGProps } from "react";
import { LuGithub } from "react-icons/lu";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  size?: number | string;
}

export type IconComponent = (props: IconProps) => ReactElement;

/**
 * The site's one icon set. Every mark sits on a 24-unit grid with a 2-unit
 * stroke, round caps and round joins; boxes round their corners at 5 (smaller
 * parts at 3 to 4), sharp tips are softened, and each mark fills the same
 * optical box: about 18 units square, or 20 by 15 when it is wide. Any two of
 * them can sit side by side without one looking heavier or larger.
 */
function icon(name: string, children: ReactNode) {
  function Icon({ size = "1em", ...props }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        {children}
      </svg>
    );
  }
  Icon.displayName = name;
  return Icon;
}

/* direction */

export const ChevronLeftIcon = icon("ChevronLeftIcon", <path d="M14.5 6l-6 6 6 6" />);
export const ChevronRightIcon = icon("ChevronRightIcon", <path d="M9.5 6l6 6-6 6" />);
export const ChevronUpIcon = icon("ChevronUpIcon", <path d="M6 14.5l6-6 6 6" />);
export const ChevronDownIcon = icon("ChevronDownIcon", <path d="M6 9.5l6 6 6-6" />);
export const ChevronsLeftIcon = icon("ChevronsLeftIcon", <path d="M11.5 7l-5 5 5 5M17.5 7l-5 5 5 5" />);
export const ChevronsRightIcon = icon("ChevronsRightIcon", <path d="M12.5 7l5 5-5 5M6.5 7l5 5-5 5" />);
export const ArrowLeftIcon = icon("ArrowLeftIcon", <path d="M19 12H5.5M11 6l-6 6 6 6" />);
export const ArrowUpRightIcon = icon("ArrowUpRightIcon", <path d="M7 17L17 7M8.5 7H17v8.5" />);

/* actions */

export const CloseIcon = icon("CloseIcon", <path d="M6 6l12 12M18 6L6 18" />);
export const CheckIcon = icon("CheckIcon", <path d="M5 12.5l4.5 4.5L19 7.5" />);
export const PlusIcon = icon("PlusIcon", <path d="M12 5v14M5 12h14" />);
export const MinusIcon = icon("MinusIcon", <path d="M5 12h14" />);
export const MoreIcon = icon(
  "MoreIcon",
  <>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </>,
);
export const ExternalLinkIcon = icon(
  "ExternalLinkIcon",
  <path d="M19.5 13.5v3a4 4 0 0 1-4 4h-8a4 4 0 0 1-4-4v-8a4 4 0 0 1 4-4h3M15 3.5h5.5V9M20.5 3.5l-9 9" />,
);
export const DownloadIcon = icon(
  "DownloadIcon",
  <path d="M3.5 14.5v2a4 4 0 0 0 4 4h9a4 4 0 0 0 4-4v-2M7.5 10l4.5 4.5 4.5-4.5M12 14.5v-11" />,
);
export const MaximizeIcon = icon(
  "MaximizeIcon",
  <path d="M3.5 8.5V7A3.5 3.5 0 0 1 7 3.5h1.5M15.5 3.5H17A3.5 3.5 0 0 1 20.5 7v1.5M20.5 15.5V17a3.5 3.5 0 0 1-3.5 3.5h-1.5M8.5 20.5H7A3.5 3.5 0 0 1 3.5 17v-1.5" />,
);
export const MinimizeIcon = icon(
  "MinimizeIcon",
  <path d="M8.5 3.5v2a3 3 0 0 1-3 3h-2M20.5 8.5h-2a3 3 0 0 1-3-3v-2M15.5 20.5v-2a3 3 0 0 1 3-3h2M3.5 15.5h2a3 3 0 0 1 3 3v2" />,
);
export const TrashIcon = icon(
  "TrashIcon",
  <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10.5 11v5M13.5 11v5" />,
);
export const ArchiveIcon = icon(
  "ArchiveIcon",
  <>
    <rect x="2.5" y="3.5" width="19" height="5" rx="2" />
    <path d="M4.5 8.5v8a4 4 0 0 0 4 4h7a4 4 0 0 0 4-4v-8M10 12.5h4" />
  </>,
);
export const BellIcon = icon(
  "BellIcon",
  <path d="M6.2 9a5.8 5.8 0 0 1 11.6 0c0 4.4 1.3 6.6 2.3 7.6a.9.9 0 0 1-.6 1.6H4.5a.9.9 0 0 1-.6-1.6c1-1 2.3-3.2 2.3-7.6zM10 21a2.3 2.3 0 0 0 4 0" />,
);

/* social */

export const HeartIcon = icon(
  "HeartIcon",
  <path d="M12 20.2S3.5 15.4 3.5 9.4c0-2.8 2.1-4.9 4.7-4.9 1.6 0 3 .8 3.8 2.1.8-1.3 2.2-2.1 3.8-2.1 2.6 0 4.7 2.1 4.7 4.9 0 6-8.5 10.8-8.5 10.8z" />,
);
export const CommentIcon = icon("CommentIcon", <path d="M8.41 19.2A8.5 8.5 0 1 0 4.3 15.09L3.6 19.6q-.2 1 .8.7z" />);
export const RepeatIcon = icon(
  "RepeatIcon",
  <path d="M3.5 11.5V10a4 4 0 0 1 4-4h13M17 2.5L20.5 6 17 9.5M20.5 12.5V14a4 4 0 0 1-4 4h-13M7 21.5L3.5 18 7 14.5" />,
);

/* media */

export const PlayIcon = icon(
  "PlayIcon",
  // the triangle's centroid, not its box, sits on the middle line
  <path d="M7.25 5.4v13.2q0 2.4 2.02 1.1l9.96-6.4q2.02-1.3 0-2.6L9.27 4.3Q7.25 3 7.25 5.4z" />,
);
export const PauseIcon = icon(
  "PauseIcon",
  <>
    <rect x="6" y="4.5" width="4" height="15" rx="2" />
    <rect x="14" y="4.5" width="4" height="15" rx="2" />
  </>,
);
export const SkipForwardIcon = icon(
  "SkipForwardIcon",
  <path d="M5 7v10q0 2 1.64.85l6.72-4.7q1.64-1.15 0-2.3L6.64 6.15Q5 5 5 7zM19 5v14" />,
);
export const SkipBackIcon = icon(
  "SkipBackIcon",
  <path d="M19 7v10q0 2-1.64.85l-6.72-4.7q-1.64-1.15 0-2.3l6.72-4.7Q19 5 19 7zM5 5v14" />,
);
const speaker = <path d="M3.5 10.5A1.5 1.5 0 0 1 5 9h2.5L12 5v14l-4.5-4H5a1.5 1.5 0 0 1-1.5-1.5z" />;
export const VolumeMuteIcon = icon(
  "VolumeMuteIcon",
  <>
    {speaker}
    <path d="M16 9.5l5 5M21 9.5l-5 5" />
  </>,
);
export const VolumeLowIcon = icon(
  "VolumeLowIcon",
  <>
    {speaker}
    <path d="M15.5 9a4.2 4.2 0 0 1 0 6" />
  </>,
);
export const VolumeIcon = icon(
  "VolumeIcon",
  <>
    {speaker}
    <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18.5 6a8.5 8.5 0 0 1 0 12" />
  </>,
);
export const ImageIcon = icon(
  "ImageIcon",
  <>
    <rect x="3" y="3" width="18" height="18" rx="5" />
    <circle cx="9" cy="9" r="2" />
    <path d="M21 15l-3.6-3.6a2 2 0 0 0-2.8 0L8 21" />
  </>,
);
export const VideoIcon = icon(
  "VideoIcon",
  <>
    <rect x="2.5" y="6" width="13" height="12" rx="4" />
    <path d="M15.5 10.3l4.6-2.7a1.2 1.2 0 0 1 1.9 1v6.8a1.2 1.2 0 0 1-1.9 1l-4.6-2.7" />
  </>,
);

/* theme */

export const SunIcon = icon(
  "SunIcon",
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.64 5.64l1.41 1.41M16.95 16.95l1.41 1.41M5.64 18.36l1.41-1.41M16.95 7.05l1.41-1.41" />
  </>,
);
export const MoonIcon = icon("MoonIcon", <path d="M20.5 14.5A9 9 0 1 1 9.5 3.5a7 7 0 0 0 11 11z" />);

/* brands */

/** GitHub's cat is Lucide's outline, which already uses this stroke and these joins */
export function GithubIcon({ size = "1em", ...props }: IconProps) {
  return <LuGithub size={size} aria-hidden="true" {...(props as object)} />;
}
export const GitlabIcon = icon(
  "GitlabIcon",
  <path d="M12 20.5l-8.6-6.4q-.8-.6-.5-1.5l2.4-7.7q.3-.9.8 0l2.4 5.6h7l2.4-5.6q.5-.9.8 0l2.4 7.7q.3.9-.5 1.5z" />,
);
export const YoutubeIcon = icon(
  "YoutubeIcon",
  <>
    <rect x="2" y="4.5" width="20" height="15" rx="5" />
    <path d="M10 9v6l5-3z" />
  </>,
);
export const InstagramIcon = icon(
  "InstagramIcon",
  <>
    <rect x="3" y="3" width="18" height="18" rx="5" />
    <circle cx="12" cy="12" r="4" />
    <path d="M16.75 7.25h.01" />
  </>,
);
/** the note as one outline: a ring cut open at the top, so the notch beside the stem stays clear */
export const TiktokIcon = icon(
  "TiktokIcon",
  <path d="M12 14.5V4Q12 3 13 3H15Q16 3 16 4A4 4 0 0 0 20 8Q21 8 21 9V11Q21 12 20 12Q18 12 16 10V14.5A6.5 6.5 0 1 1 7 8.5Q8 8.08 8 9.1V12.5A2.5 2.5 0 1 0 12 14.5Z" />,
);
export const MailIcon = icon(
  "MailIcon",
  <>
    <rect x="2" y="4.5" width="20" height="15" rx="5" />
    <path d="M6.5 9l4.67 3.19q.83.56 1.66 0L17.5 9" />
  </>,
);
/** the X: its wide stroke as a soft-cornered band, crossed by the thin stroke in two pieces that meet the band */
export const XLogoIcon = icon(
  "XLogoIcon",
  <path d="M4.6 3h2.8Q9 3 9.89 4.33l10.22 15.34Q21 21 19.4 21h-2.8q-1.6 0-2.49-1.33L3.89 4.33Q3 3 4.6 3zM3.5 21l6.74-7.14M13.76 10.14L20.5 3" />,
);
/** one smooth outline, so the waists meet in clean notches rather than the cusps a stroked copy of the filled logo leaves */
export const BlueskyIcon = icon(
  "BlueskyIcon",
  <path d="M12 10.5C13.2 7.9 15.8 4.7 18.6 3.8C20.1 3.3 21.4 3.8 21.4 5.5C21.4 6.9 21.1 9.2 20.6 10.3C20 11.6 18.8 12.2 17.4 12.7C18.8 13.6 20.9 15.2 19.5 17.6C18.2 19.7 15 20.5 13.5 18C13 17.1 12.4 15.9 12 15C11.6 15.9 11 17.1 10.5 18C9 20.5 5.8 19.7 4.5 17.6C3.1 15.2 5.2 13.6 6.6 12.7C5.2 12.2 4 11.6 3.4 10.3C2.9 9.2 2.6 6.9 2.6 5.5C2.6 3.8 3.9 3.3 5.4 3.8C8.2 4.7 10.8 7.9 12 10.5Z" />,
);
export const EthereumIcon = icon(
  "EthereumIcon",
  <path d="M11.08 3.31Q12 2 12.92 3.31L18.08 10.69Q19 12 18.08 13.31L12.92 20.69Q12 22 11.08 20.69L5.92 13.31Q5 12 5.92 10.69ZM5.46 12L11.12 15.03Q12 15.5 12.88 15.03L18.54 12" />,
);
