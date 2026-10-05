<a href="https://kualta.dev">`kualta.dev`</a>

## Atmosphere publishing

Articles also publish as Standard.site records after a successful website deployment.
See [the publishing workflow and interactive MDX fallbacks](docs/atproto.md).

## Newsletter

D1 owns subscribers, consent, opt-outs, suppression, issues, and per-recipient delivery
history. Plunk only delivers rendered HTML, from **kualta <contact@kualta.dev>**.
There are no Plunk templates or campaigns. The provider adapter is
`src/lib/newsletter/plunk.ts`; replacing it and its delivery-feedback integration
is the boundary for a later SES migration.

### Signup and subscription management

The top-left bell expands into the signup form; `/join` supports existing links.
`POST /api/subscribe` immediately records signup consent and activates the subscriber.
No confirmation or welcome email is sent. The form shows **You’re subscribed.**
Previously issued confirmation links remain supported.

Signup is limited to five attempts per IP/hour, one per address/10 minutes, and
100 total attempts/hour. D1 stores keyed hashes for rate-limit identifiers rather
than IP addresses. Missing configuration fails closed. Existing active or suppressed
addresses get the same success response. Suppressed addresses cannot
reactivate through the public form.

Every newsletter has a signed, site-owned unsubscribe URL and the RFC 8058
`List-Unsubscribe` / `List-Unsubscribe-Post` headers. GET shows a confirmation;
POST unsubscribes, including one-click requests from mail clients. Unsubscribe
invalidates outstanding confirmation links and never clears a suppression. The origin
guard in `src/middleware.ts` preserves Astro’s form protection, with an exception
only for originless form POSTs to the signed unsubscribe handler.

### Configuration

The `NEWSLETTER_DB` binding in `wrangler.jsonc` points to `kualta-newsletter`.
Apply migrations before deploying code that uses it:

```sh
bunx wrangler d1 migrations apply kualta-newsletter --local
bunx wrangler d1 migrations apply kualta-newsletter --remote
```

Set these independently generated secrets in `.dev.vars` for local development
and in the deployed Worker using `bunx wrangler secret put NAME`:

- `PLUNK_SECRET_KEY`: existing `sk_*` key from the verified Plunk project.
- `NEWSLETTER_TOKEN_SECRET`: at least 32 random characters; keep stable and backed up,
  because changing it invalidates existing unsubscribe and tracking links.
- `NEWSLETTER_ADMIN_SECRET`: at least 32 random characters, for the repo CLI.
- `NEWSLETTER_WEBHOOK_SECRET`: at least 32 random characters, for Plunk feedback.

Keys stay server-side. The public Plunk key is not used. The default link and CLI
origin is `https://kualta.dev`; for local testing set `NEWSLETTER_ORIGIN` to the local
server URL in `.dev.vars`. Remove that override for production.

Use the normal site build/deployment workflow after configuring the Worker secrets.
No subscriber import or broadcast is performed by builds or migrations.

### Preview and send an issue

Pass a post source such as `src/content/posts/memetic-culture.mdx` to render, test, or prepare.
The full Markdown article is included, with headings, images, links, lists, and quotes.
Site-relative asset URLs become absolute. MDX components require an email Markdown version.
Alternatively supply JSON with `id`, `title`, `preview`, `markdown`, and `articleUrl`. Legacy paragraph issues remain readable. The article URL must be on
`https://kualta.dev`. React Email renders the site's light palette,
rounded card, and corner brackets using email-compatible tables and inline styles.

```sh
# Local HTML/text preview only; never sends.
bun run newsletter:render src/content/posts/memetic-culture.mdx

# Send exactly one preview, after this address has subscribed.
bun run newsletter test src/content/posts/memetic-culture.mdx --to contact@kualta.dev --send

# Snapshot the current active audience; still sends nothing.
bun run newsletter prepare src/content/posts/memetic-culture.mdx
bun run newsletter status your-issue-id

# Explicit broadcast. Processes bounded batches until no pending recipients remain.
bun run newsletter send your-issue-id --confirm your-issue-id
```

Rendered previews are in `build/newsletter/`. Preparing the same id/content again
is a no-op, and changing content under an existing id is rejected. New signups are
not added to an already-prepared issue. Subscription status is rechecked just
before each send. Each recipient has a durable claim and a provider idempotency key.
Concurrent or repeated send commands do not resend completed deliveries.

