# Music publishing on ATProto

The site's music catalog publishes as `fm.plyr.track` records on the PDS of the DID in `atproto.config.json`. MP3s are uploaded as audio blobs; artwork is uploaded through the plyr.fm API to its image CDN. Source links point to the website. Cover recordings retain the original-artist credit in their description. The website remains the editing source.

Run `bun run music:sync` before `bun run music:publish --dry-run` to generate artwork and validate the catalog. After deploying the same files, `ATP_APP_PASSWORD=… PLYR_TOKEN=… bun run music:publish` checks every deployed audio and artwork file before publishing and reads back each changed record. Supply credentials through the environment, never committed files or command history. `bun run music:publish --verify` checks the live website, PDS, and indexed cover bytes without writing.

Publishing requires an existing plyr.fm artist profile for the site's DID. Its index ingests music only for known artists, and external audio URLs alone are rejected; the PDS audio blob provides the playable source. Sign in to plyr.fm and set up the artist profile first. Then enable the repository variable `MUSIC_ATPROTO_ENABLED=true` to publish after successful website deployments using the existing `ATP_APP_PASSWORD` Actions secret. Create a dedicated developer token in plyr.fm settings and store it as the `PLYR_TOKEN` Actions secret. Renew it before its selected expiry. The sync verifies the token belongs to the configured DID before uploading artwork.

An existing record is matched by its audio URL or the canonical website URL on the first description line. Updates retain its AT-URI and social fields, use a compare-and-swap write, and upload audio only when its hash changes. Unchanged records cause no writes. A duplicate match, wrong identity, stale website, or readback mismatch fails the job. Removed songs are retained remotely; removals require a separate explicit action. Renaming both a song's slug and audio path requires migrating its existing record first. Failed requests are not automatically retried; inspect the PDS after an uncertain write before rerunning.

The sync waits briefly for indexed tracks, uploads missing or changed artwork, checks the CDN bytes, and writes the accepted image URL into the PDS record. Later metadata updates preserve that URL. plyr.fm rejects website-hosted image URLs; publishing those URLs alone does not sync covers. Artwork is compared byte-for-byte with the generated JPEGs, so unexpected server transformations fail verification rather than report success.

Successful PDS verification alone proves publishing, not discovery. Check the artist page and the public `https://api.plyr.fm/tracks/?artist_did=<DID>` response after activation to confirm indexing and playable audio. Indexing can lag behind record writes.

Sources: [track schema](https://github.com/zzstoatzz/plyr.fm/blob/main/lexicons/track.json), [external-record ingestion](https://github.com/zzstoatzz/plyr.fm/blob/main/docs/internal/architecture/jetstream-ingest.md). The schema is vendored in `scripts/lexicons/fm.plyr.track.json` for validation.

## Interactive scores

Place a MuseScore MusicXML export next to the catalog in `public/music/scores/<track-slug>.mxl` (also `.musicxml` or `.xml`). `music:sync` discovers the attachment on every build. Dialogue, Self-Conscious Portrait and Embrace it include scores; tracks without a matching attachment keep their existing layout.

An attached score replaces both the full-size vinyl and lyrics with a large, scrollable notation player. The shared MP3 still owns playback, seeking, volume, looping, queue advancement and playback across navigation. alphaTab loads on demand and supplies notation, note highlighting, click-to-seek, zoom and following the current system. No soundfont or synthesizer audio is loaded. The score and font are served by the site.

Use the same arrangement and tempo for the score and MP3. Playback uses MusicXML timing, including repeats and alternate endings, rather than stretching the score across the MP3's duration (which includes reverb). Dialogue's export is 105 BPM; its MP3 note attacks align with that timing to approximately 40 ms at both the beginning and final chord. Recordings with different tempo, rubato or edits require explicit alignment before their cursor can be considered accurate.

The Bun patch in `patches/@coderline%2Falphatab@1.8.4.patch` adds beat groups around SVG stems and flags, so alphaTab highlights them together with their noteheads, and removes the renderer credit footer. Keep this patch when updating the renderer until upstream includes equivalent grouping; verify playback highlighting after upgrades. Notation uses the site's foreground color on a transparent background in both themes.
