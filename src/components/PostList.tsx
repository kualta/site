import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@flow-industries/ui/components/item";
import type { PostMetadata } from "@/lib/posts";
import { readingMinutes } from "@/lib/reading-time";

/**
 * Posts as a timetable: the year is written once, beside the first post of
 * that year, so the column reads as when the writing happened.
 */
export function PostList({ posts }: { posts: PostMetadata[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {posts.map((post, index) => {
        const year = post.date.slice(0, 4);
        const firstOfYear = index === 0 || posts[index - 1].date.slice(0, 4) !== year;
        return (
          <li
            key={post.filename}
            className={`grid grid-cols-[3.5rem_minmax(0,1fr)] items-start gap-2 ${firstOfYear && index > 0 ? "mt-5" : ""}`}
          >
            <span className="pt-3 font-mono text-xs text-muted-foreground tabular-nums">{firstOfYear && year}</span>
            <Item render={<a href={`/posts/${post.filename}`} />} className="-mx-3 w-auto min-w-0">
              <ItemContent className="min-w-0">
                <ItemTitle className="line-clamp-none text-base">{post.title}</ItemTitle>
                {post.description && <ItemDescription className="line-clamp-1">{post.description}</ItemDescription>}
              </ItemContent>
              {post.wordCount > 0 && (
                <ItemActions className="self-start pt-0.5 font-mono text-xs text-muted-foreground tabular-nums">
                  {readingMinutes(post.wordCount)} min
                </ItemActions>
              )}
            </Item>
          </li>
        );
      })}
    </ul>
  );
}
