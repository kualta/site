---
name: openfilm
description: Make videos as web pages with OpenFilm. Use when the user asks for a video, motion graphics, an animation, a launch film, an explainer, a music video, to edit, cut, check or render a film (film.html and pages with window.film), to caption or subtitle one, or to open OpenFilm or its Studio. Also use when the person approves a film: says it's good, approves it or LGTMs it.
---

# OpenFilm

Run `npx -y openfilm@latest` and follow the manual it prints: it is the whole of OpenFilm, about a thousand words. Run it
again whenever you need it.

## Project folders: numbered, both languages in one

Every film is a piece in the post app's Pipeline (post.kualta.dev/pipeline), and its folder in
`~/Movies/OpenFilm/Projects` is named `NNN-slug`: the piece's number in three digits, then its title in lowercase words
joined by hyphens (`013-maybe-later`). The post app numbers each piece when it's made (its card shows `017 · Title`),
so never choose a number yourself. Start a film from its piece:

    node ~/Projects/site/scripts/publisher/cli.mjs film 17

It makes the folder with OpenFilm's `open` and prints Studio's address; a folder with that number already on the laptop
opens as it is. A film with no piece yet gets one first, at Footage ready, then its folder:

    node ~/Projects/site/scripts/publisher/cli.mjs film new "<title>"

When it's unclear which piece a film is, ask rather than make a second one. Pieces that never become films leave gaps
in the folders' numbers. Open an existing film by its full path,
`npx -y openfilm@latest open ~/Movies/OpenFilm/Projects/NNN-slug`, not by a bare name.

- The folder is the original film, and it's the one Studio lists in its projects.
- Its Chinese version is the project in its `zh/` subfolder (the `openfilm-chinese` skill makes it). Studio lists only
  top-level folders, so it opens the Chinese version by its path, and keeps it under recents.
- Both renders sit in the film's folder: `bun run film render <film> --loudness=-14` (in `~/Projects/site`) writes
  `<film>/NNN-slug.mp4`, and `bun run film render <film> --zh --subtitles --loudness=-14` writes `NNN-slug-zh.mp4`
  from `zh/`. A film with no camera clips can still render with `npx -y openfilm@latest render`.
- A folder's project id lives in `.film/id`, so moving or renaming a project keeps its history. Rename one only while
  nothing remains at the old path, and point `~/.openfilm/studio.json`'s `recent` entries at the new path.
- A finished project is archived (see below) and can come back whole:
  `node ~/Projects/site/scripts/publisher/cli.mjs restore NNN-slug` restores it into this folder if it's gone, and
  `… archives` lists what's archived. A project still on the laptop whose `.film/cache` is missing was archived; Studio
  makes the cache again when it opens. Once its post is out, a project comes off the laptop (see "Once it's posted")
  and lives only in the archive.

## The frame is the footage's own size

A film's frame is its footage's pixel size, never OpenFilm's default stage. `open` makes a new film at 1920 × 1080,
and a film copied from an earlier one carries that film's frame. Before the first write, set the viewport `<meta>` to
the main footage's size from `ffprobe` (width × height, swapped when the stream is rotated 90°). The Pocket 4P's
vertical clips are 1728 × 3072. Every clip then fills the frame pixel for pixel, with nothing scaled before the
render. If the footage comes in mixed sizes, take the size most of it has, and crop the rest to fill the frame with
`object-fit: cover`.

Sizes in this skill are px on a 1080-wide frame. The kinetic captions page scales itself to the frame, so its
`captions.json` stays in 1080-wide px. A page of your own lays out at the frame's size: multiply its px by the
frame's width ÷ 1080 (×1.6 at 1728).

## Camera footage in log: cut on graded previews, render from graded trims

The person's Pocket 4P footage is often D-Log2, D-Log or HLG (the file's `com.dji.camera.ColorGammaSxS` tag says
which). Cut as it is, it stays flat and grey. They grade it in the grade app (http://127.0.0.1:4777, the Grade tab at
post.kualta.dev; see `scripts/grade/README.md` in `~/Projects/site`), which reads clips off the camera's card or from
`~/Movies/Original/`. There are no graded copies of whole clips any more: a film's
`assets/` holds small graded **preview copies** (1920 px on the long side) while it's cut, and the render grades only
the seconds the film uses, as full-quality **trims**. `bun run film` in `~/Projects/site` does both; always give it
the film's path.

