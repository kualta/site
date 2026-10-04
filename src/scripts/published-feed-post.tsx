import { createRoot, type Root } from "react-dom/client";
import PublishedFeedPost from "@/components/PublishedFeedPost";
import { getPublishedFeedPost } from "@/lib/bluesky/published-feed";
class PublishedFeedPostElement extends HTMLElement {
  private root?: Root;
  connectedCallback() {
    const post = getPublishedFeedPost(this.dataset.uri ?? "");
    if (!post || this.root) return;
    this.root = createRoot(this);
    this.root.render(<PublishedFeedPost post={post} />);
  }
  disconnectedCallback() {
    queueMicrotask(() => {
      if (!this.isConnected) {
        this.root?.unmount();
        this.root = undefined;
      }
    });
  }
}
if (!customElements.get("published-feed-post")) customElements.define("published-feed-post", PublishedFeedPostElement);
