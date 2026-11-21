# Personal publisher

`post.kualta.dev` serves the private composer (`/publish` locally). The gallery
at `kualta.dev/gallery` reads `social.grain.gallery` and its photo records from
Grain's AppView, with KV caching. It does not fall back to Bluesky posts.

## Deploy prerequisites

1. Deploy the companion Flow Auth change admitting `https://post.kualta.dev`
   in both server audience and dialog origin lists. The website verifies Flow
   sessions server-side and admits only the non-guest username `kualta`.
2. Create the private R2 bucket: `bunx wrangler r2 bucket create kualta-publisher-media`.
   Do not enable public access. Set a 31-day expiration lifecycle rule for
   uploads (including abandoned uploads) in the Cloudflare dashboard.
   Then the archive bucket, private too and with no expiration rule:
   `bunx wrangler r2 bucket create kualta-archive --storage-class InfrequentAccess`.
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

On the **Accounts** tab (post.kualta.dev/accounts), expand **Laptop connection**,
generate a key, and paste it into `publisher connect`. A new key revokes the previous
one. Then connect each destination from the same tab. Instagram, X, YouTube, TikTok and
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

**Farcaster** adds a posting key to the account without a transaction or ETH: a
gasless `KEY_ADD`, which only the custody wallet can sign. The helper opens an isolated
Chrome window with no extensions and asks for that wallet's recovery phrase (Farcaster
app, Settings, Advanced), checks it opens the account's custody address, signs once and
closes. The phrase goes straight to the helper process and is never stored or sent. The
key can only add and remove casts, and lapses after 90 days without a post; the composer
then says to connect again. **Disconnect** has the key revoke itself, which needs no phrase.

**Lens** posts as an account manager with its own key rather than the account's wallet.
Connecting creates the key and shows its address in the composer. Add it at
https://hey.xyz/settings/manager with the owner's wallet; only executing transactions is
needed, so leave token transfers off. The helper connects once Lens lets the key log in.
If Lens doesn't sponsor a post, the key pays its gas, about 0.002 GHO a post, and the
post fails saying so until the key holds some GHO on Lens Chain. **Disconnect** forgets
the key here; only the owner's wallet can remove it from the account's managers, so do
that on the same Hey page too.

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
the pairing key, OAuth tokens, platform sessions and the Farcaster, Lens and Grove
keys (`*.key`). It is the necessary local
exception to Cloudflare persistence for browser login. Presets, platform choices,
caption defaults, metadata policies and YouTube visibility live in this browser's
localStorage. Media and job history live in Cloudflare R2/D1. Neither Flow tokens
nor platform secrets are stored in localStorage. Uploads remain private but can
contain original metadata until the helper prepares each destination's copy.

## Publishing behavior

- One composer takes text and, optionally, up to twenty photos and videos. The
  attachments decide what the post is: text alone, photos, a video, or photos and
  videos together.
- More than one photo is a carousel wherever the platform has one: up to 20 on Instagram
  (its web uploader silently drops any past 20, so the adapter refuses them), 18 on
  Xiaohongshu, 10 on YouTube and Bluesky (its gallery past four), 4 on X and Lens, 2 on
  Farcaster, and every one on Grain and TikTok (which takes 35). Each destination is
  labelled with what the post becomes there: **Reel**, **Short**, **Carousel**, **Post**,
  **Photo** or **Gallery**.
- **A video goes inside a carousel only when the owner says so.** A video attached with
  anything else isn't posted until **Post as one carousel** is ticked, and any change to
  the attachments clears it; removing the other media posts the video as a Reel or Short.
  The server refuses a mixed post without that choice, the helper refuses a video post
  carrying more than one file, and the Instagram adapter refuses a Reel of more than one
  file. Mixed posts go to Instagram, X, Farcaster (two items) and Lens (four); Bluesky,
  Xiaohongshu, YouTube and TikTok hold photos or one video, never both.
- The **Share to** preset tabs are saved destination sets (Photo: Instagram + Grain;
  Long video: YouTube; Text post: Bluesky + X; Short-form video: YouTube,
  Xiaohongshu, TikTok, X and Bluesky). Switching presets preserves the title, text,
  attachments and their descriptions/dates; default captions apply when starting
  a fresh draft or after queueing. Custom presets and saved settings are retained. Each
  destination shows whether it can take the current post. One that never takes this
  kind of post is dimmed, with the reason on hover; one over a limit says so: Grain needs
  photos, Instagram, Xiaohongshu, YouTube and TikTok need media, X and Lens take up to
  four photos, Farcaster two, Bluesky ten and videos up to three minutes. Selected
  destinations that can't take the post are skipped and return when the content
  changes.
- A title is asked for only when Grain, a YouTube video or Xiaohongshu is a destination;
  a YouTube post has none.
  Links, mentions and hashtags become Bluesky facets. The counter follows the
  strictest text limit among the destinations (X 280, Bluesky 300, Xiaohongshu
  1,000, Farcaster 1,024 bytes, Instagram 2,200). The short version goes to X, Bluesky
  and Farcaster. Mentions are published as plain text on Farcaster and Lens: a handle on
  one network can belong to someone else on another.
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
- **Chinese version**, in the Xiaohongshu section of a video post, attaches a second
  video made for Chinese audiences. Xiaohongshu publishes it in place of the post's
  video, and every other destination keeps the original. It has the same 90 MB limit, and
  goes when the post has no video left. Crossposting from history keeps a Chinese version
  the post already has, but can't add one. Restart the helper after updating, or
  Xiaohongshu publishes the original.