- In `film.html`, a camera clip is `assets/<clip name without extension>.mp4` (`assets/DJI_20261122161011_0353_D.mp4`).
  To get the files: `bun run film previews <film>` asks the grade app for each such clip's preview copy and clones it
  into `assets/` under that name (in `zh/` too). A clip already there moves into `assets/.originals/`; never delete
  those. To look at clips before choosing them, ask for their previews directly (`POST
  http://127.0.0.1:4777/api/previews` with header `X-Grade: 1` and `{"names": ["<clip>.MP4", …]}`, then
  `GET /api/previews?names=…` until each is `ready`) and clone `~/Library/Caches/Grade/previews/<stem>.mp4` in with
  `cp -c`.
- After a regrade, run `bun run film previews <film>` again, or keep `bun run film previews <film> --watch` running
  while the person grades. Studio picks up the new copy by itself.
- `bun run film status <film>` says which clips are current, graded again since, still originals, or only in the
  cloud. A clip only in the cloud has to come back first: ask the person to use Bring to Mac in the grade app
  (Clips from → Cloud → its day). Never fetch it yourself.
- The frame is still the footage's size: probe the original clip (card, `~/Movies/Original/` or
  `assets/.originals/`), not the smaller preview.
- Render with `bun run film render <film> --loudness=-14` instead of `openfilm render`. It asks the grade app for
  trims of just the seconds the film plays, renders a copy of the film pointed at them, and writes
  `<film>/NNN-slug.mp4` at the footage's frame rate and size; the film's folder isn't otherwise touched. The clips
  must be on the Mac or the camera. A trim that fails stops it with the reason; if OpenFilm stops midway, run it
  again and it resumes.
- `look` and Studio show the previews: judge focus and fine detail on the render.

## Start from the clips' transcripts

The grade app transcribes every camera clip on the Mac in the background (Whisper large-v3-turbo, word times on), so
read what's said before choosing lines, and don't run Whisper on a clip that has a transcript. Each clip has two files
in `~/Library/Application Support/Grade/transcripts/<shoot day>/<clip name without extension>` (find one with
`…/transcripts/*/<clip name without extension>.json`: an iPhone clip's day is its file's date):

- `.vtt`: the lines with their times, to read and search (`grep -ril "phrase" …/transcripts/`).
- `.json`: `{ clip, day, language, text, segments: [{ start, end, text, words: [{ word, start, end, probability }] }] }`,
  times in seconds from the clip's start.

