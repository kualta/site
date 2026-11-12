# Grade

A local app for grading camera footage in bulk before it goes into OpenFilm: pick a look, set exposure, white
balance, tint, contrast and saturation across many clips at once, watch it live, and export graded copies when it
looks right.

```sh
bun run grade          # http://127.0.0.1:4777, opens in the browser
```

## Where clips come from

**Clips from** (top bar) lists two kinds of folder:

- **Pocket 4P**: the camera's card while it's plugged in (`/Volumes/Pocket4P/DCIM`, `GRADE_CAMERA`), one folder per
  shoot day, read from the date in each DJI file name. Clips stay on the card: nothing is copied off it, and nothing
  is written to it. Thumbnails come from the still each DJI file carries; a clip's preview is made from the card
  when you select it.
- **On this Mac**: any `<root>/<folder>/originals/` with video in it, for clips that aren't on the camera.

Each folder shows how many of its clips have a graded copy, and the clip list can show only graded or ungraded clips.

## What the app writes

```
~/Movies/Pocket4P/                  GRADE_ROOT
  luts/                             GRADE_LUTS: base looks (below)
  2026-11-08/                       a shoot day (or a Mac folder's name)
    grades.json                     each clip's grade, saved as you work
    graded/DJI_…_0234_D.mp4         the export: 8-bit H.264 BT.709, near lossless, sound copied
    graded/DJI_…_0234_D.grade.json  what was applied: source, base, grade, key, LUT, camera white balance
    graded/luts/DJI_…_0234_D.cube   the exact LUT the export used
    .grade/                         the app's cache: preview proxies, thumbnails, probed metadata
```

A camera day and a Mac folder with the same name share this folder, so a clip graded off the card and the same
clip copied to the Mac share one grade and one export. A graded file put in `graded/` by hand counts as graded too.

## Grading

- **Look**: the base look for the clip's camera profile, read from its own metadata tag. D-Log2, D-Log and HLG get
  the ACES conversion (from DJI's curve math, out through ACES 2.0 SDR Rec.709); D-Log2 also gets the twelve P4P
  looks. Rec.709 clips are graded as shot.
- **Exposure** in stops, **Temperature** in Kelvin (as if the camera had been set to it; it starts at the camera's
  own), **Tint** (+ magenta, − green), **Contrast** around 18% grey, **Saturation**. All of it happens in scene
  linear light before the look.
- Select several clips (⌘-click, shift-click, Select all) and a change sets that control on all of them. Copy grade /
  Paste copies a whole grade.
- **Split** and **Original** compare against the flat original; hold **B** to flash it. Space plays, ↑ ↓ change clip.
- The preview plays the original itself at full resolution (streamed off the card), so focus and detail are as shot.
  It is still 8-bit on screen, because Chrome hands video to WebGL at 8 bits even from a 10-bit file, so judge banding
  on an export. HLG clips play a 1280 px preview copy instead, so the browser can't tone-map them.
  **Full screen** (or **F**) gives the viewer and its transport the whole screen.
- **Export this clip / Export N selected** bakes the selection; **Re-export N changed** bakes every graded clip whose
  grade moved since its export. Exports come from the 10-bit originals (off the card, for a camera day) at 16-bit
  precision, not from the preview. A camera day can't export while the camera is unplugged. Exporting more than ten
  clips at once asks for a second click; **Stop exporting** (top bar, while anything exports) drops the queue and
  stops the clip in progress, which leaves its previous export, LUT and record as they were.

## Base looks (`luts/`)

| File | Made by |
| --- | --- |
| `dlog2-to-rec709-aces2.cube`, `dlog-…`, `hlg-…` | `uv run --with opencolorio --with numpy scripts/grade/make_luts.py ~/Movies/Pocket4P/luts` |
| `p4p/P4P_01_Neutral_size65.cube` … `P4P_12_Punch_…` | [Codebater/pocket4-luts](https://github.com/Codebater/pocket4-luts) (CC BY 4.0), D-Log2 only |
| `custom/<dlog2\|dlog\|hlg\|rec709>/*.cube` | your own; each shows up as a look for that profile |

Every base takes the profile's own code values, read as limited range (the default; the P4P README's advice to read
full range lifts blacks).

## How the preview stays honest

`color.mjs` is shared by the browser and the export: a clip's grade becomes one LUT built by the same function in
both, sampled live on the GPU over a small proxy of the clip's own code values, and baked by ffmpeg from the
original. On startup the browser decodes a grey ramp encoded like the proxies and compares it with ffmpeg; a decoder
that lands more than 1.5 levels off gets corrected. `node scripts/check-grade.mjs` (not in CI; it needs WebGL; pass
`CHROMIUM_PATH` and optionally `SCREENSHOT_DIR`) grades a synthetic clip, exports it, and checks the export against
the preview: mean 0.8 of 255, 95% within 2.4.

## Into OpenFilm

Edit with the files in `~/Movies/Pocket4P/<day>/graded/`: the originals may only exist on the camera. Each
`.grade.json` says what was applied; a clip is current when its `key` matches `gradeKey(resolveGrade(grades.json's
entry))`, which the app shows as "graded" and otherwise as "changed since export". Regrading and exporting again
replaces the file under the same name, so trims and captions in a film stay valid.
