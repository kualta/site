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