A clip already offloaded has its transcript in the cloud too, beside its original. Ask the person to Bring it to the Mac
if you need the clip itself. Whisper's word times run early on street audio, so use them to find the lines, then place
every cut by forced alignment and the waveform as below. Only when a clip has no transcript yet (it was just copied,
or it's still in the queue) transcribe it yourself.

## Cutting speech: mix each cut into the next

A film cut from trims of one recording (a talk cut down to its best lines) hard-switches its sound at every cut, and the room tone jumps. From the first build, give every cut a tiny crossfade instead, about 50 ms, while the picture keeps its hard cut:

- The footage clips stay on their track for the picture, with `volume="0"`.
- Each trim's sound is an `<audio>` of the same file and trim (an `<audio>` of a video file is its sound alone), on two tracks under the footage, alternating, so neighbours can overlap.
- Each sound reaches 25 ms past its cut into the pause, and the next starts 25 ms early. Both fade over the whole 50 ms overlap with `overrides='[{"fade":[in,out]}]'`. Use 10 ms at the film's start and 30 ms at its end. Where the next or previous word sits closer than 25 ms to the cut, shrink that side's reach so no syllable leaks in.
- Don't fade the `<video>` clips themselves: a clip's fade ramps its picture's opacity too, and darkens the frames at every cut.
- Subtitles come only from clips that can be heard, so they now come from the `<audio>` clips. A line belongs to every heard clip whose trim holds its first word, so no word may start inside another clip's 25 ms reach, or its line shows twice.

```html
<section>
  <video id="a" src="assets/talk.mov#t=12.400,15.100" at="0" volume="0"></video>
  <video id="b" src="assets/talk.mov#t=18.200,20.000" at="2.7" volume="0"></video>
</section>
<section>
  <audio id="a-sound" src="assets/talk.mov#t=12.400,15.125" at="0" overrides='[{"fade":[0.01,0.05]}]'></audio>
</section>
<section>
  <audio id="b-sound" src="assets/talk.mov#t=18.175,20.000" at="2.675" overrides='[{"fade":[0.05,0.03]}]'></audio>
</section>
```

Cuts still go in pauses. A pause in the speech band (300–4000 Hz) can still hold an s, z, sh or f at a word's edge, so check 3.5–8 kHz at every edge too.

Where the speaker runs on without a pause ("are you still able to or you…"), the last word you keep has no silence after it, and an out set by the energy envelope can land mid-vowel. The person hears it as "cuts off too early." Find that word's end by forced-aligning a span that includes the next few words, with their text. An alignment that stops at the cut, or a whisper read-back of audio cut there, can't show it: the aligner squeezes the word into what it's given, and whisper fills in or drops a partial last word. Put the out after the word's end, and end the fade before the next word starts.

A cut from a question to its answer needs a beat. When nothing quiet sits right before the answer to cut in, open the answering shot earlier, over its own room tone. Fill the sound past any filler ("and", "uh") with a slice of that same tone, and keep the answer's sound in sync with its picture.

## Kinetic captions

For a talking film, the person wants kinetic, editorial captions, not one subtitle line at a time. Their rules:

- **Phrases as stacked blocks.** Each phrase stacks its words on 2–3 lines, left-, center- or right-aligned, in different sizes. Small connector words ("and", "the", "is", "of", "if you") go small. The phrase's key word goes big.
- **Two fonts.** A heavy sans in capitals for most words. An italic serif in lowercase for the one or two emphasis words per phrase, chosen by meaning ("BORING", "space").
- **Yellow only on emphasis words** (`#ffd400`), never on every spoken word. Every other word is white.
- **Placement.** Vary the block's place from phrase to phrase (upper third, lower third, left, right), but never over the speaker's face. Keep at least 80 px from the frame's edges.
- **Timing.** Each word appears exactly when it is spoken. The entrance is snappy, not mellow: a word rises 0.2 em into place over 0.2 s and fades in over 0.1 s, from a 3 px blur that clears in 0.08 s. The rise uses a critically damped curve, `1 − (1 + kx)e^(−kx)` with k = 8 and normalised, so it starts fast and settles without overshoot. An emphasis word also grows in from 0.8 scale over 0.28 s. A finished phrase lifts 14 px and fades in 0.12 s as the next one appears.
- **Punctuation is always its own element.** A word's trailing marks (. , ! ? … : ; —) pop in when the word ends, not when it appears. Take the aligner's word end, else 0.3 s after the word starts, and never after the next word. Each mark drops in slightly from above and grows from 0.3 scale over 0.18 s. The dots of "..." come in one by one. A mark sits where its font puts it, with no extra gap after an italic word.
- **Size and outline.** Make the words big. On a 1080-wide frame: small 68 px, medium 115, large 165, extra large 215. The outline is thick and the same width on every word whatever its size: 14 px of 75% black, painted under the letters, so 7 px shows. Don't use an em-based outline, which grows with the word.
- **No collisions, natural spacing.** Space the lines from each word's measured ink (canvas `measureText`, `actualBoundingBoxAscent` and `actualBoundingBoxDescent`), not from line-height. An italic p's or g's tail must clear the next line. Between lines, leave 12% of the smaller line's size plus the full outline. Between words, leave 12% of the two words' average size plus the full outline, so outlines never touch.
- **Fitting.** A block too wide for its room shrinks whole. Pick sizes so a long key word fits (a 12-letter word at medium, not large), or the whole phrase shrinks with it.

Chinese captions (for a film's Chinese version) follow the same rules, plus the person's own:

- **Vertical where it fits.** Set a phrase top to bottom wherever a tall, narrow space is free: typically the frame's edge beside the speaker, or below her face. Its lines become columns read right to left (`writing-mode: vertical-rl`, characters upright). Leave punctuation out of a vertical phrase: in a column it looks wrong, so the page drops a vertical phrase's marks (horizontal Chinese keeps them, popping in on their own). Anchor a vertical block to the edge it sits on. Alternate vertical and horizontal phrases through the film.
- **A strict grid.** Chinese characters are square, so lay them on a grid of square cells. Every size is a multiple of one unit (60 px on a 1080-wide frame: 60, 120, 180, 240). Characters touch their em boxes along a line, with no gaps between chunks. Lines or columns are one fixed gutter apart (18 px), and line-height is 1. Horizontal lines align on the bottom of their boxes, and vertical columns on their center line. Don't measure ink, as you do for Latin text.
- **Faces and wording.** For most words, use a heavy Chinese sans (PingFang SC 600). For emphasis words, use a heavy Song serif in yellow (Songti SC 900). Chinese has no italics or capitals. Write the phrase the way a Chinese creator would say it, ordered to follow the speech. Time each chunk to the original word it stands for, so chunks appear in spoken order, and keep the original phrase's place and timing.

How in OpenFilm:

- Studio's own subtitles can't do this. They offer only a linear whole-line fade and a color, box or static "pop" on the word being said. So the captions are a page: copy `kinetic-captions/captions.html` and its two fonts (Inter Tight 900, Fraunces Italic 700, both OFL) from this skill's folder beside film.html. Put it on the top track: `<iframe id="captions" src="captions.html#t=0,<film length>"></iframe>`.
- The page reads `captions.json` beside it: one entry per phrase, with its place (`left`/`right`, `top`/`bottom` in px, `align`), `start` and `end` in film seconds, and `lines` of words (`text`, `t` and `end` in film seconds, `size` in px, `em`). See `kinetic-captions/example-captions.json`. Write it from the transcript VTT's word times, mapped through each clip's trim and `at`. The VTT stays the source of the words. The person's word fixes go into it, then the JSON is rebuilt.
- Turn Studio's subtitles off for that project (`"on": false` in `.film/subtitles.json`), or every line shows twice. Tell the person that Studio's subtitle panel no longer drives the captions.
- For a Chinese version, set `<html lang="zh">` in its copy of `captions.html`. The page then switches to the Chinese faces, the grid and vertical phrases. Write its `captions.json` with `kinetic-captions/zh_captions.py`, from the original's file and a spec of Chinese chunks, each anchored to an original word and with optional `{"vertical": True, "right": 80, "top": 680}` place changes per phrase. Write the `.zh.vtt` the `openfilm-chinese` skill asks for too; the script does it, on the source file's time.
- OpenFilm 0.3.0 adds a caption track (`<track kind="captions">`, SPEC: Captions) when it opens a project that has subtitle settings, a new Chinese copy for instance. That track draws its own captions over the page's. Mark its `<section hidden>` rather than deleting it, because Studio's merge would put a deleted track back. (A caption track can style cues with CSS and per-word timestamps, but it's untested for this look; the page is the proven way.)
- Word times come from forced alignment, and on noisy audio the aligner can slip a whole word late. The person notices: "time appears a bit too late." Compare every caption word with an independent transcription and the speech-energy envelope. Pin any word more than 0.3 s off to the burst of sound it is really in.
- Check a frame with `look` at the end of each phrase, when all its words show. Make sure no block covers the face and none runs into an edge. A face moves between shots: when a cut moves the face under a block, end that block before the cut. Also check one stretch frame by frame to see the motion.
- Studio merges an agent's write with the person's edits. If it brings back a clip you removed (it took your write for an older copy), run an `openfilm` command, which reports what it kept, and write again.

## When the person approves the film

When the person says the film is good, approves it or LGTMs it, and nothing is left to change, get it ready to post without asking what's next. Approval is the request for the files and the post.

1. Make its Chinese version with the `openfilm-chinese` skill and follow that skill to the end. It renders the Chinese version, then follows `crosspost-video`, which renders the original if needed, writes every field itself and opens post.kualta.dev with both versions prefilled.
2. Archive the project, with its Chinese version in `zh/`:
   `node ~/Projects/site/scripts/publisher/cli.mjs archive ~/Movies/OpenFilm/Projects/NNN-slug`. It sends the files the
   archive doesn't hold yet, keeps a manifest once every file is there, and then deletes Studio's `.film/cache`. If
   it fails, say so in the report; the post doesn't depend on it.
3. Give the person the link. Publish is theirs to click: never click it or queue the post for them. Once they've
   published or scheduled it, the film comes off the laptop (next section).

If the person changes the film after it's archived, archive it again once the change is done: only what changed goes
up.

Praise for one part while changes remain isn't approval: keep working on the film.

## Once it's posted: take it off the laptop

A posted film's project and the clips it was cut from don't stay on the laptop. When the person says a film is posted
or scheduled, and when you start a new film, run:

    node ~/Projects/site/scripts/publisher/cli.mjs cleanup --all

For each project in `~/Movies/OpenFilm/Projects`, it checks that the render `NNN-slug.mp4` is the video of a post that
published or is scheduled (a draft sends the render up unchanged, so the publisher finds it by its MD5), or that piece
NNN went out as such a post. Then it
archives the project again (only what changed goes up) and deletes the project. A film it can't confirm stays, with
the reason: nothing goes that the archive doesn't hold. The camera originals aren't the project's: they stay in
`~/Movies/Original/` until the grade app's Mac → Cloud offload files them in the cloud. (Films from before graded
trims also had whole graded clips in `~/Movies/Exported`; cleanup deletes those once the archive holds their bytes.
No new film makes any.)

- `cleanup ~/Movies/OpenFilm/Projects/NNN-slug` does one film, and `--dry-run` says what would go.
- A film whose piece wasn't posted from the composer, and whose render isn't its post's video (posted from a Studio
  export, or rendered again after its draft), can't be matched to its post. `--posted` vouches for one named film:
  pass it only when the person says that film is out.
- `restore NNN-slug` brings a project back whole, its clips included.
