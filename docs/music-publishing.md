# Music publishing on ATProto

The site's music catalog publishes as `fm.plyr.track` records on the PDS of the DID in `atproto.config.json`. MP3s are uploaded as audio blobs; artwork and source links point to the website. Cover recordings retain the original-artist credit in their description. The website remains the editing source.

Run `bun run music:sync` before `bun run music:publish --dry-run` to generate artwork and validate the catalog. After deploying the same files, `ATP_APP_PASSWORD=… bun run music:publish` checks every deployed audio and artwork file before publishing and reads back each changed record. Supply credentials through the environment, never committed files or command history. `bun run music:publish --verify` checks the live website and PDS without writing.

Publishing requires an existing plyr.fm artist profile for the site's DID. Its index ingests music only for known artists, and external audio URLs alone are rejected; the PDS audio blob provides the playable source. Sign in to plyr.fm and set up the artist profile first. Then enable the repository variable `MUSIC_ATPROTO_ENABLED=true` to publish after successful website deployments using the existing `ATP_APP_PASSWORD` Actions secret. No plyr.fm developer token is required.

An existing record is matched by its audio URL or the canonical website URL on the first description line. Updates retain its AT-URI and social fields, use a compare-and-swap write, and upload audio only when its hash changes. Unchanged records cause no writes. A duplicate match, wrong identity, stale website, or readback mismatch fails the job. Removed songs are retained remotely; removals require a separate explicit action. Renaming both a song's slug and audio path requires migrating its existing record first. Failed requests are not automatically retried; inspect the PDS after an uncertain write before rerunning.

Successful PDS verification proves publishing, not discovery. Check the artist page and the public `https://api.plyr.fm/tracks/?artist_did=<DID>` response after activation to confirm indexing and playable audio. Indexing can lag behind record writes.

Sources: [track schema](https://github.com/zzstoatzz/plyr.fm/blob/main/lexicons/track.json), [external-record ingestion](https://github.com/zzstoatzz/plyr.fm/blob/main/docs/internal/architecture/jetstream-ingest.md). The schema is vendored in `scripts/lexicons/fm.plyr.track.json` for validation.
