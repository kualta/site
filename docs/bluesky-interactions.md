# Bluesky login and conversations

Visitors sign in through their AT Protocol account provider using OAuth. The site
never asks for an account password or an app password. The official browser OAuth
client manages PKCE, DPoP, token refresh, and browser-local session persistence.
Logging out revokes the session. There is no site account database or shared
visitor credential in the Cloudflare activity cache.

The public `/oauth-client-metadata.json` endpoint describes the current origin and
its `/auth/bluesky` callback. The requested permissions cover creating and removing
likes/reposts, publishing/removing posts, and the specific AppView read methods used
by the UI. No client secret or deployment secret is required.

## Local testing

1. Run `bun install` and `bun run dev --host 127.0.0.1 --port 4321`.
2. Open `http://127.0.0.1:4321` and choose **Log in**.
3. Enter a Bluesky handle and complete authorization at the account provider.
4. Test feed likes, reposts, and replies, then open an article to test comments.
5. Reload to verify session restoration, then log out through **Account**.

Use `127.0.0.1` for the OAuth loopback redirect; `localhost` is normalized to it.
Local tests perform real public Bluesky writes when you submit an interaction.
The callback returns to the page that initiated sign-in. Off-site return paths
are rejected. HTTPS preview deployments use metadata at their own origin.

## Feed actions

The shared activity feed remains public and cacheable. Each visitor fetches their
own reaction state using their authenticated agent. Actions use fresh post CIDs;
removal uses the visitor's actual like/repost record URI. Replies retain the
original thread root. Custom elements mount controls in fetched/paginated rows
and unmount removed rows without leaking subscriptions.

## Article comments

Each top-level comment is a public `app.bsky.feed.post` in the visitor's repository
with an external embed pointing to the canonical article URL. Logged-out readers
use Bluesky's public AppView search, followed by exact URL verification, to find
these conversations. Reply threads include replies made on Bluesky itself.
Search indexing is eventually consistent, so a successful new comment can take
time to appear for other visitors. The UI confirms the repository write immediately.

Comments follow the public network's availability and moderation state. They are
not private messages or a separate site-owned copy. Visitors can delete their own
comments after confirmation or manage posts through **View on Bluesky**. Article publishing does not
create an announcement or thread-root post on the site owner's account.

## Verification

Run `bun test`, `bun run check`, and `bun run build`. Tests cover OAuth return-path
validation, metadata, exact article matching, threaded replies, reaction writes,
and immediate undo while AppView indexing catches up. Provider authorization and
real public writes require a visitor to finish sign-in in the browser.

## Media attachments

The shared feed/comment composer accepts up to ten JPEG, PNG, or WebP images,
or one MP4, MOV, or WebM video. Controls sit to the left of the submit button.
Attachments have previews, editable descriptions, and removal controls. Image-only
posts are allowed. Failed writes retain attachments. Files stay in memory and are
not restored after navigation or a reload.

Images (up to 20 MB input) are decoded into pixels, scaled to at most 2048 pixels,
and encoded as PNG; only decoding/pixel chunks remain. Images are reduced further
until below 1 MB. Videos (up to 100 MB input and 3 minutes) are transcoded locally
with FFmpeg to H.264/AAC MP4 at at most 1280 pixels. Source tags, chapters, extra
tracks, H.264 SEI, optional MP4 metadata boxes, and creation/modification timestamps
are removed. Required codec, dimensions, and playback timing remain. Sanitization
failures never fall back to uploading originals. Files receive random UUID names
and a zero file modification timestamp before upload.

FFmpeg is loaded only when a video is selected. Its version-pinned core is fetched
from jsDelivr; media is processed in a browser worker and is never sent there.
Only sanitized files reach the visitor's PDS. Video files must carry the local
sanitizer's in-memory provenance; image files are sanitized again at upload.
The client requests `blob:image/png` and `blob:video/mp4`; existing sessions
reauthorize when first selecting an attachment control.

A media comment uses its media embed and appends the canonical article URL with
an explicit link facet instead of the external link card. The character count
includes that URL. This preserves exact article discovery. Video processing on
Bluesky can finish after the post is accepted; external viewers may see it later.
See [Bluesky video upload documentation](https://bsky.network/docs/about-bluesky-content/video/)
and [AT Protocol blob permissions](https://atproto.com/specs/permission).

Validation includes PNG ancillary/trailing-data removal, MP4 metadata removal
without shifting sample offsets, and rejecting unsupported/unprepared uploads.
A temporary local browser harness verified generated PNG/WebM sanitization,
playable MP4 output, renamed upload payloads, and comment URL matching using a
mock agent, without publishing public test posts.

Image attachments use the legacy image embed for one to four images and a gallery
embed for five to ten. Ten is the gallery authoring limit recommended by Bluesky.
Image preparation runs sequentially to bound memory usage for larger selections.
