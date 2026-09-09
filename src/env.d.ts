/// <reference types="astro/client" />

declare namespace Cloudflare {
  interface Env {
    ACTIVITY_CACHE?: import("@/lib/activity").ActivityCacheStore;
    GITHUB_ACTIVITY_TOKEN?: string;
    PLUNK_SECRET_KEY?: string;
    NEWSLETTER_DB?: import("@/lib/newsletter/types").NewsletterDB;
    NEWSLETTER_TOKEN_SECRET?: string;
    NEWSLETTER_ADMIN_SECRET?: string;
    NEWSLETTER_WEBHOOK_SECRET?: string;
    NEWSLETTER_ORIGIN?: string;
    PARAGRAPH_API_KEY?: string;
    PARAGRAPH_PUBLICATION_SLUG?: string;
  }
}

declare module "cloudflare:workers" {
  export const env: Cloudflare.Env;
}

// the adapter puts the Worker's ExecutionContext on locals, which is what lets
// a page hand work to `waitUntil` and answer before that work finishes
type CloudflareRuntime = import("@astrojs/cloudflare").Runtime;

declare namespace App {
  // biome-ignore lint/suspicious/noEmptyInterface: declaration merging needs an interface, not an alias
  interface Locals extends CloudflareRuntime {}
}

interface ImportMetaEnv {
  readonly PARAGRAPH_API_KEY?: string;
  readonly PARAGRAPH_PUBLICATION_SLUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
