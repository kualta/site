# Personal publisher

`post.kualta.dev` serves the private composer (`/publish` locally). The gallery
at `kualta.dev/gallery` reads `social.grain.gallery` and its photo records from
Grain's AppView, with KV caching. It does not fall back to Bluesky posts.

## Deploy prerequisites

1. Deploy the companion Flow Auth change admitting `https://post.kualta.dev`
   in both server audience and dialog origin lists. The website verifies Flow
   sessions server-side and admits only the non-guest username `kualta`.
2. Create the private R2 bucket: `bunx wrangler r2 bucket create kualta-publisher-media`.
   Do not enable public access. Set a seven-day expiration lifecycle rule for
   uploads (including abandoned uploads) in the Cloudflare dashboard.
3. Apply D1 migrations: `bunx wrangler d1 migrations apply NEWSLETTER_DB --remote`.
   Publisher tables are separate from existing newsletter tables.
4. Deploy the site after review. The existing `post.kualta.dev` Worker route
   now rewrites `/` to the composer rather than redirecting to the blog.
   An old browser-cached 301 may need clearing once.

No production resources, account credentials, or posts are created by building
or testing this branch. Local Flow login requires a local Auth stack configured
for the site's dev origin; production Flow ID deliberately refuses localhost.

For a local Auth stack, run its supported `./dev.sh` launcher. Start the site
with `FLOW_ID_HOST` set to the printed Landing origin and `FLOW_ID_API_URL` set
to the printed API origin. Defaults are `http://localhost:8063` and
`http://127.0.0.1:8060`. The local Auth audience allowlist must include the site's
exact origin (`http://127.0.0.1:4321`). Local accounts are separate from production;
these development settings never override the production publisher's issuer.
The Flow SDK 0.26.0 dependency patch uses manual redirects and rejects 3xx
responses: Cloudflare Workers does not implement `redirect: "error"`. Keep the
patch until the SDK includes this fix; the login regression test covers it.

## Laptop setup

Install Bun, Python 3, Google Chrome and ExifTool (`brew install exiftool`).
Run from this checkout:

```sh
bun install --frozen-lockfile
bun run publisher:setup
bun run publisher connect
bun run publisher start
```

In the composer, expand **Laptop connection**, generate a key, and paste it into
`publisher connect`. A new key revokes the previous one. Then use **Accounts** in
the composer to connect each destination. Instagram, X, YouTube, TikTok and
Xiaohongshu open an isolated Chrome window on your laptop. Sign in there, then
click **Finish sign-in** in the composer. Missing or expired sessions are not
marked connected; Cancel closes the pending connection. No terminal input is
needed for platform connections.

**Grain / Bluesky** opens the account's AT Protocol OAuth authorization page on
your laptop and connects both destinations automatically after approval. The
official Node OAuth client handles PKCE, DPoP and token refresh. The helper
checks kualta's DID and requests only creation of Bluesky posts and Grain gallery,
photo and gallery-item records, JPEG/MP4 uploads, and the uploadBlob service
authorization used for Bluesky video. No app password is requested.

OAuth tokens and signing keys stay in private laptop files. **Disconnect** revokes
the OAuth session and deletes the local tokens; other platforms remove their
local browser profiles. Connections expire after fifteen minutes; interactive
sign-in waits up to ten minutes. Connect one account at a time.

Keep the helper terminal running while posting. It polls Cloudflare. AT Protocol
OAuth returns to a loopback-only listener at `127.0.0.1:43827/oauth/callback`;
no public tunnel is needed. That port also ensures only one helper uses the
OAuth session at a time. Closing the laptop leaves queued work waiting.
Pairing checks the key before saving it. The paired helper can run before any
platform login, and picks up newly connected accounts without restarting. The
composer shows which selected destinations still need sign-in and labels the
action **Queue post** while those destinations or the laptop are unavailable.

`.publisher/` is gitignored and private (directory 0700, config 0600). It holds
the pairing key, OAuth tokens and platform sessions. It is the necessary local
exception to Cloudflare persistence for browser login. Presets, platform choices,
caption defaults, metadata policies and YouTube visibility live in this browser's
localStorage. Media and job history live in Cloudflare R2/D1. Neither Flow tokens
nor platform secrets are stored in localStorage. Uploads remain private but can
contain original metadata until the helper prepares each destination's copy.

## Publishing behavior

- Photos default to Instagram + Grain. Videos default to YouTube, Xiaohongshu,
  TikTok, X and Bluesky. Every compatible destination is toggleable. Duplicate a
  preset to create another; settings save immediately. Up to four photos or one
  video per post; uploads are bounded to 30 MB/photo and 90 MB/video.
- Photos are decoded into fresh pixels, oriented, and encoded as JPEG. The
  location-removal policy restores only camera/lens make/model and exposure
  settings. GPS, comments, timestamps, identifiers, thumbnails, XMP, IPTC and
  maker notes are never copied. X/XHS default to restoring nothing. Grain copies
  fit its 1 MB blob limit; other copies use a 1.9 MB budget. This is publishing,
  not an archival-original workflow.
- Videos are re-encoded as H.264/AAC MP4. Source metadata, chapters, ancillary
  tracks and H.264 SEI are removed for both policies. Required technical codec
  and container fields remain. Temporary local files are deleted after each
  destination. Bluesky video uses its official transcode service.
- X and Instagram reuse the MIT Crossposter browser adapters (vendored source,
  pinned commit and local changes are recorded under `scripts/publisher/vendor`).
  YouTube uses youtubei.js with the isolated signed-in profile's cookies.
  TikTok/XHS have browser-upload adapters. XHS upload selectors follow
  https://github.com/xpzouying/xiaohongshu-mcp (commit a5c8f77); its custom
  publish widget is checked for the disabled state before clicking. Browser layouts, login challenges and
  permissions can change; these adapters need acceptance with the owner's real
  accounts. TikTok's browser privacy setting remains the account's uploader
  setting; YouTube visibility is an explicit saved preset, initially Private.
- A destination is marked succeeded only with a confirmed post URL. Unclear
  results become `uncertain`; the helper never automatically repeats them.
  Verify on the destination before using **Retry this destination**. Successful
  destinations cannot be retried. Stalled claims become uncertain after one hour.
  Removing history deletes stored media/queue state, not published platform posts.

## Validation

`bun test`, `bun run check`, `bun run build`. Native metadata tests run when
ExifTool is installed; `scripts/publisher/process.test.ts` creates synthetic
GPS/comment-bearing photo/video fixtures. CI installs ExifTool for these tests.
Queue tests cover claim exclusivity, unsupported destinations and interrupted
work. Tests do not publish externally. Authenticated account acceptance remains
necessary before relying on the browser upload adapters.
