# Grade

A local app for grading camera footage in bulk before it goes into OpenFilm: pick a look, set exposure, white
balance, tint, contrast and saturation across many clips at once, watch it live, and export graded copies when it
looks right. It's dark or light as the Mac's appearance is set (or, in the composer's Grade tab, as the composer is);
full screen stays dark.

On the owner's laptop it is always running: launchd starts it at login and restarts it if it exits
(`dev.kualta.grade`, `~/Library/LaunchAgents/dev.kualta.grade.plist`, log `~/Library/Logs/Grade/server.log`), from
the main checkout. Open http://127.0.0.1:4777 rather than starting it. It loads its code once, so after a
`scripts/grade` change is merged and master is pulled there, restart it once nothing is exporting:

```sh
launchctl kickstart -k gui/$(id -u)/dev.kualta.grade
```

Elsewhere, start it by hand:

```sh
bun run grade          # http://127.0.0.1:4777, opens in the browser
```

With the agent running, port 4777 is taken. To try a branch, start it on another port, and point it at other folders
too, since a second server reads and writes the same grades and exports (it only reads LUTs, so it can share them):

```sh
GRADE_PORT=4778 GRADE_ROOT=/tmp/grade/movies GRADE_DATA=/tmp/grade/data GRADE_CACHE=/tmp/grade/cache \
  GRADE_LUTS="$HOME/Library/Application Support/Grade/luts" bun run grade
```

## Where clips come from

**Clips from** (top bar) lists shoot days from two places, and the days in Cloudflare:

- **Pocket 4P**: the camera's card while it's plugged in (`/Volumes/Pocket4P/DCIM`, `GRADE_CAMERA`), by the date in
  each DJI file name. Clips stay on the card: nothing is copied off it, and nothing is written to it except by ⌘⌫
  (below). Thumbnails come from the still each DJI file carries; a clip's preview is made from the card when you
  select it.
- **On this Mac**: the video in `~/Movies/Original/`, for clips that aren't on the camera, by the date in a DJI name
  or else the file's own date.

**Cloudflare**, the last group, lists the days with clips that were offloaded and aren't on this Mac, to bring back
(below).

Each day shows how many of its clips have an export, and the clip list can show only graded or ungraded clips.

## What the app writes

```
~/Movies/                                 GRADE_ROOT
  Original/                               clips on this Mac (above)
  Exported/                               exports and nothing else:
    DJI_…_0234_D.mp4                        8-bit H.264 BT.709, near lossless (or at the quality chosen), sound copied
    DJI_…_0234_D_f0102.png                  Export frame: frame 102, graded, full size
~/Library/Application Support/Grade/      GRADE_DATA
  grades.json                             every clip's grade, by file name, saved as you work
  exports.json                            what each export was made with: source, base look, grade, key, quality
  ledger.json                             the footage ledger (below), also kept in the site's archive
  offloaded.json, graded.json             what each offloaded clip and export was (below)
  keep.json, offload.json                 what's kept out of offload, and when the card's copies go (below)
  backup.json                             which of the settings above the archive has
  transcripts/<day>/                      <clip>.vtt and <clip>.json: what's said in each offloaded clip (below)
  transcripts.json                        which clips have one, and which of those are in the archive
  luts/                                   GRADE_LUTS: base looks (below)
~/Library/Caches/Grade/                   GRADE_CACHE: metadata, thumbnails, previews; safe to delete, but for
  audio/<day>/                              the sound of offloaded clips not transcribed yet
```

Clips are known by file name, so a clip graded off the card and the same clip copied into `Original/` share one grade
and one export. An export put in `Exported/` by hand counts as graded too.

## The ledger, the composer's Footage tab, and its Grade tab

The app keeps the footage ledger: a record of every clip it has ever seen, with its profile, its grade, and where its
copies are (the original on the camera, on this Mac in `Original/` or in the Cloudflare archive; the graded copy on
this Mac in `Exported/`, in the Cloudflare archive or on YouTube). It's shown in the composer's **Footage** tab
(post.kualta.dev/footage, **Footage** in the top bar), from phone or laptop; here, the selected clip's panel says where
its copies are in a line.

The server looks every 30 seconds (and after an export or ⌘⌫) and merges what it sees into what it knew, so a clip
off the card or the Mac keeps its record. What it can't look at keeps its last answer: the card's clips while it's
unplugged (the Footage tab says as of when), and the archive between askings (every 10 minutes). The sources:

- the card and `Original/`, and each clip's profile from its metadata (clips not yet probed are probed a few at a
  time, none while an export reads the card);
