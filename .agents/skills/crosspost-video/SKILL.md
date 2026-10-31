---
name: crosspost-video
description: Send a finished video, usually an OpenFilm film, to the crossposter at post.kualta.dev with its title, caption, tags and Chinese version already written, so the owner only has to click Publish. Use for /crosspost-video, or when asked to crosspost, post or share a film or video to the socials. It never publishes by itself.
---

# Crosspost a video

The result is a link to the composer with the video attached and every field filled. The person clicks Publish there. Never click it or queue the post for them, even with browser tools available.

## 1. Find the film

Take the first that applies:
- A path the person named. If it's a video rather than a film, skip to step 3.
- The film this conversation worked on.
- The nearest folder above the working directory holding `film.html`.
- `recent[0].path` in `~/.openfilm/studio.json`, the film last opened in Studio.

## 2. Find the final video

Candidates, where `<name>` is the film's folder name:
- `<film>/<name>.mp4`, from `openfilm render`. Each render overwrites it.
- `~/Desktop/<name>*` (`.mp4`, `.mov`, `.webm`), from a Studio export, named like `<name> 9x16 1080p.mp4`. Exports go to whichever folder was chosen for that export, so a file the person points at always wins.

A candidate is fresh when this prints nothing:

    find <film> -type f -newer <video> -not -path '*/.film/*' -not -path '<film>/<name>.mp4' -not -name .DS_Store

Take the newest fresh candidate. If a fresh 9x16 export and a wider one both exist, take the 9x16 for a film up to three minutes.

If none is fresh, run `npx -y openfilm@latest render` in the film's folder: being asked to post the film is being asked for the file. Say in your report that you rendered it.

## 3. See what it is

Look at the file being posted. With `<n>` as its length in seconds divided by 16:

    ffmpeg -v error -i <video> -vf "fps=1/<n>,scale=480:-1,tile=4x4" -frames:v 1 <tmp>/sheet.jpg

Read the sheet. For a film, also read the text in its pages and any speech in `assets/**/*.vtt`. What the person said about the film in this conversation outranks anything you infer.

## 4. Write post.json

Put it in a temp folder, not in the film's folder, which Studio shows to the person.

    {
      "video": "/absolute/path/to/final.mp4",
      "title": "…",
      "caption": "…",
      "short": "…",
      "alt": "…",
      "tags": ["film", "motion"],
      "zh": { "title": "…", "text": "…", "topics": ["短片", "动画"] }
    }

Use the person's own words wherever they gave them. Otherwise write plainly: say what the film is, with no hype, calls to action or "excited to share". Invent nothing: no credits, claims or release details you can't see.

- `title`: up to 100 characters. Goes to YouTube.
- `caption`: goes to Instagram, TikTok and YouTube's description. No hashtags: `tags` adds them.
- `short`: goes to X and Bluesky instead of the caption. Needed when the caption passes 280 on X (emoji and CJK count 2, links 23) or 300 on Bluesky. Otherwise leave it out.
- `alt`: what's on screen, for screen readers on Bluesky. Up to 1,000 characters.
- `tags`: without `#`, most important first; letters, digits and `_`. Instagram and TikTok show 5, YouTube 3, Bluesky hides 8, X none.
- No `<` or `>` in the title or caption: YouTube refuses them.
- `preset` (optional): the tab to open on. Without it, films up to three minutes open on Short-form video (`short`) and longer ones on Long video (`video`).

`zh` is always required, for Xiaohongshu. Follow the same rules as the composer's Translate button:
- Natural Simplified Chinese the way Xiaohongshu creators write. Adapt, don't translate word for word.
- `title`: at most 20 Chinese characters, a Latin letter counting half. Main keyword first, at most one emoji.
- `text`: at most 900 characters in short paragraphs, the main keyword in the first sentence.
- No links, phone numbers, email addresses, @handles, QR codes, or names of other platforms. No superlatives such as 最, 第一, 顶级, 唯一.
- `topics`: 3 to 5 short Chinese topics people search on Xiaohongshu, without `#`, most specific first.
- Keep names of people, places and brands recognisable.

## 5. Send it

    node ~/Projects/site/scripts/publisher/cli.mjs draft <post.json>

It prints the link. Then run `open <link>`.

The text is checked against every video destination before the video uploads. An error names what to fix, such as `Bluesky: text is 350/300`: fix `post.json` and run it again.

A video over the 90 MB upload limit is re-encoded to fit. One too long to stay watchable at that size fails and says so: tell the person, since it needs a shorter cut.

`Connect the helper first` means the person has to run `bun run publisher connect` in `~/Projects/site`.

## 6. Report

Give the link, which video file you sent, whether you rendered or re-encoded it, and the title and caption as written. Mention that destinations and YouTube visibility come from the preset saved in the person's browser, and that the draft expires after seven days.
