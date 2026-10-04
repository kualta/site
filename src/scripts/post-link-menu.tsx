import { createRoot, type Root } from "react-dom/client";
import PostLinkMenu from "@/components/PostLinkMenu";
import { parsePostUri } from "@/lib/bluesky/urls";
class PostLinkMenuElement extends HTMLElement {
  private root?: Root;
  connectedCallback() {
    if (this.root || !parsePostUri(this.dataset.uri ?? "")) return;
    this.root = createRoot(this);
    this.root.render(<PostLinkMenu uri={this.dataset.uri!} />);
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
if (!customElements.get("post-link-menu")) customElements.define("post-link-menu", PostLinkMenuElement);