- **Cover**, under a video, picks the frame at a moment of the video or an uploaded JPEG
  or PNG. YouTube (as the thumbnail; accounts YouTube hasn't verified can't set one),
  TikTok, Instagram, Xiaohongshu and Lens use it; Bluesky, X and Farcaster pick their own
  frame. Xiaohongshu with a Chinese version gets that video's frame at the same moment.
  Each cover step is best effort: if a platform's page refuses it, the post still goes
  out with the platform's own cover and the result says so.
- **Location**, for Instagram and Xiaohongshu (TikTok's web uploader has none), names a
  place; each platform searches its own places and tags one only when it is called that,
  never a café nearby. Xiaohongshu lists places by their Chinese names, so its section
  takes its own **Location** under its title (e.g. 波哥大); without one it searches the location above.
  Recent places are offered in the field.
- TikTok gave no views to videos the helper uploaded from an automated browser, while the same
  upload by hand from ordinary Chrome got them. So TikTok's profile opens in Chrome driven
  without a trace (`scripts/publisher/stealth.mjs`): ordinary Chrome started as the sign-in
  window is, with only a debugging port at random and AutomationControlled off, and Patchright
  attached over it, so none of Playwright's switches, its Runtime.enable leak or a window-size,
  language or user-agent override reach TikTok. rebrowser's bot detector finds nothing on it.
  Its metrics load no TikTok page (see Analytics), so TikTok's scripts run in that profile only
  while publishing, and never headless.
- A newly signed-in profile gets TikTok's uploader tour ("Preview your video on your phone",
  **Got it**), whose overlay covers the caption until it's answered. The helper reads each
  step and takes its button (Escape if it has none) before the caption, the cover and **Post**.
