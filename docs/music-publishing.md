# Music publishing on ATProto

The site's music catalog publishes as `fm.plyr.track` records on the PDS of the DID in `atproto.config.json`. MP3s are uploaded as audio blobs; artwork is uploaded through the plyr.fm API to its image CDN. Source links point to the website. Cover recordings retain the original-artist credit in their description. The website remains the editing source.

Run `bun run music:sync` before `bun run music:publish --dry-run` to generate artwork and validate the catalog. After deploying the same files, `ATP_APP_PASSWORD=… PLYR_TOKEN=… bun run music:publish` checks every deployed audio and artwork file before publishing and reads back each changed record. Supply credentials through the environment, never committed files or command history. `bun run music:publish --verify` checks the live website, PDS, and indexed cover bytes without writing.

Publishing requires an existing plyr.fm artist profile for the site's DID. Its index ingests music only for known artists, and external audio URLs alone are rejected; the PDS audio blob provides the playable source. Sign in to plyr.fm and set up the artist profile first. Then enable the repository variable `MUSIC_ATPROTO_ENABLED=true` to publish after successful website deployments using the existing `ATP_APP_PASSWORD` Actions secret. Create a dedicated developer token in plyr.fm settings and store it as the `PLYR_TOKEN` Actions secret. Renew it before its selected expiry. The sync verifies the token belongs to the configured DID before uploading artwork.

An existing record is matched by its audio URL or the canonical website URL on the first description line. Updates retain its AT-URI and social fields, use a compare-and-swap write, and upload audio only when its hash changes. Unchanged records cause no writes. A duplicate match, wrong identity, stale website, or readback mismatch fails the job. Removed songs are retained remotely; removals require a separate explicit action. Renaming both a song's slug and audio path requires migrating its existing record first. Failed requests are not automatically retried; inspect the PDS after an uncertain write before rerunning.

The sync waits briefly for indexed tracks, uploads missing or changed artwork, checks the CDN bytes, and writes the accepted image URL into the PDS record. Later metadata updates preserve that URL. plyr.fm rejects website-hosted image URLs; publishing those URLs alone does not sync covers. Artwork is compared byte-for-byte with the generated JPEGs, so unexpected server transformations fail verification rather than report success.

Successful PDS verification alone proves publishing, not discovery. Check the artist page and the public `https://api.plyr.fm/tracks/?artist_did=<DID>` response after activation to confirm indexing and playable audio. Indexing can lag behind record writes.

Sources: [track schema](https://github.com/zzstoatzz/plyr.fm/blob/main/lexicons/track.json), [external-record ingestion](https://github.com/zzstoatzz/plyr.fm/blob/main/docs/internal/architecture/jetstream-ingest.md). The schema is vendored in `scripts/lexicons/fm.plyr.track.json` for validation.

## Lyrics and scores

`fm.plyr.track` has no field for lyrics or sheet music, so each track that has either also gets a companion `dev.kualta.track` record (`scripts/lexicons/dev.kualta.track.json`). `src/data/music.json` and `public/music/scores/` stay the source; the website does not read these records.

| Field | Content |
| --- | --- |
| `track` | A `com.atproto.repo.strongRef` (URI and CID) to the track's `fm.plyr.track` record |
| `kind`, `originalArtist` | `original` or `cover`, and who a cover is by: the credit the track's description carries as prose |
| `lyrics` | `{ format, text }`; `format` is `lrc` when lines carry `[mm:ss.xx]` timestamps, otherwise `plain` |
| `score` | The MusicXML file as a blob |

The record key is a TID derived from `dev.kualta.track:<slug>`, so a track's slug is its permanent key here. The catalog `id` is positional and changes when tracks are added, which rules it out.

A compressed score (`.mxl`) is uploaded as `application/vnd.recordare.musicxml`, its registered type; `.musicxml` and `.xml` as `application/vnd.recordare.musicxml+xml`. The reference PDS names a blob by sniffing its content with `file-type` and only falls back to the uploader's type, then refuses a record claiming another type for that blob. An `.mxl` is a ZIP container, so it is stored as `application/zip`; a plain MusicXML file is stored as `application/xml`. The record therefore carries the type the PDS reports, the lexicon accepts all four, and any other reported type fails the step. A score over 2,000,000 bytes, the lexicon's cap, is refused before anything is published. The bytes are identified by CID and size either way.

`music:publish` syncs these records last, once the `fm.plyr.track` records and their artwork have settled, because the reference pins their final CIDs. A track record that changes gets a new CID, and the next run rewrites its companion. Writes are compare-and-swap with a readback, unchanged records are not written, and a score is uploaded only when its bytes differ from the published blob. `--dry-run` lists each companion with its lyrics and score sizes, and `--verify` compares them with the PDS without writing.

Removing a track, its lyrics or its score never deletes or trims a published companion: the step fails and lists the affected URIs. Delete those records explicitly, then rerun the workflow; a track that still has lyrics or a score gets a fresh record on that run. By then the site and the `fm.plyr.track` records are already published, and the projects, links and lexicons step still runs. When a track's `fm.plyr.track` record is replaced by a new one, its companion follows: the reference is re-pointed at the new URI.

## Interactive scores

Place a MuseScore MusicXML export next to the catalog in `public/music/scores/<track-slug>.mxl` (also `.musicxml` or `.xml`). `music:sync` discovers the attachment on every build. Dialogue, Self-Conscious Portrait and Embrace it include scores; tracks without a matching attachment keep their existing layout.

An attached score replaces both the full-size vinyl and lyrics with a large, scrollable notation player. The shared MP3 still owns playback, seeking, volume, looping, queue advancement and playback across navigation. alphaTab loads on demand and supplies notation, note highlighting, click-to-seek, zoom and following the current system. No soundfont or synthesizer audio is loaded. The score and font are served by the site.

Use the same arrangement and tempo for the score and MP3. Playback uses MusicXML timing, including repeats and alternate endings, rather than stretching the score across the MP3's duration (which includes reverb). Dialogue's export is 105 BPM; its MP3 note attacks align with that timing to approximately 40 ms at both the beginning and final chord. Recordings with different tempo, rubato or edits require explicit alignment before their cursor can be considered accurate.

The Bun patch in `patches/@coderline%2Falphatab@1.8.4.patch` adds beat groups around SVG stems and flags, so alphaTab highlights them together with their noteheads, and removes the renderer credit footer. Keep this patch when updating the renderer until upstream includes equivalent grouping; verify playback highlighting after upgrades. Notation uses the site's foreground color on a transparent background in both themes.
