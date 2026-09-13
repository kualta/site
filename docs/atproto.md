# Publishing articles to the Atmosphere

MDX in `src/content/posts` is the source of truth. The canonical URL remains
`https://kualta.dev/posts/<slug>/`. Standard.site records contain portable Markdown
(`at.markpub.markdown`) and plain text for readers that do not understand that format.
Images inside the article link back to the website. Cover thumbnails are uploaded
to the account's PDS as blobs.

## Publish

1. Write or edit an MDX article; keep `draft: true` while it is unfinished.
2. Run `bun run atproto:preview` to inspect the article list and record URIs.
3. Run `bun run build` and inspect `public/.well-known/site.standard.manifest.json`
   for the full exported content.
4. Merge the reviewed change into `master`. The deployment workflow builds and
   deploys the site, verifies the live snapshot and links, then syncs the records.

The GitHub Actions secret `ATP_APP_PASSWORD` must contain an app password for
`kualta.dev`. It is supplied only to the publishing step, never the Astro build or
Cloudflare runtime. The publisher resolves the current PDS from the account's DID.
`atproto.config.json` fixes the owner DID and canonical origin.

To retry a failed sync, rerun the deployment workflow. A deterministic record key
and conditional writes prevent duplicates, including when a write succeeded but
its response was lost. Unchanged records and covers are not written again. A PDS
failure leaves the website deployed and the workflow failed, rather than reporting
complete publication. `bun run atproto:verify` checks remote records without writes
or credentials.

Publication verification is served at `/.well-known/site.standard.publication`.
Each article's head contains its `site.standard.document` link. The generated
`/.well-known/site.standard.manifest.json` is public and contains only public articles.
Do not edit generated files or change the URI derivation after publishing.

Use lowercase kebab-case filenames matching the article slug. Renaming an article
or making a published article a draft needs an explicit AT record removal/migration;
the sync stops and lists the old URIs instead of deleting records automatically.
This workflow does not send newsletter emails or create Bluesky announcement posts.
Discovery and full Markdown rendering depend on each reader's indexing and format support.

## Interactive MDX

Use the `Interactive` wrapper and give it one static Markdown fallback:

```mdx
import Interactive from "@/components/Interactive.astro";
import Simulation from "@/components/Simulation.tsx";

<Interactive>
  <Simulation client:load />
  <div slot="fallback">

At the default settings, the simulation produces **42**.

![Static simulation result](/images/simulation-result.png)

  </div>
</Interactive>
```

The website renders the interactive content and a collapsible text version. The
export contains the fallback plus a link back to the interactive article. Keep
blank lines around Markdown inside the fallback. Imports are omitted; JavaScript
is never evaluated by the exporter. Other JSX and dynamic expressions fail the
export with an actionable error, preventing silent loss of article content.

Run `bun test scripts/lib/atproto.test.mjs` for export, verification, retry and
update coverage. The fixture in `scripts/fixtures/interactive.mdx` exercises the
same wrapper used by authors.

## Why a direct integration

Sequoia CLI 0.5.7 was evaluated from its npm package. It exports only a stripped
`textContent` field (dropping code blocks and images), offers no rich-content
export hook, and continues with empty state if automatic PDS recovery fails.
Supporting faithful MDX fallbacks and reliable retries would require replacing
those parts. This integration uses the official AT Protocol SDK and vendored
Standard.site schemas instead.

References: https://standard.site/docs/quick-start/,
https://standard.site/docs/verification/, https://markpub.at/,
https://sequoia.pub/llms-full.txt.