A failed, in-flight, or uncertain delivery stops further batches. A timeout or an
ambiguous provider response is **unknown**, never assumed failed and never retried
automatically (Plunk's idempotency keys expire after 24 hours). Inspect provider
activity, then resolve the individual ledger entry without sending again:

```sh
bun run newsletter resolve DELIVERY_ID --provider-id VERIFIED_PLUNK_EMAIL_ID --confirm DELIVERY_ID
# Or explicitly skip it; this does not send or retry.
bun run newsletter resolve DELIVERY_ID --skip --confirm DELIVERY_ID
```

In-flight entries cannot be resolved until five minutes after their attempt. To
inspect delivery ids for a recipient, use the subscriber command below.

### Feedback and per-subscriber tracking

Open pixels and article-link redirects use signed URLs on `kualta.dev`. D1 stores
the first observed open/click for each issue and subscriber, including test emails
in their individual history. Aggregate issue metrics exclude test sends. These
are **estimated opens**, not proof of reading: image blocking hides opens, while
Apple Mail privacy proxies and scanners can create false opens/clicks.

```sh
bun run newsletter subscriber reader@example.com
bun run newsletter status your-issue-id
```

Plunk delivery, bounce, and complaint events go to the authenticated
`/api/newsletter/feedback?type=...` endpoint. Feedback is idempotent, tolerates
out-of-order arrival, and retains events arriving before a provider send id is
saved. Hard bounces and complaints suppress the subscriber; soft bounces are
recorded without permanently suppressing them.

```sh
# Prepare only event-forwarding workflows, initially disabled.
bun run newsletter:setup-feedback
# After deployment, verify the receiving endpoint and enable forwarding.
bun run newsletter:setup-feedback --enable
```

Plunk calls webhook forwarders “workflows”; these contain only a webhook step,
never a send step. Reentry is enabled so each subscriber's later deliveries also
report feedback. The setup script updates only its three named forwarders and
preserves already-enabled ones. Plunk does not retry failed webhook requests;
monitor forwarding failures and reconcile affected delivery records before the next
broadcast. The provider also retains recipients/delivery records as part of sending;
D1 remains the authoritative subscription list.

### Import and export

Exports include inactive and suppressed addresses so a provider migration cannot
accidentally resubscribe them. Files containing subscribers belong in ignored
`build/newsletter/`, not in Git. Export refuses to overwrite an existing file.

```sh
bun run newsletter export build/newsletter/subscribers.json
bun run newsletter import build/newsletter/subscribers.json
bun run newsletter import build/newsletter/subscribers.json --commit
```

Import accepts a JSON array, with explicit `email`, `status` (`active`,
`unsubscribed`, or `suppressed`), and `source` on every row. Active subscribers also
need their original `consent_at` Unix timestamp in seconds. Preserve the Paragraph
export's opt-outs and suppressions; do not invent consent dates. Import is batched,
sends no email, and never overwrites an existing opt-out or suppression with active
status. A later public signup requires fresh confirmation to reactivate an opt-out.

### Verification

`bun test` exercises the actual SQLite schema with injected email delivery, covering
confirmation, rate limits, suppression, immutable audience snapshots, concurrent
claims, uncertain sends, feedback races, tracking tokens, and consent-preserving
imports. Run `bun run check` and `bun run build` for the Astro/Cloudflare integration.
Real inbox delivery and provider feedback need a deployed endpoint and an explicitly
chosen test recipient.

Provider references: [send API](https://docs.useplunk.com/api-reference/public-api/sendEmail),
[feedback](https://docs.useplunk.com/guides/webhooks),
[workflow API](https://docs.useplunk.com/api-reference/overview).


### Subscription alerts

Set `NEWSLETTER_DISCORD_WEBHOOK_URL` as a Cloudflare Worker secret for Discord alerts.
Use `bunx wrangler secret put <NAME> --config wrangler.jsonc` and put the same names
in `.dev.vars` for local testing. Keep these values out of source control.

Alerts contain the subscriber email and `subscribed` or `unsubscribed`. They fire
only after an actual database transition, including re-subscription and legacy
confirmation. Duplicate requests and suppressed signups do not generate alerts.
Cloudflare `waitUntil` sends them in the background with a five-second timeout.
Delivery is best effort: failures are logged as `newsletter_notification_failed`
without addresses or credentials, and never prevent signup or unsubscribe.
There is no queue or automatic retry.

The same Discord webhook receives “`recipient@example.com` opened `Post title`”
on the first recorded open of each delivery (including previews).
The tracking pixel and Plunk open callbacks share an atomic `opened_at` update,
so reloads, retries, and overlapping reports produce one alert. Existing opens
are not replayed. Opens are estimates: email privacy proxies can preload images,
and blocked images can hide a real open.

### Background activity refresh

The existing `kualta-site` Cron Trigger (`* * * * *`) refreshes GitHub/Bluesky
even when nobody visits. It hands work to one private `ACTIVITY_STORE`
SQLite-backed Durable Object; provider normalization and full archive work stay
out of the page Worker's CPU budget. Home HTML and `/activity/rows` only read
snapshots. Empty/unavailable status never gates scrolling. Provider requests are
aborted after five seconds, initial HTML reads have a total 250ms budget, and
asynchronous head/history reads allow two seconds. The cron handoff is bounded
to 15 seconds. There is no public refresh endpoint or visitor-triggered refresh.

The object deduplicates each scheduled minute across callers and restarts, with
no long-running timer. It atomically commits the sanitized archive and head;
failed persistence preserves both previous snapshots. Failed providers retain
their last successful timestamps and data. Existing sanitizers strip private
repository names, targets, raw IDs, tokens and unused Bluesky viewer metadata
before anything enters persistent storage. Snapshot strings use 32Ki-character
chunks, preserving Unicode pairs and at most 1,024 chunks; shrinking a snapshot
removes obsolete chunks in batches of at most 128 keys.

First refresh reads the existing `ACTIVITY_CACHE` and rewrites validated canonical
snapshots into the object. It neither clears nor writes legacy KV. Older history,
coverage, edits/deletion reconciliation and source freshness semantics remain.
Initial HTML can use the legacy snapshot if an object read fails; failed polls
and history reads fail explicitly so the client can retain/retry visible data.
Without the new binding, the former KV/D1 implementation remains available.
Its already-applied `0007_activity_refresh.sql` is still required for that fallback
and the deployment workflow's existing read-only preflight.

**Rollout approval is required:** `wrangler.jsonc` prepares a new private binding
and an `activity-store-v1` class migration with `new_sqlite_classes` for
`ActivityStatusCache`. An approved deployment creates that persistent resource;
the build preserves the class export, binding and migration in
`dist/server/wrangler.json`. No remote migration, subscription or credential
change is performed while preparing this code. Verify the existing deployment
token can apply Worker class migrations before rollout; ask for setup if blocked.
For rollback, set `ACTIVITY_STORE_MODE=legacy` while retaining the class export,
binding and migration tag. This restores the old KV/D1 read/cron paths without
deleting object history; legacy KV then reflects its last pre-object snapshot.
Do not delete the namespace to roll back application behavior.

Cloudflare documents SQLite Durable Objects on Workers Free and a default
30-second invocation CPU budget. Free allowances are 100,000 requests/day,
13,000 GB-s/day, 5 million SQLite rows read/day, 100,000 rows written/day and 5GB
account storage; other objects share those limits. Cron adds 1,440 object requests
per day, plus visitor reads. A 649KB archive fixture uses about 20 archive chunks;
even changing it every minute plus claim/head writes is about 35,000 rows/day.
At the five-second provider timeout, minute refreshes add about 900 GB-s/day
before storage/visitor overhead. Measure real account-wide usage and leave room
for traffic; Free excess operations fail rather than enabling a paid upgrade.
See [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
and [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

The legacy KV/D1 backend has separate capacity constraints: successful minute
refreshes write at least 1,440 KV state updates/day, plus changed archives,
exceeding KV's free 1,000-write/day allowance. Cloudflare's
[Worker limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)
give Free Cron Triggers a 10ms CPU budget; a minute cron on Paid has a 30-second
budget. Increasing fetch/KV timeouts or adding `waitUntil` does not increase CPU
capacity. A scheduled `exceededCpu` outcome can occur after the coordination
claim advances, before any source timestamp is stored. An advancing D1 claim
therefore proves delivery, not a successful refresh. Verify the active Worker
limit and account entitlement; any higher-capacity plan requires separate approval.
Do not reduce the minute cadence as a workaround without agreeing to the change
in freshness. After an approved object rollout, require repeated successful cron
outcomes, advancing source timestamps and acceptable object usage. Cron changes
can take up to 15 minutes to propagate; providers can themselves lag. This branch
does not deploy itself.

The archive sort parses each timestamp once instead of doing so in every
comparison. To reproduce a local CPU comparison with synthetic data only:

```sh
bun build scripts/profile-activity.ts --target=node --outfile=/tmp/profile-activity.mjs
PROFILE_MODE=cron node --cpu-prof --cpu-prof-dir=/tmp /tmp/profile-activity.mjs
```

`PROFILE_CALENDAR_DAYS`, `PROFILE_POSTS` and `PROFILE_RUNS` adjust the fixture.
`PROFILE_MODE=head` or `history` isolates cache reads. `providers` runs the real
provider normalizers against synthetic JSON; `full-cron` also includes archive
work. `handoff` isolates the lightweight cron path with a mock object response;
it excludes the object's work and real IPC. `PROFILE_PROVIDER_CALENDAR_DAYS` controls the fixture's upstream calendar
size independently of its stored history. Rejected fixtures fail the run.
The script does not access remote storage or upstreams. Its Node/V8 process CPU
includes local GC and, for provider/full-cron modes, JSON parsing and provider
normalization. It omits network and D1; it is not Cloudflare CPU accounting or a
guarantee that a 10ms deployment will work.

`bounded-cron` is a diagnostic experiment that omits retained history. Use it
with a small provider calendar to estimate savings from separating history and
the minute refresh; it must never be treated as a deployable cache design. A
bounded redesign must durably store sanitized deltas before acknowledging
freshness, preserve edit/deletion reconciliation within observed provider
windows, and maintain honest coverage and last-success timestamps. Historical
backfills must also use bounded batches: moving the same full archive/calendar
work to an hourly cron leaves the same per-invocation CPU limit. Existing D1
could hold indexed event rows and small head/freshness state without minute KV
writes, but that requires prepared schema/code, measured D1 usage, and an
approved migration and rollout. Unchanged event upserts must avoid rewriting
every row each minute. The implemented object approach instead keeps the
existing full-history semantics and gives them a suitable invocation budget.

If **signals delayed** appears, at least one provider has no successful timestamp
or was last fetched over five minutes ago. It is independent of the last event's
age: a person can be inactive while the sources remain fresh. The client keeps
this deadline even when polling fails, and immediately retries reading the shared
snapshot on a cold/delayed arrival. These reads never request upstream providers.
Cron and asynchronous snapshot reads allow two seconds for KV, while initial HTML
retains its 250ms budget. A cache-read error during polling preserves the visible
snapshot; it does not replace it with empty data.

The deployment workflow now checks `SELECT minute FROM activity_refresh LIMIT 1`
with a **read-only** remote D1 query before replacing the Worker. If it fails with
`no such table`, an approved operator must apply only the activity migration:

```sh
bunx wrangler d1 execute kualta-newsletter --remote --config wrangler.jsonc --file migrations/0007_activity_refresh.sql
```

This command changes production schema and must be approved separately. Neither
runtime nor CI creates the table automatically. Once applied, verify the cron is
`* * * * *`, `ACTIVITY_CACHE` and `NEWSLETTER_DB` are bound, and the existing
`GITHUB_ACTIVITY_TOKEN` belongs to kualta. In Worker logs, coordination failures
report `verify-0007-migration-and-D1`; provider failures report sanitized codes
such as `missing-token` or `timeout`. Successful provider results and advancing
source timestamps establish recovery; missing events alone do not indicate failure.

Provider success alone does not establish a stored refresh. Cron now reports
`stage: persistence` with `result: stored` only after required snapshot writes
complete; failed writes fail the cron. Cache logs distinguish `quota-exceeded`,
`rate-limited`, `timeout`, `invalid-snapshot`, and `cache-unavailable` without
printing platform error details. If providers succeed but the snapshot stops
advancing, check these cache codes and the account's KV write usage/limit. A paid
capacity change requires approval. Automatic polling reports read failures and
continued delayed signals while keeping the last visible snapshot and scrolling
usable.
Head and archive writes are independent: a successful head write can remain fresh
while a failed history write is reported and retried on the next minute.

### Feed publication and post permalinks

Publishing from the home composer inserts the acknowledged repository record in
that browser session immediately, with its actual text, author, attachments and
post identity. Anonymous AppView readback replaces it when the same URI and CID
are indexed. Failed publication retains the draft; delayed indexing retains the
acknowledged card. Navigation and cache refresh reconcile by post identity and
preserve history. Posts written in other Bluesky clients still depend on public
indexing and the existing minute refresh; the page automatically reads the latest
shared snapshot.

Each post's options can copy its `kualta.dev/post/<did>/<rkey>` permalink or its
Bluesky URL. Direct permalink requests render the centered public post and share
metadata, with anonymous upstream reads bounded to three seconds. Missing posts
return 404 and unavailable upstream reads return 503; neither uses stale fallback
or stores visitor authorization in a shared cache. No additional infrastructure
or migration is required beyond the background-refresh prerequisites above.

Reproduce publication checks without sending real posts:

```sh
CHROMIUM_PATH=/usr/bin/chromium node scripts/check-post-feed.mjs
bun run build
CHROMIUM_PATH=/usr/bin/chromium node scripts/check-post-pages.mjs
```

The composer fixture stubs only authentication and repository writes; it exercises
the real composer, media processing, local reconciliation and link controls. The
permalink checks run the compiled Worker with a stubbed public AppView and also
exercise cold-cache home scrolling, hero-to-feed gestures, feed position retention,
history restoration and activity freshness recovery on desktop and mobile.
