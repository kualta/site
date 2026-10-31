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
bun run publisher install
```

`install` registers the helper as a LaunchAgent (`dev.kualta.publisher`) that
starts at login and restarts if it exits, logging to `.publisher/helper.log`.
It records this checkout, the current Node binary and `PATH`; run it again after
moving either. `bun run publisher uninstall` removes it. `bun run publisher start`
runs the helper in the foreground instead; stop the background helper first, since
only one helper can hold the OAuth port.

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
photo and gallery-item records (creation and deletion), JPEG/MP4 uploads, and the uploadBlob service
authorization used for Bluesky video. No app password is requested.

OAuth tokens and signing keys stay in private laptop files. **Disconnect** revokes
the OAuth session and deletes the local tokens; other platforms remove their
local browser profiles. Connections expire after fifteen minutes; interactive
sign-in waits up to ten minutes. Connect one account at a time.

The helper posts whenever the laptop is awake and online. It polls Cloudflare. AT Protocol
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

- One composer takes text and, optionally, up to ten photos or one video. The
  attachments decide what the post is: text alone, photos, or a video.
- The **Share to** preset tabs are saved destination sets (Photo: Instagram + Grain;
  Long video: YouTube; Text post: Bluesky + X; Short-form video: YouTube,
  Xiaohongshu, TikTok, X and Bluesky). Switching presets preserves the title, text,
  attachments and their descriptions/dates; default captions apply when starting
  a fresh draft or after queueing. Custom presets and saved settings are retained. Each
  destination shows whether it can take the current post and why not: Grain needs
  photos, YouTube and TikTok need a video, Instagram and Xiaohongshu need media, X
  takes up to four photos, Bluesky takes videos up to three minutes. Selected
  destinations that can't take the post are skipped and return when the content
  changes.
- A title is asked for only when Grain, YouTube or Xiaohongshu is a destination.
  Links, mentions and hashtags become Bluesky facets. The counter follows the
  strictest text limit among the destinations (X 280, Bluesky 300, Xiaohongshu
  1,000, Instagram 2,200).
- Each photo has its own description for Grain and Bluesky; Bluesky shows more than
  four as a gallery. Duplicate a preset to create another; settings save
  immediately, and the title and text draft survives a reload. Uploads are bounded
  to 30 MB/photo and 90 MB/video. Run `node scripts/check-publisher.mjs` to exercise
  the composer in a browser.
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
- **Stop** in a post's Manage panel releases a queued or publishing destination at
  once, so the next one can start and it can be retried. The helper checks every
  5 seconds and ends the running attempt; if the post did go out, its confirmed
  link is still recorded, otherwise check the destination before retrying.
- When Instagram confirms a share without its link, the adapter finds the post on the
  profile grid. Shortcodes encode when a post was created, so a pinned or older post
  can't be mistaken for it. If it still can't be found, the destination stays on
  **Check platform**; **Mark as published** records a link pasted by the owner.
- YouTube makes any vertical or square upload of three minutes or less a Short.
  For a horizontal video in that range, **Post as a Short** (on by default under
  Short-form video) has the helper reframe YouTube's copy to 1080x1920: the whole
  picture over a blurred copy of itself. Other destinations keep the original frame.
  Crossposting from history doesn't offer this, so a horizontal video stays regular.
- X and Instagram reuse the MIT Crossposter browser adapters (vendored source,
  pinned commit and local changes are recorded under `scripts/publisher/vendor`).
  YouTube uses youtubei.js with the isolated signed-in profile's cookies.
  TikTok/XHS have browser-upload adapters. RedNote (international) accounts sign in
  on rednote.com, whose session does not open xiaohongshu.com; the helper checks and
  publishes on creator.rednote.com when the profile is signed in there, and links notes
  as www.rednote.com/explore/<id>. XHS upload selectors follow
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

## Drafts from the terminal

`bun run publisher draft <post.json>` sends a video and its text to the composer and
prints a link to it. The JSON holds `video` (relative to the file), `title`, `caption`,
`alt`, `tags`, `short`, `zh` and optionally `preset`. Opening the link fills in the
composer: the video, every field, and the preset (up to three minutes Short-form video,
otherwise Long video). Destinations and YouTube visibility stay whatever that preset has
saved in the browser.

A draft publishes nothing. It uses the laptop's pairing key to upload the video and store
the draft, and only **Publish** in the composer queues it. The link needs the owner's
sign-in like the rest of the composer. Queueing deletes the draft; if that delete is lost,
the server still refuses to queue the same video twice.

Text is checked before the upload as a post to every video destination, so a draft opens
ready whichever ones are selected, and it therefore needs a title and a Chinese version.
Videos over the 90 MB upload limit are re-encoded to fit. Drafts are small R2 objects
beside the media, and the bucket's seven-day lifecycle rule expires them together.

The `crosspost-video` skill in `.agents/skills` finds an OpenFilm film's final video and
writes the JSON. Link it in once: `ln -s ~/Projects/site/.agents/skills/crosspost-video ~/.claude/skills/`.

## Validation

`bun test`, `bun run check`, `bun run build`. Native metadata tests run when
ExifTool is installed; `scripts/publisher/process.test.ts` creates synthetic
GPS/comment-bearing photo/video fixtures. CI installs ExifTool for these tests.
Queue tests cover claim exclusivity, unsupported destinations and interrupted
work. Tests do not publish externally. Authenticated account acceptance remains
necessary before relying on the browser upload adapters.

## History and deleting publications

History shows posts sent through this app, with saved title/caption, photo/video previews,
links and outcomes for each destination. Older pages remain available after upload expiry;
previews become unavailable after the seven-day media retention window.

Delete removes one confirmed publication. Delete everywhere queues removal from every
confirmed destination on that history entry after publishing finishes. Both actions ask
for explicit confirmation and retain the history. Each destination reports its own deletion
outcome. A failed or unconfirmed deletion can be retried explicitly; interrupted operations
are never automatically replayed. These controls do not import or delete unrelated posts.

Restart the updated laptop helper to process deletions. Reconnect Grain / Bluesky once to
grant the new delete scopes; the helper uses a new OAuth session store for these permissions.
Grain removal deletes this job's gallery, photo and item records together. Bluesky removes
its exact post record. Browser destinations open the saved publication's delete controls
in their isolated signed-in profiles and require a platform success response. Changed UI,
missing owner controls or an unconfirmed response leaves a failure/review status rather
than claiming the post was removed. Real platform deletion acceptance remains owner-tested.

Apply `0005_publisher_deletions.sql` before deploying this version. Old helpers continue to
publish but cannot claim deletions until restarted with the updated code.

### Photo capture dates

When Grain is selected, each photo has an optional Date taken field. The browser reads only DateTimeOriginal and OffsetTimeOriginal from the original file before the helper strips metadata. Times display in the browser timezone; photos lacking an EXIF offset are interpreted in that timezone. Edit or clear each field before queueing. Missing dates stay blank; file modification time is never substituted.

Grain receives a separate social.grain.photo.exif record containing only the capture time, photo reference, and record creation time. Other destinations do not receive this field. History retains the chosen dates, and Grain deletion also removes the associated EXIF records. Restart the updated helper and reconnect Grain/Bluesky once for the additional OAuth collection permission.

### Browser sign-in

Xiaohongshu notes are deleted and measured in the creator center's note manager
(笔记管理): the helper finds the note's card by id, clicks its delete icon and
confirms, and reads views, likes, comments, saves and shares from the manager's
note list. A note's public page can't do either.

RedNote allows one web session per account: signing in to RedNote in another
browser signs the helper out, so reconnect Xiaohongshu afterwards (and the other
way round).

Chrome on macOS copies its ~1.4 GB app into a code-sign clone at each launch and
removes it only on a normal quit. The sign-in window disables that copy, and the
helper deletes clones that no running Chrome owns (matched by start time) at
startup and every ten minutes, so interrupted launches don't fill the disk.

Account connection launches installed Google Chrome directly with a dedicated publisher profile, without Playwright or remote debugging attached while you enter credentials. Finish sign-in in the app waits 31 seconds before closing that Chrome instance: Chrome writes cookies to disk about every 30 seconds and skips that write when the helper closes it, so a sign-in completed moments earlier would otherwise be lost. The helper then reopens the profile to check the saved platform session. Cancelling or timing out also closes only that instance. Restart the helper after updating to use this flow.

This removes the automated login browser from the sign-in step. It does not bypass provider account checks or guarantee automated publishing is accepted. The ordinary personal Chrome profile is never copied, read, or terminated.

Chrome session checks, browser publishing, and deletion use the native OS credential store, matching the ordinary Chrome sign-in window. Playwright's mock-keychain/basic-password-store defaults are disabled for these dedicated profiles. The X/Instagram adapters default to installed Chrome and fail if it cannot launch, rather than silently switching to bundled Chromium with a different credential store. Restart the helper after this update; if an earlier connection check already discarded unreadable cookies, sign in once again.

### Analytics

The owner-only Analytics tab tracks publications made through this tool, including those published before analytics was enabled. It does not import unrelated platform posts or reconstruct counts from before the first observation. Select a post to compare platforms, inspect daily closing counts, and switch between 7/30/90-day or all-time charts. The underlying hourly observations remain in Cloudflare D1 after a publication is deleted.

Restart the updated laptop helper to enable collection. When no account connection, deletion, or publication is queued, it reads due metrics using public AT Protocol APIs or the saved browser sessions. Each destination is due about hourly; offline periods and busy helpers delay collection. Refresh metrics makes eligible destinations due immediately, limited to once every five minutes. Five-minute leases make interrupted reads retryable; claim-bound receipts are idempotent. Failed reads preserve the previous snapshot and show an error and its observation time. Deleted destinations stop refreshing.

The combined figure adds each destination's latest **impressions, or views when impressions are absent**, never both. It is not deduplicated audience reach. Coverage and timestamps identify partial or stale totals. Unsupported and hidden metrics remain unavailable, while a reported zero remains zero. The chart carries forward the most recent observed count for each reporting destination and uses UTC daily closing samples; platform coverage can change over time.

Collector coverage:
- Bluesky: likes, replies, reposts from the public post API; no views/reach field.
- Grain: gallery favorites and comments from `social.grain.unspecced.getGallery`; no views/reach field.
- YouTube: video views and likes through the existing YouTube client.
- X/Twitter and TikTok: exact-post views and available engagement counters from the saved-session page's structured data.
- Instagram and Xiaohongshu: exact-post available engagement and view counters; photo reach/owner-only insights may be unavailable.

Browser metrics rely on provider response shapes and still need real-account acceptance testing. Hidden counts, expired sessions, changed response formats, and platform challenges yield unavailable/error states, not invented numbers. Unique reach is never inferred from views. No credentials or response bodies are persisted in analytics; only numeric counts, target IDs, timestamps, and generic error messages are stored. Apply `0006_publisher_analytics.sql` before deploying.
