import { sitePostPath } from "@/lib/bluesky/urls";

/** Load visible cards only; connects for both initial HTML and live feed rows. */
class BlueskyPostThreadElement extends HTMLElement {
  private observer?: IntersectionObserver;
  private controller?: AbortController;
  private loaded = false;
  private html = "";
  private refresh = () => {
    if (this.loaded) void this.load();
  };

  connectedCallback() {
    window.addEventListener("bluesky:reply-published", this.refresh);
    if (this.loaded) return;
    this.observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        this.observer?.disconnect();
        void this.load();
      }
    });
    this.observer.observe(this.closest(".site-bluesky-card") ?? this);
  }
  disconnectedCallback() {
    queueMicrotask(() => {
      if (this.isConnected) return;
      this.observer?.disconnect();
      this.controller?.abort();
      window.removeEventListener("bluesky:reply-published", this.refresh);
    });
  }
  private async load() {
    const uri = this.dataset.uri;
    if (!uri) return;
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    try {
      const response = await fetch(`${sitePostPath(uri)}/thread`, { signal: controller.signal });
      if (!response.ok) return;
      const html = await response.text();
      if (!this.isConnected || controller.signal.aborted) return;
      // Keep focused menus and reply drafts when the same thread is read again.
      if (this.html !== html) {
        this.innerHTML = html;
        this.html = html;
      }
      this.loaded = true;
    } catch {
      // A thread failure must never hide the post or its existing conversation.
    }
  }
}
if (!customElements.get("bluesky-post-thread")) customElements.define("bluesky-post-thread", BlueskyPostThreadElement);