- `grades.json`, `exports.json` and `Exported/`;
- YouTube: the crossposter helper's `.publisher/footage.json` in this checkout (`GRADE_PUBLISHER` names the folder),
  what the footage archive put up;
- Cloudflare: the archive's film projects, each manifest read once per archiving. A file of a clip's that's the
  original's size is the original; any other is a graded copy, the current one when it's the export's size (the same
  goes for YouTube);
- films: the OpenFilm projects in `~/Movies/OpenFilm/Projects` (`GRADE_PROJECTS`) and in the archive, each with the
  ledger's clips in its `assets/` and `zh/assets/` (`projects` in the ledger, with whether it's on this Mac and
  archived). The composer's Pipeline pieces name a film or a shoot day and say how its clips stand.

`ledger.json` is the ledger as last merged. Whenever anything in it changes it's sent whole to the site's archive
(`ledger/footage.json`, through `helper/archive/ledger` on the helper's pairing), but only once the archive's copy has
been read back and merged in, so a fresh `ledger.json` on a new Mac can't drop clips only the archive knows. Each
clip's thumbnail (made in the cache a dozen per look, from the original's still or a frame, or from the graded copy
once the original is gone) goes to `ledger/thumbs/<clip>.jpg` once, and the clip's record says `thumb`. Along with a
ledger that's sent go `grades.json` and `exports.json`, as the archive's `_settings` project: only if they changed, and
at most every 10 minutes (`bun run publisher restore _settings <folder>` brings them back). Without a paired helper all
of it stays on this Mac.

**Grade tab.** post.kualta.dev/grade shows this app in a frame, loaded from http://127.0.0.1:4777: it still reads
the card and `~/Movies` itself, previews on the browser's GPU and exports with ffmpeg here. The frame is allowed local
network access, and Chrome asks once whether post.kualta.dev may reach this device: allow it. Away from the Mac, or
until it's allowed, the tab says so. Only the composer may frame the app (`frame-ancestors`: post.kualta.dev, and the
site run locally on port 4321). In the frame the app says it's there, opens the clips the Footage tab's **Grade**
asks for (`#clip=<file>` in its address, or a message; `/api/find` says which day holds it), takes the composer's light
or dark, and says how far its offload and export are, each time it reads `/api/jobs`, for the composer's title.

## Offload: the card to this Mac, this Mac to Cloudflare

The foot of the Export button's menu has three switches, each started and stopped by itself while the others are on
or off. Nothing starts until one is clicked, and after a restart of the server nothing starts by itself.

