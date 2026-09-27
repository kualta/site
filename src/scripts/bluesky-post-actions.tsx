import { createRoot, type Root } from "react-dom/client";
import BlueskyPostActions from "@/components/BlueskyPostActions";

/** Custom elements connect for both SSR rows and HTML fetched by the live feed. */
class BlueskyPostActionsElement extends HTMLElement {
  private root?: Root;
  connectedCallback() {
    if (this.root) return;
    const uri = this.dataset.uri;
    if (!uri) return;
    this.root = createRoot(this);
    this.root.render(<BlueskyPostActions uri={uri} />);
  }
  disconnectedCallback() {
    // Moving a row within the feed should preserve its in-progress reply.
    queueMicrotask(() => {
      if (!this.isConnected) {
        this.root?.unmount();
        this.root = undefined;
      }
    });
  }
}
if (!customElements.get("bluesky-post-actions"))
  customElements.define("bluesky-post-actions", BlueskyPostActionsElement);
