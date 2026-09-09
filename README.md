<a href="https://kualta.dev">`kualta.dev`</a>

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