- **Camera → Mac** copies the card's clips, a clip at a time, oldest first, while this Mac has room for the next with
  `GRADE_KEEP_FREE` (5 GB) to spare: into `Original/` (as a hidden `.part` until it's checked), hashed (SHA-256) as
  it's read, read back and checked against that, and given the card's time. Then the card's clip is deleted with its
  `.LRF`: **Once on this Mac**, or **Once in Cloudflare**, as chosen below the switches (remembered). A clip that's in
  `Original/` already is checked against the card instead of copied; one of its name that isn't it is never written
  over. Nothing is sent.
- **Mac → Cloudflare** sends what's in `Original/`, two clips at a time: each unless the archive already holds those
  bytes (whole up to 16 MiB, else 16 MiB a request, so each lands well inside a request's ten minutes on a slow uplink;
  through `helper/archive` on the helper's pairing), filed in its shoot day's manifest in the archive,
  `_originals-<day>` (as `assets/<file>`, the manifest saved again after every clip), recorded in `offloaded.json`,
  then deleted from this Mac, which makes room for the next clip off the card. A file changed in the last two minutes
  may still be being written, and waits. The card isn't looked at.
- **Exports → Cloudflare** does the same for `Exported/`: the exports the app made (`exports.json` says so), unchanged
  for two minutes and not being made again, filed in `_graded-<day>` and recorded in `graded.json`. Exported frames and
  files put there by hand stay, and so does one the YouTube uploads are on until it's up. An offloaded export still
  counts as exported here, as a graded copy in the ledger, and for the YouTube uploads.

Each switch deletes only what it takes from: the card's clips only Camera → Mac, this Mac's only the other two. So with
**Once in Cloudflare** the card is cleared while both of the first two are on, as each clip is checked (Camera → Mac
stays on until then), or by Camera → Mac the next time it is. Mac → Cloudflare ends once there's nothing left to send
and nothing more coming off the card, so start the two together, or Camera → Mac first.

**Checked before anything goes.** R2 checks a file sent whole against its hash but not one sent in parts, so a clip over
16 MiB is read back in full and hashed before its Mac copy goes: each is downloaded once as well as uploaded, and one
that doesn't match is sent once more. Parts are put together only if what went up hashes as the file did. Every save of
a day's manifest, from whichever run, waits for the one before it, starts from what the archive has of the day by then,
and is read back: a clip's copies go only once its day lists it and the record is on disk. A clip already recorded is
only deleted, once the archive says it holds its hash and the file is that one (hashed on the Mac; the card's is read
and hashed too, unless it has the time it had when it was read off the card); one the archive has lost goes again, its record forgotten till it's
checked. An original listed in the archive gives way only to a larger one of its name, and stays listed itself, in
`replaced/`, so part of a clip never takes its place: another is passed over, and stays where it is. Nothing goes that was written to since it was listed, that's being exported, or
that's kept (below).

**Stop** finishes the files in flight (the clip being copied, the two being sent, their manifest saves and deletions)
and then stops; a second click (**Stop now**) cuts them. Both the switch and the bar's **Stop offloading** do this, and
say which it is.

**Picking itself up.** A switch that's on stays on when the camera is unplugged or the network or the site fails
(a request that times out, a 5xx, a 401, 403 or 429): it says what it's waiting for and tries again after 30 seconds,
then twice as long each time up to 10 minutes. The clip in flight starts over. With no room on this Mac, Camera → Mac
waits for some. A clip that fails five times while the rest works (or never reads back as it was sent) is passed over
until the switch is next started, which the menu, the status line and the log say, with why.

**The pause.** Uploads pause between parts, keeping the parts sent, while no Grade page has asked how things are going
for a minute, and go on when one does; the switch says so. **Keep going when this tab is closed** (off for each run)
lets a run go on without. Camera → Mac never pauses.

**Kept.** Shoot days ticked in the menu, and clips named in `keep.json` (those brought back, above all; by name without
extension, so a clip's original and its export are kept alike), stay on the card and on this Mac: they're never copied,
sent or deleted, aren't counted, and get no transcript. A day with some of its clips kept shows a dash, and a click lets
those go. While `keep.json` can't be read nothing is taken or deleted.

`offloaded.json` (beside `grades.json`) records each clip's hash, size and day, and for one read off the card the time
its file had there (`card`); `graded.json` the same of exports. Started by hand or by a script:

```sh
curl -X POST http://127.0.0.1:4777/api/offload -H 'X-Grade: 1' -H 'Content-Type: application/json' -d '{
  "lanes": ["copy", "send"], "unattended": true, "clearCardAfter": "sent", "youtube": false }'
```

`lanes` are the switches to start (`copy`, `send`, `exports`; without it, the first two, the card's if it's plugged in);
none only changes how the run goes. `POST /api/offload/stop` takes `lanes` too, and `now`; `GET` and `POST
/api/offload/keep` read and set `{ "days": [], "clips": [] }`; `GET /api/offload` says how it all stands.

**Transcripts.** As soon as a clip is on the Mac its sound is taken out of it (copied, a second or two) into the cache;
its Mac copy waits for that and nothing more. Whisper (`mlx-community/whisper-large-v3-turbo` on the GPU, the language
its own guess) then transcribes the sound in the background, one clip at a time, half a minute or so for ten minutes of
it, starting none while an export runs. The bar says "Transcribing 3 of 12". Each transcript is kept here as a `.vtt`
(read it, search it) and a `.json` (Whisper's segments with every word's time), and its sound is deleted. While Mac →
Cloudflare is on, finished transcripts are sent up and filed beside their clips in the day's manifest, as
`transcripts/<clip>.vtt` and `.json`; ones finished after it ended go the next time, which it starts for even if they're
all there is to send. The ledger marks a clip `transcript` once its transcript is in the archive, and counts neither
file as footage.

Whisper's word times run 0.15-0.5 s early on street audio: the transcript is for reading and searching, and cuts still
need forced alignment.

It runs `uvx --offline --from mlx-whisper mlx_whisper` (uvx by its path, `GRADE_UVX` names another) and downloads
nothing, so both have to be in their caches already. If it's missing or fails, the bar says how many clips aren't
transcribed, with why in its tooltip (and once in the log), and their sound is kept: it's tried again when Mac →
Cloudflare next starts and when the server does, which is also when sound left by a restart is picked up. A clip with no
sound has no transcript, one nobody speaks in an empty one, and one whose sound can't be taken goes on without: its
video is in the archive all the same.

While anything is being sent, and not paused, the grade app keeps the composer counted as watching the footage uploads
(`helper/footage/watch`), so the helper puts graded clips up to YouTube meanwhile, as it does while the Footage tab is
open; `"youtube": false` in the request keeps that off for the run. Log clips without a grade get the default look as
settings first (`GRADE_DEFAULT_LOOK`, OpenDRT Colorful), to change before any export. The ledger counts offloaded clips
as in Cloudflare (an archived file the original's size) as they go, and reads the archive's own list of them at most
every 10 minutes and once a run is over; `_originals-*` and `_graded-*` aren't films. To bring a day back, transcripts
and all: `bun run publisher restore _originals-<day> <folder>`.

## Bring to Mac: from Cloudflare back here

Under **Cloudflare**, **Clips from** lists each shoot day with clips the archive has and this Mac doesn't. Picking one
lists them with their sizes, and **Bring** gets one back: an original into `Original/`, a graded copy into `Exported/`.
**Bring all** takes every original, or graded copy, of the day that isn't here. A brought original is in its day under
**On this Mac** again, with the grade it had (its button then says **Grade**, and opens it there). The status line says
how far it is and **Stop bringing** ends it. A clip asked for by name (`#clip=<file>`, or the composer's message) that's
neither on the card nor here opens its day in Cloudflare, marked; the Footage tab's **Grade** button is off for those.

Originals are in `_originals-<day>` projects in the archive and graded copies in `_graded-<day>` ones, each clip as
`assets/<file>`. A day's manifest is read once each time it's archived, and the list of days again when an offload ends,
after an hour, or on **Refresh**. Nothing is ever written to the archive. What's on this Mac is told by name and size.

Clips come one at a time, each streamed to a hidden `.<file>.bring.part` beside where it goes and hashed as it comes. It
takes its name only if its size and SHA-256 are what its manifest lists, with the time it had (the footage uploads know a
clip they've put up by its size and time), and never over a file that has that name by then: the very same file is
skipped, another is left as it is and the clip stays in Cloudflare, saying so. One that's stopped, fails or comes back
different leaves nothing here; a clip's own trouble lets the next come, and the archive out of reach ends the run. The
`.part`s of a server killed meanwhile go when it starts again. A clip of 3.5 GB takes about 15 minutes at 30 Mbit/s.

It starts only if `GRADE_KEEP_FREE` (5 GB) stays free after all that's asked for, and with room for what an export or the
offload's copy off the card has still to write (an export is counted at its original's size, times its quality). That's
looked at again before each clip and every few seconds during one: when room runs short the clip gives way, saying why.

A clip brought here, original or graded copy, is kept out of offload (**Kept**, above) from just before it takes its
name, so one that's on doesn't take it off again: it stays until its day is let go in the Export menu.

## Grading

- **Look**: the base look for the clip's camera profile, read from its own metadata tag. D-Log2, D-Log and HLG get
  the ACES conversions (from DJI's curve math, out through ACES 2.0 or 1.0), ARRI, AgX, OpenDRT, Fujifilm film
  simulations and Sony looks; D-Log2 and D-Log also get DJI's own Rec.709 LUTs, and D-Log2 the twelve P4P looks.
  Rec.709 clips are graded as shot. A clip that hasn't been graded starts on OpenDRT Colorful, or on ACES 2.0 where
  its LUT isn't there (`DEFAULT_LOOKS` in color.mjs).
- **Exposure** in stops, **Temperature** in Kelvin (as if the camera had been set to it; it starts at the camera's
  own), **Tint** (+ magenta, − green), **Contrast** around 18% grey, **Saturation**. All of it happens in scene
  linear light before the look.
- **Deflicker** (under Light): **Off**, **Light** or **Strong**, for artificial light flickering at a shutter that
  doesn't match it, and exposure that jumps from frame to frame in timelapse-like shots. ffmpeg's `deflicker` scales
  each frame's brightness to the mean of it and the frames after it: 6 for Light, 12 for Strong (`mode=am`). Mains
  light at a mismatched shutter pulses every few frames (50 Hz light every 6 frames at 24 fps, every 3 at 30 or 60,
  every 12 at 48), and a window of whole pulses cancels them: 6 frames cancels 2-, 3- and 6-frame pulses, 12 also 4-
  and 12-frame ones. Light (a quarter second at 24 fps, a tenth at 60) suits handheld, where brightness that changes
  as the camera moves should stay; Strong, twice as long, suits tripod and timelapse shots, where nothing should. The
  mean, not the median: the window looks ahead, so a real change in light comes in as a ramp over it rather than a
  jump half a window early. A clip's last few frames, with less after them, are evened out less. It works on the
  graded picture, after the LUT (it scales brightness: right for Rec.709, where a change in light is close to a scale,
  wrong for log, where it's an offset), and only in exports. The preview can't show it, as the panel says; **Export
  frame** reads the frames after the one on screen too, so the still is that frame of the export. Off, a grade has no
  `deflicker` field at all, so exports made before it stay current.
- Select several clips (⌘-click, shift-click, Select all or ⌘A) and a change sets that control on all of them. Copy grade /
  Paste copies a whole grade.
- **Split** and **Original** compare against the flat original; hold **B** to flash it. Space plays, ↑ ↓ change clip.
- The preview plays the original itself at full resolution (streamed off the card), so focus and detail are as shot.
  It is still 8-bit on screen, because Chrome hands video to WebGL at 8 bits even from a 10-bit file, so judge banding
  on an export. HLG clips play a 1280 px preview copy instead, so the browser can't tone-map them.
  **Full screen** (or **F**) gives the viewer and its transport the whole screen.
- **Export** (top right) bakes the selected clips. Its ∨ menu has **Export frame** (the frame on screen, graded, as a
  full-size PNG in `Exported/`), **Re-export N changed** (every graded clip whose grade moved since its export)
  and **Quality**: 100% (each time the app opens) is near lossless, whatever size that takes; below it the video gets
  that share of the original's bitrate, so the menu can say the size first (50% ≈ half the original file), and
  Export shows the percentage. Exports come from the 10-bit originals (off the card, for a camera day) at 16-bit
  precision, not from the preview. A camera day can't export while the camera is unplugged. Exporting more than ten
  clips at once asks for a second click; **Stop exporting** (top bar, while anything exports) drops the queue and
  stops the clip in progress, which leaves its previous export and record as they were.
- **⌘⌫** moves the selected clips to the Trash, each with the files beside it under the same name (the camera's
  `.LRF` proxy), as Finder would: a camera day's go to the card's own Trash, so Finder can put them back, and the
  space comes back when the Trash is emptied. Their grades and graded copies stay. More than ten at once asks for a
  second press; a clip that is exporting can't be trashed.

## Base looks (`luts/`)

| Group | Files | From |
| --- | --- | --- |
| DJI | `dji/DJI OSMO Pocket 4P D-Log2 to Rec.709 [vivid] V1.0 size65.cube`, `… D-Log … V2.0 size33.cube` | DJI's own, listed on [dji.com/lut](https://www.dji.com/lut) (no HLG) |
| ACES | `<profile>-to-rec709-aces2.cube`, `…-aces1.cube` | `make_luts.py`, OpenColorIO's ACES configs |
| AgX | `agx/<profile>-<look>.cube` | `make_luts.py`, Blender's OpenColorIO config (needs Blender in /Applications) |
| ARRI, Fujifilm, Sony, OpenDRT | `<pack>/<profile>-<look>.cube` | `make_luts.py`, from the makers' LUTs in `vendor/<pack>/` (below) |
| P4P | `p4p/P4P_01_Neutral_size65.cube` … `P4P_12_Punch_…` | [Codebater/pocket4-luts](https://github.com/Codebater/pocket4-luts) (CC BY 4.0), D-Log2 only |
| Custom | `custom/<dlog2\|dlog\|hlg\|rec709>/*.cube` | your own; each shows up as a look for that profile |

```sh
uv run --with opencolorio --with numpy scripts/grade/make_luts.py "~/Library/Application Support/Grade/luts"
```

Other cameras' LUTs take their own log, so `make_luts.py` converts each profile's footage into it (through
ACES2065-1, exact for every curve and gamut involved) and runs the maker's LUT on that, unmodified. Missing packs are
skipped. Each `vendor/<pack>/SOURCE.txt` records its download:

| `vendor/` | Looks | Input | Download |
| --- | --- | --- | --- |
| `fujifilm/` | Provia, Velvia, Astia, Classic Chrome, Reala Ace, Pro Neg. Std, Classic Neg., Eterna, Eterna Bleach Bypass, Acros | F-Log2 / F-Gamut | [GFX ETERNA 55 3D-LUT v1.10](https://dl.fujifilm-x.com/support/lut/gfx-eterna-55-3d-lut-v110.zip), `65Grid/F-Log2/` (personal, noncommercial use; keep it out of git) |
| `arri/` | ALEXA 35 REVEAL, ALEXA Classic | LogC4, LogC3 EI800 | ARRI's LogC4 and LogC3 LUT packages (arri.com, Color › LUTs): the Rec709 D65 gamma 2.4 files |
| `sony/` | s709, Cool, Teal & orange, Vintage, Warm | S-Log3 / S-Gamut3.Cine | [s709Cubes.zip](https://www.sony.jp/ls-camera/knowledge/data/s709Cubes.zip), [NewCubes.zip](https://www.sony.jp/ls-camera/knowledge/data/NewCubes.zip) |
| `opendrt/` | Default, Colorful, Umbra | its own OCIO config | [OpenDRT v1.0.0 mini config](https://github.com/jedypod/open-display-transform/releases/tag/v1.0.0) (MIT), unzipped whole |

Every base takes the profile's own code values, read as limited range (the default; the P4P README's advice to read
full range lifts blacks). DJI's own LUTs agree: read as limited, D-Log2 and D-Log both put 18% grey at 0.414, and
P4P Neutral shares the D-Log2 tone curve exactly.

## How the preview stays honest

`color.mjs` is shared by the browser and the export: a clip's grade becomes one LUT built by the same function in
both, sampled live on the GPU over a small proxy of the clip's own code values, and baked by ffmpeg from the
original. Deflicker is the one step outside the LUT: it needs the frames around each one, so only the export does
it. On startup the browser decodes a grey ramp encoded like the proxies and compares it with ffmpeg; a decoder
that lands more than 1.5 levels off gets corrected. `node scripts/check-grade.mjs` (not in CI; it needs WebGL; pass
`CHROMIUM_PATH` and optionally `SCREENSHOT_DIR`) grades a synthetic clip, exports it and a frame of it, and checks
both against the preview: mean 0.6 and 0.5 of 255, 95% within 2. It also sets Deflicker through the panel.

## Into OpenFilm

Edit with the files in `~/Movies/Exported/`: the originals may only exist on the camera. `exports.json` says what
each was made with; a clip is current when its record's `key` matches `gradeKey(resolveGrade(grades.json's entry))`,
which the app shows as "graded" and otherwise as "changed since export". A clip graded in the app but never exported
shows as "grade not exported"; one with no export and the starting grade shows as "not graded". Regrading and exporting
again replaces the file under the same name, so trims and captions in a film stay valid.
