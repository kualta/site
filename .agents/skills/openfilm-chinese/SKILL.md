---
name: openfilm-chinese
description: Make the version of an OpenFilm film for Chinese audiences, with its on-screen text and subtitles or voice in Simplified Chinese, then send both versions to the crossposter so Xiaohongshu gets the Chinese one and every other platform the original. Use for /openfilm-chinese, when asked for a Chinese version, translation or localisation of a film or video, or as soon as the person approves a finished OpenFilm film: says it's good, approves it or LGTMs it.
---

# A film's Chinese version

The Chinese version is a film of its own, in a folder beside the original, so the original never changes and the person can edit either in Studio. The result is two videos and a link to the composer. The person clicks Publish there. Never click it or queue the post for them.

Run `npx -y openfilm@latest` first and follow the manual it prints.

## 1. Find the film

Take the first that applies:
- A path the person named.
- The film this conversation worked on.
- The nearest folder above the working directory holding `film.html`.
- `recent[0].path` in `~/.openfilm/studio.json`, the film last opened in Studio.

`<film>` is its folder and `<name>` the folder's name.

## 2. Make the copy

If `<film>-zh` already exists, it's the person's: they may have edited it in Studio. Don't copy over it. Read it, and change only what the original's changes or this request call for.

Otherwise, copy it. `-c` clones the media without using disk, and `-p` keeps file times, which is how OpenFilm knows a transcript still matches its media.

    cp -cRp <film> <film>-zh
    rm -rf <film>-zh/.film <film>-zh/<name>.mp4

## 3. Translate what's on screen

Read `film.html` and every page. Words live in two places, and `overrides` wins:
- The text in the pages.
- `text` in `overrides` entries in `film.html`, the person's edits in Studio. Translate only the `text` and keep the rest of each entry.

Write it the way Chinese creators would say it, not word for word. Slang gets Chinese slang of the same register, and what the person said about the film in this conversation outranks your reading of it.

A Latin web font has no Chinese glyphs, so add these after it in each `font-family`: `"PingFang SC", "Hiragino Sans GB", "Noto Sans SC"`. Then lay the words out again:
- Break lines where the Chinese sentence breaks, with `<br>`, rather than where the English did.
- Check anything with `white-space: nowrap` or a fixed width.
- Remove `letter-spacing`, `text-transform` and `italic`, which Chinese doesn't use.

Xiaohongshu limits apply to the picture too. Remove links, @handles, QR codes, watermarks and the names of other platforms, and avoid superlatives such as 最, 第一, 顶级, 唯一.

Words inside footage or a picture can't be translated in place. Leave a logo. Remake a picture that a page could draw. Otherwise tell the person in your report.

## 4. Translate what's said

Music and lyrics stay. For each voice in the film:

**A person's recorded voice stays, with Chinese subtitles,** unless they ask for a dub. Beside each `<clip>.vtt`, write `<clip>.zh.vtt`: the same lines at the same times, in Chinese. Speech with no transcript needs `npx -y openfilm@latest get asr`; if no service is connected for it, tell the person which ones make it. Never draw subtitles in a page.

Then pick the language, the one file in `.film` to write here, since a new folder has no other way to set it. Copy `<film>/.film/subtitles.json` to `<film>-zh/.film/subtitles.json` if it exists, to keep the person's look, and set `"language": "zh"`. Without one, write `{ "language": "zh" }`.

**Narration made with `get tts`, under `assets/audio/vo`, is spoken again in Chinese.** Find a voice with `get voice --language zh`, then run `get tts --text … --voice …` for each line. Chinese runs a different length, so move the clips around it to keep each line with its picture, and any sound effects with them. If no voice-over service is connected, use subtitles and say so.

## 5. Open, check and render

In `<film>-zh`:

    npx -y openfilm@latest open .
    npx -y openfilm@latest look

Look at every moment with words: no empty boxes where glyphs are missing, nothing cut off or overflowing. `look <seconds>` shows one frame at full size.

Then render it, with `--subtitles` if step 4 wrote any:

    npx -y openfilm@latest render --subtitles

That writes `<film>-zh/<name>-zh.mp4`. If the person exports from Studio instead, use that file.

## 6. Send both versions

Follow the `crosspost-video` skill for `<film>`. It finds this version by its folder name and sends it as `zh.video`.

## 7. Report

Give the link, the Chinese video's path, what you translated and how the voice was handled, and anything left in another language, such as words inside footage.
