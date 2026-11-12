# Grade

A local app for grading camera footage in bulk before it goes into OpenFilm: pick a look, set exposure, white
balance, tint, contrast and saturation across many clips at once, watch it live, and export graded copies when it
looks right.

```sh
bun run grade          # http://127.0.0.1:4777, opens in the browser
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
  luts/                                   GRADE_LUTS: base looks (below)
~/Library/Caches/Grade/                   GRADE_CACHE: metadata, thumbnails, previews; safe to delete
```

Clips are known by file name, so a clip graded off the card and the same clip copied into `Original/` share one grade
and one export. An export put in `Exported/` by hand counts as graded too.

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
which the app shows as "graded" and otherwise as "changed since export". Regrading and exporting again replaces the
file under the same name, so trims and captions in a film stay valid.
