import type Hls from "hls.js";
import type { Fragment, Level } from "hls.js";

// Kept for the page session, as bsky.app does: later videos start from the measured
// bandwidth instead of hls.js's 500 kbps guess, and a picked quality carries over.
let bandwidthEstimate: number | undefined;
let preferredQuality: string | undefined;

function levelLabel(level: Level): string {
  // Bluesky labels portrait renditions by their short side too (720x1280 is 720p).
  const size = Math.min(level.width, level.height) || level.height;
  return size ? `${size}p` : `${Math.round(level.bitrate / 1000)} kbps`;
}

export function createVideoStream(HlsPlayer: typeof Hls, frame: HTMLElement): Hls {
  const quality = frame.querySelector<HTMLSelectElement>(".video-quality")!;
  const hls = new HlsPlayer({
    // -1 measures bandwidth with a discarded fragment before choosing the first level.
    // Without an estimate, hls.js assumes 500 kbps and starts at the lowest rendition.
    startLevel:
      bandwidthEstimate === undefined && preferredQuality === undefined ? -1 : HlsPlayer.DefaultConfig.startLevel,
  });
  if (bandwidthEstimate !== undefined) hls.bandwidthEstimate = bandwidthEstimate;
  hls.on(HlsPlayer.Events.FRAG_LOADED, () => {
    bandwidthEstimate = hls.bandwidthEstimate;
  });

  // Buffered frames keep their quality after an upswitch, so flush them once auto picks better.
  let lowQualityFragments: Fragment[] = [];
  hls.on(HlsPlayer.Events.FRAG_BUFFERED, (_event, { frag }) => {
    if (frag.level < hls.levels.length - 1) lowQualityFragments.push(frag);
  });
  hls.on(HlsPlayer.Events.FRAG_CHANGED, (_event, { frag }) => {
    if (!hls.autoLevelEnabled) return;
    const target = hls.nextAutoLevel;
    const kept: Fragment[] = [];
    for (const low of lowQualityFragments) {
      // The playing fragment cannot be replaced without a visible stall.
      if (low.level >= target || Math.abs(low.start - frag.start) < 0.1) {
        kept.push(low);
        continue;
      }
      hls.trigger(HlsPlayer.Events.BUFFER_FLUSHING, { startOffset: low.start, endOffset: low.end, type: "video" });
    }
    lowQualityFragments = kept;
  });

  hls.on(HlsPlayer.Events.MANIFEST_PARSED, () => {
    const options = hls.levels.map((level, index) => new Option(levelLabel(level), String(index)));
    quality.replaceChildren(new Option("Auto", "-1"), ...options.reverse());
    quality.hidden = hls.levels.length < 2;
    const preferred = hls.levels.findIndex((level) => levelLabel(level) === preferredQuality);
    if (preferred > -1) {
      hls.currentLevel = preferred;
      quality.value = String(preferred);
    }
  });
  hls.on(HlsPlayer.Events.LEVEL_SWITCHED, (_event, { level }) => {
    quality.options[0].text = hls.autoLevelEnabled ? `Auto (${levelLabel(hls.levels[level])})` : "Auto";
  });
  quality.addEventListener("change", () => {
    const index = Number(quality.value);
    preferredQuality = index < 0 ? undefined : levelLabel(hls.levels[index]);
    // A picked quality replaces the buffer at once; auto takes over from the next fragment.
    if (index < 0) hls.loadLevel = -1;
    else hls.currentLevel = index;
  });
  return hls;
}
