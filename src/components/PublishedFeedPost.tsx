import { RichText } from "@atproto/api";
import { blueskyProfileUrl } from "@/lib/bluesky/urls";
import type { PublishedFeedPost as Post } from "@/lib/bluesky/published-feed";
import PostLinkMenu from "./PostLinkMenu";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/activity/presence";

export default function PublishedFeedPost({ post }: { post: Post }) {
  const text = new RichText({ text: post.record.text, facets: post.record.facets });
  return (
    <article data-post-uri={post.uri} className="rounded-xl bg-secondary p-4 dark:bg-dark-secondary">
      <div className="flex items-center justify-between gap-3">
        <a className="flex items-center gap-3" href={blueskyProfileUrl(post.author.did)}>
          {post.author.avatar && (
            <img src={post.author.avatar} alt="" width={40} height={40} className="rounded-full" />
          )}
          <span>
            <strong>{post.author.displayName || post.author.handle}</strong>
            <span className="block text-xs">@{post.author.handle}</span>
          </span>
        </a>
        <div className="flex shrink-0 items-center gap-1.5">
          <PostLinkMenu uri={post.uri} />
          <time
            dateTime={post.record.createdAt}
            title={formatAbsoluteTime(post.record.createdAt)}
            className="font-mono text-xs tabular-nums text-secondary-text"
            data-activity-relative-time
          >
            {formatRelativeTime(post.record.createdAt)}
          </time>
        </div>
      </div>
      <p className="my-3 whitespace-pre-wrap break-words">
        {[...text.segments()].map((part, i) => {
          const link = part.link?.uri;
          const href =
            link && /^https?:\/\//i.test(link)
              ? link
              : part.mention
                ? blueskyProfileUrl(part.mention.did)
                : part.tag
                  ? `https://bsky.app/hashtag/${encodeURIComponent(part.tag.tag)}`
                  : undefined;
          return href ? (
            <a key={i} href={href} className="underline" rel="noopener noreferrer" target="_blank">
              {part.text}
            </a>
          ) : (
            part.text
          );
        })}
      </p>
      {post.media.map((media) =>
        media.video ? (
          <video
            key={media.url}
            src={media.url}
            controls
            playsInline
            aria-label={media.alt || "Posted video"}
            className="w-full rounded-lg"
          />
        ) : (
          <img key={media.url} src={media.url} alt={media.alt} className="w-full rounded-lg" />
        ),
      )}
    </article>
  );
}
