/// <reference types="astro/client" />

type Runtime = import("@astrojs/cloudflare").Runtime<{
  PARAGRAPH_API_KEY?: string;
  PARAGRAPH_PUBLICATION_SLUG?: string;
}>;

declare namespace App {
  interface Locals extends Runtime {}
}

interface ImportMetaEnv {
  readonly PARAGRAPH_API_KEY?: string;
  readonly PARAGRAPH_PUBLICATION_SLUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
