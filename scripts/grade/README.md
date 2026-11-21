# Grade

A local app for grading camera footage in bulk before it goes into OpenFilm: pick a look, set exposure, white
balance, tint, contrast and saturation across many clips at once, watch it live, and export graded copies when it
looks right.

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

**Clips from** (top bar) lists shoot days from two places:

- **Pocket 4P**: the camera's card while it's plugged in (`/Volumes/Pocket4P/DCIM`, `GRADE_CAMERA`), by the date in
  each DJI file name. Clips stay on the card: nothing is copied off it, and nothing is written to it except by ⌘⌫
  (below). Thumbnails come from the still each DJI file carries; a clip's preview is made from the card when you
  select it.
- **On this Mac**: the video in `~/Movies/Original/`, for clips that aren't on the camera, by the date in a DJI name
  or else the file's own date.

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
  luts/                                   GRADE_LUTS: base looks (below)
~/Library/Caches/Grade/                   GRADE_CACHE: metadata, thumbnails, previews; safe to delete
```

Clips are known by file name, so a clip graded off the card and the same clip copied into `Original/` share one grade
and one export. An export put in `Exported/` by hand counts as graded too.

## The ledger

**Ledger** (top bar) lists every clip the app has ever seen, newest day first, with its profile, its grade, and where
its copies are: the original on the camera, on this Mac (`Original/`) or in the Cloudflare archive, and the graded
copy on this Mac (`Exported/`), in the Cloudflare archive or on YouTube. The selected clip's panel says the same in a
line. Filters pick out clips **at risk** (no copy off this Mac and the card: nothing in Cloudflare or on YouTube), not
graded (log footage without a graded copy), not on YouTube and not in Cloudflare. A clip with no copy left anywhere
says so. Esc closes it.

The server looks every 30 seconds (and after an export or ⌘⌫) and merges what it sees into what it knew, so a clip
off the card or the Mac keeps its record. What it can't look at keeps its last answer: the card's clips while it's
unplugged (the table says as of when), and the archive between askings (every 10 minutes). The sources:

- the card and `Original/`, and each clip's profile from its metadata (clips not yet probed are probed a few at a
  time, none while an export reads the card);
- `grades.json`, `exports.json` and `Exported/`;
- YouTube: the crossposter helper's `.publisher/footage.json` in this checkout (`GRADE_PUBLISHER` names the folder),
  what the footage archive put up;
- Cloudflare: the archive's film projects, each manifest read once per archiving. A file of a clip's that's the
  original's size is the original; any other is a graded copy, the current one when it's the export's size (the same
  goes for YouTube).

`ledger.json` is the ledger as last merged. Whenever anything in it changes it's sent whole to the site's archive
(`ledger/footage.json`, through `helper/archive/ledger` on the helper's pairing), but only once the archive's copy has
been read back and merged in, so a fresh `ledger.json` on a new Mac can't drop clips only the archive knows. Without a
paired helper the ledger stays on this Mac, and the table says so.

## Grading

- **Look**: the base look for the clip's camera profile, read from its own metadata tag. D-Log2, D-Log and HLG get
  the ACES conversions (from DJI's curve math, out through ACES 2.0 or 1.0), ARRI, AgX, OpenDRT, Fujifilm film
  simulations and Sony looks; D-Log2 and D-Log also get DJI's own Rec.709 LUTs, and D-Log2 the twelve P4P looks.
  Rec.709 clips are graded as shot. A new clip starts on ACES 2.0.
- **Exposure** in stops, **Temperature** in Kelvin (as if the camera had been set to it; it starts at the camera's
  own), **Tint** (+ magenta, − green), **Contrast** around 18% grey, **Saturation**. All of it happens in scene
  linear light before the look.
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
original. On startup the browser decodes a grey ramp encoded like the proxies and compares it with ffmpeg; a decoder
that lands more than 1.5 levels off gets corrected. `node scripts/check-grade.mjs` (not in CI; it needs WebGL; pass
`CHROMIUM_PATH` and optionally `SCREENSHOT_DIR`) grades a synthetic clip, exports it and a frame of it, and checks
both against the preview: mean 0.6 and 0.5 of 255, 95% within 2.

## Into OpenFilm

Edit with the files in `~/Movies/Exported/`: the originals may only exist on the camera. `exports.json` says what
each was made with; a clip is current when its record's `key` matches `gradeKey(resolveGrade(grades.json's entry))`,
which the app shows as "graded" and otherwise as "changed since export". A clip graded in the app but never exported
shows as "grade not exported"; one with no export and the starting grade shows as "not graded". Regrading and exporting
again replaces the file under the same name, so trims and captions in a film stay valid.
