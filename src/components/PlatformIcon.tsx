import {
  BlueskyIcon,
  FarcasterIcon,
  GrainIcon,
  InstagramIcon,
  LensIcon,
  TiktokIcon,
  XiaohongshuIcon,
  XLogoIcon,
  YoutubeIcon,
  type IconComponent,
} from "@/components/icons";
import type { Platform } from "@/lib/publisher/presets";

/** Each platform's mark, small enough for a day's cell or a toggle. */
const platformIcons: Record<Platform, IconComponent> = {
  grain: GrainIcon,
  instagram: InstagramIcon,
  bluesky: BlueskyIcon,
  twitter: XLogoIcon,
  farcaster: FarcasterIcon,
  lens: LensIcon,
  xiaohongshu: XiaohongshuIcon,
  youtube: YoutubeIcon,
  tiktok: TiktokIcon,
};
export default function PlatformIcon({ platform, size }: { platform: Platform; size: number }) {
  const Icon = platformIcons[platform];
  return <Icon size={size} />;
}