- A TikTok hashtag links only when picked from the editor's list. The helper picks the tag
  itself as soon as TikTok lists it. After six seconds without it, once the list has settled,
  it picks the top suggestion that starts with it (#recipe gets #recipetok) and says so in
  the result. Searches the list offers ("#cookie recipe easy and quick") are never picked,
  and a tag with no such suggestion stays as typed, unlinked.
- After the upload the helper waits, up to 12 minutes, for TikTok's music check and its
  For You eligibility check ("Content check lite", about 10 minutes) to finish before
  **Post**, as a person would. If TikTok still asks **Continue to post?**, it answers
  **Post now**.
- The uploader also runs at a person's pace (`scripts/publisher/human.mjs`): uneven pauses
  between steps, the mouse travelling on curves to a spot inside each control, the video
  picked through **Select video** and its file picker, and the caption typed with uneven gaps.
  A video left unsaved by a stopped post is discarded first. `publishBrowser`'s `draft` option
  ends with **Save draft** instead of **Post**, confirmed by TikTok Studio's draft list, for
  the owner to post from the phone; the composer doesn't offer it yet.
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
- Photos go to TikTok through TikTok Studio's **Photos** tab (`upload?tab=photo`), all at
  once and in order, and link as `tiktok.com/@_/photo/<id>`. Photos go to YouTube as a
  post on the channel's **Posts** tab (`youtube.com/post/<id>`), uploaded through its
  composer; the helper waits for YouTube's image uploads before pressing Post. YouTube
  shows every post to everyone, so photos to YouTube need the preset's visibility set to
  Public, and are refused otherwise. YouTube posts are deleted from the post's own menu
  and confirmed by its page saying it's gone. Both flows were written against the live
  pages without posting; their first real post and deletion are the acceptance test.
- Photo posts to TikTok and YouTube and mixed posts to Farcaster and Lens are claimed only
  by a helper that says it publishes them: an older one would send the photos as video
  uploads and the mixed posts as text. Restart the helper after updating; until then
  those destinations wait in the queue.
- Farcaster and Lens are posted to directly, with no browser. Casts go to public
  Snapchain nodes (`haatz.quilibrium.com`, then `snap.farcaster.xyz`; Neynar's need a key)
  and count only once read back. Lens goes through its GraphQL API, handling whichever of
  sponsored, signless or self-funded it answers. Posts are public and hard to take back:
  Lens records each on chain, and every Farcaster node keeps casts until told to remove them.
- Farcaster has no media uploads, and Lens stores media by address, so both use copies on
  Grove, Lens's public storage (125 MB per file). A cast embeds a `kualta.dev/m/<key>.jpg`
  or `.m3u8` link, which redirects to Grove, because clients go by what a URL looks like.
  Video reaches Farcaster as HLS, cut from the prepared MP4 without re-encoding, because the
  Farcaster app is reported not to play MP4 in a cast; Lens gets the MP4 and a poster frame.
  A mixed post embeds each item in order on Farcaster, and on Lens leads with its first item
  and attaches the rest, each video with its own poster frame.
  That report and this playback are unconfirmed in the app itself until the first real post.
- A destination is marked succeeded only with a confirmed post URL. Unclear
  results become `uncertain`; the helper never automatically repeats them.
  Verify on the destination before using **Retry this destination**. Successful
  destinations cannot be retried. Stalled claims become uncertain after one hour.
  Removing history deletes stored media/queue state, not published platform posts.

## Drafts from the terminal

`bun run publisher draft <post.json>` sends a video and its text to the composer and
prints a link to it. The JSON holds `video` (relative to the file), `title`, `caption`,
`alt`, `tags`, `short`, `zh` and optionally `preset`, `location` and a cover: `coverAt` (a
second of the video, taken from the Chinese version too) or `cover` (an image path).
`zh.video` is an optional Chinese version, relative to the file too, and `zh.location`
the place's Chinese name for Xiaohongshu. Opening the link fills in the composer: every field
and the preset (up to three minutes Short-form video, otherwise Long video) as soon as the
draft is read, then the videos as they finish downloading. Until they arrive the composer stays
locked. Destinations and YouTube visibility stay whatever that preset has saved in the browser.

Drafts that haven't been published are listed at the top of History, newest first, with when
the bucket's lifecycle rule removes them. **Open** loads one into the composer.

A draft publishes nothing. It uses the laptop's pairing key to upload the video and store
the draft, and only **Publish** in the composer queues it. The link needs the owner's
sign-in like the rest of the composer. Queueing deletes the draft; if that delete is lost,
the server still refuses to queue the same video twice.

Text is checked before the upload as a post to every video destination, so a draft opens
ready whichever ones are selected, and it therefore needs a title and a Chinese version.
Videos over the 90 MB upload limit are re-encoded to fit. Drafts are small R2 objects
beside the media, and the bucket's 31-day lifecycle rule expires them together.

The `crosspost-video` skill in `.agents/skills` finds an OpenFilm film's final video and
writes the JSON. `openfilm-chinese` makes a film's Chinese version in the film's `zh/`
folder and renders it beside the original as `<name>-zh.mp4`, which `crosspost-video`
then sends as `zh.video`. Link each in once:
`ln -s ~/Projects/site/.agents/skills/<skill> ~/.claude/skills/`.

## Archive

The `kualta-archive` R2 bucket (binding `ARCHIVE`) keeps what the media bucket's 31-day rule
would lose. It's on R2's Infrequent Access class, which is cheap to keep and charges a little
for each read, and nothing in it expires. The media bucket's expiry rule covers every key, and
uploads are bare UUIDs, so the archive is a bucket of its own rather than a prefix there.

**A queued post's uploads.** Queueing a post, or giving it new uploads with **Upload again**,
copies its uploads to `media/<id>` once the answer has gone (`waitUntil`). A daily sweep at
03:17 UTC copies any that a post of the last 31 days is still missing. Once the media bucket
expires an upload, the publisher reads the archived copy in its place: retries, crossposts,
rescheduling and the helper's downloads carry on, and History doesn't offer **Upload again**
for it. Deleting a post deletes its copies. **Upload again** remains for posts queued before
the archive existed.

**Finished projects.** `bun run publisher archive <project folder>…` sends an OpenFilm project
(with its Chinese version in `zh/`) to the archive. Each file is stored once by its SHA-256 at
`blobs/<sha256>`, so footage several projects share, and the Chinese version's clones of it,
cost nothing more. A manifest at `projects/<name>/<time>.json` names every file with its size
and modified time, and every empty folder (git, which Studio's history is, needs some of its
folders even empty). The archive keeps it only once every file it names is there. Files up to
64 MiB go up whole, checked against their hash by R2, and larger ones in 64 MiB parts. The
Worker streams each one on to R2 without reading it, and copies a post's uploads to the archive
the same way. On Workers Free a request gets 10 ms of CPU, and reading a 64 MiB part took about
200 ms: an archive run that read its parts made Cloudflare answer other requests, the helper's
among them, with 503s (error 1102) on 2026-11-16. Studio's
`.film/cache` is left out, and once the manifest is kept, the command deletes it from the
laptop; `--keep-cache` keeps it. Archiving again sends only what changed.

`bun run publisher archives` lists what's archived, and `bun run publisher restore <name>
[folder] [--at <time>]` brings a project back, into `~/Movies/OpenFilm/Projects/<name>` unless
another empty folder is named. Each file is checked against its hash, files the project held
twice come back as clones, and file times are restored. `bun run publisher archive-media` runs
the uploads sweep now. All of it goes through the helper API on the laptop's pairing token.

**Cleaning up.** `bun run publisher cleanup <project folder>…` (or `--all`, every project in
`~/Movies/OpenFilm/Projects`) takes a film off the laptop once that loses nothing. It needs the
film to be out or set to go: the project's render `<name>.mp4` must be the video of a post with a
destination that succeeded or is queued, as a scheduled post waits. `helper/archive/posted` answers
that from the MD5 R2 keeps of each upload, which matches the render's because a draft sends it
unchanged (one re-encoded to fit 90 MB doesn't match). A film the publisher can't confirm is
kept; `--posted` vouches for one named film. Then the project is archived again (only changes go
up), each clip in `~/Movies/Exported` the project copied (by name) is deleted when the archive
holds its exact bytes, so a clip exported again since stays, and the project's folder goes.
`--dry-run` says what would go, without archiving or deleting.

## Footage archive

Every graded clip also goes up, unlisted, to a YouTube channel of its own: a second copy beside
the Cloudflare archive, re-encoded by YouTube but there to watch years on. Connect it as **YouTube
footage archive** in the composer's Accounts. It signs in with a Chrome profile of its own
(`.publisher/youtube-footage`): in that window, switch to the archive channel (or sign in with its
own account) before Finish. The helper keeps the channel the window is on, with the page id that
picks it among a Google account's channels, and refuses the channel the YouTube destination posts to.

The helper uploads only while the composer's **Footage** tab (post.kualta.dev/footage; its old
address, /archive, still opens it) is open, so the uploads never take the network unseen. The tab says it's open when it opens and every 30
seconds after, and says it closed when it's left (another tab, a reload, the window closed); a tab
that goes quiet without saying so counts as closed after 150 seconds. The helper asks every 10
seconds and, while the tab is open, sends it what's up every 5 seconds during an upload: the clip
going up with its progress, speed (over the last minute of parts) and time left, how long today's
remaining clips take at that speed, every graded clip with its state, and why uploads wait when they
do (a failure to wait out, the day's limit, an upload run from the terminal). Leaving the tab stops
the part in flight; it isn't a failure, and the upload resumes from where YouTube says it stopped
the next time the tab opens. If the site stops answering three times running the helper stops too,
since it can't tell whether the tab is still open. Both the open marker and the status are small
objects in the media bucket (`footage/watching`, `footage/status.json`), not D1 rows, so the polling
costs no D1 reads beyond the helper's sign-in check.

It puts up 10 clips a day by default (`bun run publisher footage --daily <clips>` changes it):
first the grade app's exports in `~/Movies/Exported` (only files `exports.json` records, unchanged
for two minutes), then graded clips the laptop has let go of, fetched from the archive's projects
(listed once each time the tab opens) and checked against their hash. A clip graded again goes up
again as a new video. Each goes in 16 MiB parts through YouTube's resumable upload, from where
YouTube says it stopped when a part fails, the helper restarts or the tab closes, titled by the
camera's clock (`2026-11-15 22:46:28 · clip 0313`) and described by its source and grade. A failure
stops the run and waits half an hour, then twice as long each time up to a day, which also waits out
YouTube's daily limit. What went up is in `.publisher/footage.json`; `bun run publisher footage`
sums it up, and `footage --now` runs a batch at once from the terminal, whether the tab is open or
not.

YouTube takes videos over 15 minutes only from a verified channel: verify the archive channel's
phone number at youtube.com/verify, or longer clips fail to process.

**The footage ledger.** The grade app (`scripts/grade`) keeps a record of every clip: when it was
recorded, its profile, its grade, and where its original (camera, Mac, Cloudflare) and graded copy
(Mac, Cloudflare, YouTube) are, read from the card, `~/Movies`, `.publisher/footage.json` and the
archive's projects. It sends the ledger whole to `ledger/footage.json` in the archive, and each
clip's thumbnail once to `ledger/thumbs/<clip>.jpg` (`PUT helper/archive/ledger` and
`ledger/thumbs/<clip>`, on the pairing token, streamed like the archive's files and stored on the
Standard class since they're rewritten). The Footage tab shows it under the uploads, read through
`GET footage/ledger` and `footage/thumbs/<clip>.jpg` (both streamed from the archive, pictures cached a
day): every clip by day, newest first, with its grade, ✓ or – for each copy, the clip going up to
YouTube with its share, and filters for clips at risk (no copy off the Mac and the card), not
graded, not on YouTube and not in Cloudflare. A clip's **Grade** opens it in the Grade tab.

**Grade tab.** post.kualta.dev/grade frames the grade app on the Mac (http://127.0.0.1:4777), so
grading stays local: it reads the card and `~/Movies`, previews on the browser's GPU and exports with
ffmpeg. The frame is allowed local network access (Chrome asks once to let post.kualta.dev reach
this device); away from the Mac, or until that's allowed, the tab says so. Once opened it stays
loaded while other tabs are shown, takes the composer's light or dark, and opens the clips Grade
asks for. See `scripts/grade/README.md`.

## Instagram stories

The helper keeps the stories posted on Instagram (`scripts/publisher/stories.mjs`), on start and then hourly when
nothing else is queued, if Instagram is connected.

**Saved on the laptop.** It opens the account's story archive (instagram.com/archive/stories) in the Instagram profile,
reads the replies the page fetches as it scrolls, and saves each new story to `~/Movies/Instagram Stories` as
`YYYY/MM/YYYY-MM-DD HH.MM.SS.mp4` (photo stories without music stay `.jpg`). The video Instagram serves has a music
sticker's song mixed into its sound. Each story is dated on the clock of the phone that posted it, from the UTC offset
Instagram keeps on it: in its name, its QuickTime or EXIF dates, and its file times, which Photos and Finder go by.
`index.json` lists each story with its song and its archive day, and remembers each day by its story count and latest
story, so a run loads the page once and reads only the days that changed. Instagram's "Save story to archive" must stay
on.

**Deleted on Instagram.** A saved story that has gone from its archive day, or whose day has gone from the archive, was
deleted there. It's marked `removed` in `index.json` and its post comes off Pinkleap (and so off the site); its file stays
on the laptop and in the Cloudflare archive. A day counts as gone only once the list of days was read to its end, and a
story the page shows under any day is never taken for deleted: Instagram cuts days by the laptop's time zone, so a trip
can move stories into new days. Stories saved before days were noted are placed by reading the archive whole once; one
found in no day is gone. A run that would mark more than half the saved stories (and more than five) marks none and
says so in the log, in case Instagram's page came back incomplete; it looks again next run.

**Archived to Cloudflare.** On start and after a run that saved or sent anything, the folder goes to the archive bucket
as the project `instagram-stories` (see Archive): only files the archive lacks go up. `bun run publisher restore
instagram-stories "<folder>"` brings it back.

**Sent to Pinkleap.** With Grain / Bluesky connected, every saved story that hasn't gone yet is posted to the Bluesky
account with no text, its photo or video (prepared as for any Bluesky post), and the hidden tag `pinkleapStory`, which
makes Pinkleap show it as a story. On Bluesky it's an ordinary post that stays on the profile, and nothing deletes it.
It's dated when it went up on Instagram, on the clock it was posted with (`2026-11-15T15:51:17.000-05:00`). Pinkleap
shows a story only while that date is under 24 hours old, so a story is up there exactly as long as on Instagram, and
older ones are past stories; Bluesky files a post at the earlier of its date and its arrival, so a backlog lands at its
own dates instead of on anyone's timeline. Stories posted in the same second are a millisecond apart: Bluesky's author
feed, which the site reads, shows only one of several posts sharing a time. A run sends the stories still up first, then
up to twelve older ones, oldest first, so a backlog goes over a few hours without holding the helper up. Bluesky takes
only so many videos a day; reaching that ends the run and the next one carries on. Its record key comes from the
story's id, so a run stopped after posting finds the post instead of posting it twice; `index.json` notes each post.

**On the site.** kualta.dev reads the account's media posts and keeps those tagged as stories (`pinkleapStory` or
Pinksky's `pinkskyStory`) out of /videos and the activity feed. They have their own page, kualta.dev/stories. Everyone
sees the stories still up (under a day old) there, as one ring with the account's picture. The Bluesky account sits in
the top-right corner as a round button, inside that corner's bracket and at the bell's inset: a log-in arrow before signing
in, the account's picture after, opening the site's Bluesky sign-in. Signed in as kualta, a calendar of every day with
stories follows, read page by page from Bluesky in the owner's browser and laid out like an Apple Photos library: every
day from the first with stories to the last is a square, oldest first and filling each row, a day with stories showing
the picture of its first story and opening its stories. It zooms like Photos too: a pinch on a trackpad or touch screen, Ctrl or ⌘ with the
wheel, the − and + buttons, or the - and + keys change how many squares fit a row, from 1 or 2 up to 40, each square
gliding to its new place and the one under the fingers keeping its height. The browser remembers the zoom. The bar above
stays in view, see-through, and names the month there, and the page opens on the newest days. While the days are read, blank squares with a faint sweeping sheen hold their place. Signing out takes the calendar away again. The data is public on Bluesky anyway; this only decides what the page shows. On /feed the same picture sits left of the
header. Its ring is colored while a story still up hasn't been watched in that browser, grey once all have, and gone
without one: Instagram's style in the brand's pink (`--primary`) and deeper pinks of its hue, the one place the site uses
color as decoration. That pink is a tint near white, so on the light page the ring ends on a deeper shade of it instead.
A focused ring draws its outline round the picture, not around the button and its caption. A ring or a calendar day opens a full-screen viewer like Instagram's, over the page dimmed and blurred,
the story growing out of what was pressed and shrinking back into it on closing. On a screen wider than 1000 px the
stories before and after wait at either side, small and dim, and clicking one goes to it; each step slides like a
carousel, the new story growing out of the side it waited on and the old one shrinking into the other (a phone, with no
room for them, slides the story in). A neighbour gets a new image whenever its story changes, since an image given a
new source keeps showing the old picture until the new one loads; the pictures two stories away are fetched ahead, and
one still loading stays hidden until it can fade in. The previous and next arrows keep to the edges of the screen.
Reduced motion turns all of this off. Inside it: a bar per story, photos for five seconds and videos for their length, tap
the right side for the next and the left third for the previous one, hold to pause, swipe down or Esc to close, and on
into the next, later day. Its header says when each story went up, as Instagram does: now, 12m or 5h within a day,
then its date (Jul 14, with the year when it isn't this one), and the exact time, on the clock it was posted with, on
hover. Each browser remembers which stories it has seen. Stories are grouped by the date written in the post, so a story
posted at 23:30 in Bogotá stays on that day.

**Loading.** The stories either side of the one up are loaded while it plays, a video's stream included (silent, a few
seconds ahead, not held to the size of a player it isn't in yet), and the one just left stays loaded, so a step either
way starts at once; anything further is let go. Pointing at, focusing or touching a ring or calendar day starts loading
the story it opens on. While the story up is still coming (a photo not loaded, a video without enough buffered to play
on) a thin line runs along its bottom; it waits 150 ms, so a quick load never shows it, and holds still with reduced
motion.

TikTok stories can't be sent: TikTok's posting API has none, and its web uploader isn't known to offer them.

## Validation

`bun test`, `bun run check`, `bun run build`. Native metadata tests run when
ExifTool is installed; `scripts/publisher/process.test.ts` creates synthetic
GPS/comment-bearing photo/video fixtures. CI installs ExifTool for these tests.
Queue tests cover claim exclusivity, unsupported destinations and interrupted
work. Tests do not publish externally. Authenticated account acceptance remains
necessary before relying on the browser upload adapters, and on Farcaster and Lens.

## Pipeline

The Pipeline tab, at post.kualta.dev/pipeline, tracks each piece of content from idea to post.
Its stages run **Idea**, **Script ready**, **Footage ready**, **Edit ready** and **Posted**. The
board takes the whole window, one column per stage with the piece that most recently reached it
at the top, and each column scrolls on its own. A phone shows one column at a time and swipes to
the next. Type a title under **New idea** to add one.

A posted piece's card is its post's picture: its kept thumbnail, cover, YouTube still or first
upload, whichever loads. Vertical for a video, 4:5 for photos, with the title, when it went out
and its views over the top. A piece without a picture shows its title and the start of its notes.

Drag a card to another column to change its stage; the columns that would take it are outlined.
Dragging a posted card out of Posted asks first, since it then lets go of its post. Clicking a
card opens it. A posted piece shows each platform's latest views, likes, comments and shares
first, each linked to the post there, with a total and a link to Analytics. Below are its title,
notes (script, shots, links) and stage, plus **Delete**, and **Compose** at Edit ready. Changing
the stage there works on a phone, where cards don't drag.

**Footage** names what the piece is made from: a film (an OpenFilm project the footage ledger knows,
on the Mac or archived) or, before there's a film, a shoot day. Until it's posted, its card then
says how that footage stands from the ledger: `014-walk · 24 clips · 18 graded · 3 at risk` (log
clips count toward graded; at risk is no copy off the Mac and the card). A film not in the ledger yet
says so. The links are one small document in the archive (`pipeline/footage-links.json`, read with
`GET footage/links` and set a piece at a time with `PUT footage/links/<piece>`), so pieces gained
them without a D1 column. The Footage tab names each clip's films, and links a film to its post's
numbers once a piece naming it is posted.

**Compose** opens the composer linked to that piece (`?content=<id>`), saving any edits first. The
composer's **Pipeline** field shows the link, and it can link any piece that isn't posted yet,
including from a draft. A draft saved from the composer keeps its link.

Every post queued from the composer lands in Posted, linked to it, in the same write that queues
it. A linked piece moves there, and a post linked to nothing gets a piece of its own, named as
History names it (its title, else its caption's first line). Moving a posted piece back to an
earlier stage drops its post. Cancelling the post before it goes out deletes a piece it made for
itself and moves a linked piece back to Edit ready. Pieces marked Posted by hand have no post.

Posted shows the latest 30. Pieces live in D1 (`publisher_content`, `0012_publisher_content.sql`).
The list brings each posted piece's post and each destination's latest counts in two more reads,
and the tab reads it when it opens, never on a timer. `0013_publisher_content_backfill.sql` put
every post that had gone out before the Pipeline existed into Posted, and
`0014_publisher_content_catch_up.sql` the posts queued after that and before queueing made pieces.
Each is named as History names it and dated by its first destination to finish.

## History and deleting publications

History, its own tab at post.kualta.dev/history, shows posts sent through this app, with
saved title/caption, photo/video previews, links and outcomes for each destination. Older
pages remain available after upload expiry; previews become unavailable after the 31-day
media retention window.

A post's uploads are archived when it's queued (see Archive), so its video doesn't expire. A
video post queued before the archive existed can still lose its video. Once it has, its
**Manage** panel offers **Upload again**: choose the
video (and the Chinese video, if Xiaohongshu needs it) and optionally a new cover, and the post
takes the new uploads in place of the expired ones. **Retry publishing** and **Crosspost to**
then work as before. Retry and crossposting check that the uploads a destination needs still
exist and say so when they don't.

Deleting from Farcaster or Lens removes the post but not its media: Grove answers "could
not find resource" when asked to delete recent uploads, so photos and videos stay at their
public addresses and the result says so. Each file is owned by this laptop's `grove.key` and
listed in `.publisher/grove/`, so they can be removed if Grove starts allowing it.

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

The owner-only Analytics tab, at `post.kualta.dev/analytics`, tracks publications made through this tool, including those published before analytics was enabled. It does not import unrelated platform posts or reconstruct counts from before the first observation. Its address holds everything it shows (`?post=…&platform=…&metric=…&period=7|90|all&chart=daily&type=…&before=…`, defaults left out), so a reload or a link opens the same view, and choosing a post or a page is a step Back undoes. The chips at the top choose which kinds of post are listed and counted, videos (carousels with a video included) and photos by default, with text posts left out until asked for; the period beside them applies to every chart. Each post shows its picture: its cover, else YouTube's still, else its first upload while that is kept. The chart at the top adds up every listed post's views and impressions, either as a running total or as what each day brought in, stacked by platform, with marks along its axis showing when videos that are still up went out; hovering a mark names the video and clicking opens it below. Marks use YouTube's thumbnail when the video is on YouTube. Views of deleted posts stay in the total, and a platform's first report counts everything it had so far. In the daily view, a day nothing was read rolls into the next, and a platform correcting its count shows below zero. Select a post to see its caption, compare platforms and inspect its counts over time. The chart stacks each platform's count in its own color under the total, with a key showing what each contributes, and shows hourly closing counts for the last three days and daily closing counts before that. The underlying hourly observations remain in Cloudflare D1 after a publication is deleted.

Restart the updated laptop helper to enable collection. When no account connection, deletion, or publication is queued, it reads due metrics using public AT Protocol APIs or the saved browser sessions. Each destination is due about hourly, without pressing anything; offline periods and busy helpers delay collection, and the tab's header shows when counts last updated. Refresh metrics makes eligible destinations due immediately, limited to once every five minutes, and shows each one being read until its result arrives. Five-minute leases make interrupted reads retryable; claim-bound receipts are idempotent. Failed reads preserve the previous snapshot and show an error and its observation time. Deleted destinations stop refreshing.

Under each views chart's key, **average watch time per view** shows how long each platform's viewers watched, for the platforms that show it to their creator: across the videos posted in the selected period at the top, and for the selected post below, where the table adds an Avg watch time column. It is each platform's own figure, never recomputed from views, and next to it is the share of the video that comes to; a looping short can pass 100%. Across several videos, each counts in proportion to its views. Platforms define a view and a play differently, so watch times compare within a platform better than across them. A destination's latest reading with a watch time stands until the next one, so a creator page that fails to load for an hour doesn't blank it.

The combined figure adds each destination's latest **impressions, or views when impressions are absent**, never both. It is not deduplicated audience reach. Coverage and timestamps identify partial or stale totals. Unsupported and hidden metrics remain unavailable, while a reported zero remains zero. The chart carries forward the most recent observed count for each reporting destination; platform coverage can change over time.

Collector coverage:
- Bluesky: likes, replies, reposts plus quotes, and bookmarks from the public post API; no views/reach field.
- Farcaster: likes, recasts and replies counted from a Snapchain node; no views/reach field.
- Lens: reactions, comments, reposts plus quotes, and bookmarks from the public API; no views/reach field.
- Grain: gallery favorites and comments from `social.grain.unspecced.getGallery`; no views/reach field.
- YouTube: views, likes and comments from a public read through the existing YouTube client. Signed-in replies leave out the like count, so the saved session is only the fallback for a video the public can't read. A video with views then opens its YouTube Studio analytics page in the saved session for its lifetime average view duration and length, which give Studio's average percentage viewed; headless Chrome is let in with `approve_browser_access=true`. Studio takes up to two days to process retention, and until its retention curve appears the video has no watch time. A failed Studio read leaves the public counts standing. A YouTube post has likes and replies from its public page, or the saved session's when that page can't be read; a rounded count such as 1.2K stays unknown.
- TikTok: views, likes, comments, shares and saves, and for a video with views TikTok Studio's real-time average watch time and the video's length, all from one `/aweme/v2/data/insight/` reply. It's asked with the saved session's cookies and Chrome's own user agent, read from the profile without loading any TikTok page, so TikTok's scripts never run in a headless copy of the publishing profile. The numbers match TikTok Studio, including a real 0 views for a video it hasn't distributed. TikTok averages watch time over plays, replays included; photo posts have none.
- X/Twitter: exact-post views and available engagement counters from the saved-session page's structured data. For an X video with views, the post's own reply names its video, and the video's page in X's account analytics (`/i/account_analytics/video/<id>`, part of Premium) gives its lifetime average watch time per start, autoplay included, and its length. Without Premium the post keeps its counts and has no watch time.
- Instagram: likes and comments from the post's page, and plays for videos from the owner's Reels tab, since the post's page leaves them out; photos have no view count. Instagram's web insights, and with them reel watch time, are only open to professional accounts, so there's no watch time.
- Xiaohongshu: views and engagement from the creator center's note list. For a video note with views, the note manager also asks the data center for its average watch time (`/api/galaxy/creator/datacenter/note/base`), signed by the page's own signer since no RedNote page asks for it. It answers -1 until the account has data access, and the note then has no watch time; when it fills, it covers up to the day before.

Browser metrics rely on provider response shapes and still need real-account acceptance testing. Hidden counts, expired sessions, changed response formats, and platform challenges yield unavailable/error states, not invented numbers. Unique reach is never inferred from views. No credentials or response bodies are persisted in analytics; only numeric counts, average watch times and video lengths in milliseconds, target IDs, timestamps, and generic error messages are stored. Apply `0006_publisher_analytics.sql` before deploying.

## Post records

Every post with a public copy up somewhere has one public record in the owner's own AT Protocol
repository (`did:plc:jhvnnnd3adml7t6anu3ay7ip`), of type `dev.kualta.post`
(`scripts/lexicons/dev.kualta.post.json`). The repository is the original record of what was
posted; each platform's copy is a syndication link on it.

| Field | Holds |
| --- | --- |
| `kind` | `text`, `photo`, `video` or `mixed` |
| `title` | the title, when a copy that is up shows one |
| `text` | the text as the fullest copy that is up shows it |
| `tags` | the tags the copies that are up carry, without `#` |
| `createdAt` | when the first copy went up |
| `thumbnail` | the post's stored thumbnail (JPEG, PNG or WebP, at most 200 KB) |
| `syndication` | one `{ platform, url, uri?, publishedAt? }` for each public copy that is up now |

`uri` is the copy's own record, for Bluesky and Grain. `platform` uses the publisher's own names
(`twitter` for X). `publishedAt` is left out for a copy linked from History or marked as published
by hand: the time kept for those is when that was done, and it doesn't count toward `createdAt`
either.

The record never shows what no copy that is up shows. The site decides this
(`src/lib/publisher/post-records.ts`), so nothing else reaches the laptop's record builder
(`buildPostRecord` in `scripts/publisher/post-record.mjs`), which takes each field by name:

- A YouTube copy is listed only when the post's YouTube visibility is Public. A private or
  unlisted video, sent or linked by hand, never appears, and a post whose only copy it is has no
  record at all.
- The words are the version a destination was sent (`variants`), not what the composer holds now.
  The fullest copy that is up speaks: Grain, Lens, YouTube, Instagram, TikTok, then Bluesky,
  Farcaster and X, which may have the short version, then Xiaohongshu's Chinese version when
  nothing else is up. Instagram, TikTok and YouTube show the tags at the end of the text, so they
  are in `text` there too. A post edited after a copy went out keeps that copy's words.
- `title` is there only when Grain, a YouTube video or Xiaohongshu is up: nothing else shows one,
  and a YouTube photo post has none.
- `tags` are the ones those versions carry: written in the text, or kept beside it on Bluesky and
  Lens, or Xiaohongshu's topics.
- A copy linked from History was written elsewhere, so it adds a link and no words. A post with
  only linked copies up has an empty `text` and no thumbnail.
- The thumbnail is left out when the only copies up carry another video (Xiaohongshu's Chinese
  one). For a post with a cover it may be the cover, so it goes only while a copy sent from here
  is up on a destination that shows the post's cover (YouTube, TikTok, Instagram, Xiaohongshu,
  Lens): a cover shown only on a private YouTube video stays out. The helper refuses to upload
  one that holds EXIF, XMP, IPTC or a comment.
- A link pasted by hand is reduced to the post's own address, without share parameters such as
  `?igsh=`, `?si=` or `xsec_token`.

It never holds capture dates, the tagged place, alt text, the uploads or their ids, the schedule,
metrics, failed, unconfirmed or deleted destinations, or anything about the helper and its
connections. A post with no public copy up reaches the helper as its id alone.

The record's key is a TID derived from the post's id (`recordKey("publisher:post:<id>")`, the
derivation articles use), so a post has exactly one record however often it is written. The helper
reconciles a post's record after a destination succeeds and after a deletion completes: it
creates the record with the first copy, updates it as copies come and go, and deletes it when no
public copy is left. A record that can't be written, or a repository that doesn't answer within
a minute, never changes a destination's result or holds the queue, since the post is already up;
the helper log says the record was not written and how to repair it.

`bun run publisher post-records [--job <post id>]` compares every post, or one, with the
repository and prints what it would create, update or delete. It reads the post list from the
site with the helper's pairing key and the records from the repository's public API, and writes
nothing. Add `--write` to do it. Each write is conditional on the version it read, the thumbnail
is uploaded only when the record doesn't already hold it, and a second run changes nothing, so
the same command is the backfill for posts from before records existed and the repair after a
failed write. It also picks up what the helper isn't told about: a post marked as published by
hand, a link added or removed in History, and edited words. Records in the collection that match
no post are listed and left alone.

`--write` uses the laptop's Bluesky sign-in, which only one process may hold: stop the helper
first (`bun run publisher uninstall`), run it, then `bun run publisher install`.

The sign-in must grant `repo:dev.kualta.post` and the thumbnail's blob types
(`src/lib/publisher/oauth-client.json`). A sign-in made before this was added doesn't, and the
helper and the command both say so once instead of writing. To turn records on, in this order:

1. Deploy the site, which publishes the new client metadata.
2. On the laptop, `git pull`, then `bun run publisher install` to restart the helper. It reads
   the scope it asks for when it starts, so an old helper would sign in without the new one.
3. Wait a few minutes: bsky.social caches a client's metadata, and a sign-in asking for a scope
   it hasn't seen yet is refused.
4. In the composer's Accounts tab, disconnect Grain / Bluesky and connect it again.
5. `bun run publisher post-records`, and read the plan.
6. `bun run publisher uninstall`, `bun run publisher post-records --write`, then
   `bun run publisher install`.
