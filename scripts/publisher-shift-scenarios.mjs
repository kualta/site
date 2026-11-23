/** What the post app is put through to see that nothing on it moves by itself (publisher-shifts.mjs runs these). */

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const draftId = "00000000-0000-4000-8000-00000000d1af";
const chineseDraftId = "00000000-0000-4000-8000-00000000d1b0";
const linkedPiece = "00000000-0000-4000-8000-0000000c0005";
/** The composer's saved preferences with another preset chosen. */
const preset = (active, change = {}) => ({
  "publisher.preferences.v1": JSON.stringify({
    version: 1,
    active,
    presets: [
      ["photo", "Photo", ["instagram", "grain"]],
      ["video", "Long video", ["youtube"]],
      ["text", "Text post", ["bluesky", "twitter"]],
      ["short", "Short-form video", ["instagram", "youtube", "xiaohongshu", "tiktok", "twitter", "bluesky"]],
    ].map(([id, name, platforms]) => ({
      id,
      name,
      platforms,
      caption: "",
      visibility: "PRIVATE",
      metadata: {},
      ...change[id],
    })),
  }),
});
const tabs = ["compose", "pipeline", "history", "calendar", "analytics", "footage", "archive", "grade", "accounts"];
const tabNames = tabs.map((tab) => tab[0].toUpperCase() + tab.slice(1));
/** Text of a length, in words. */
const words = (length) => "long words ".repeat(400).slice(0, length);
const post = (page) => page.getByRole("textbox", { name: "Post", exact: true });
/** Answers one path later than the rest. */
const slow = (page, path, ms) =>
  page.evaluate(
    ([path, ms]) => {
      const { delay } = window.publisherFixture;
      window.publisherFixture.delay = (name, ...rest) => (name === path ? ms : delay(name, ...rest));
    },
    [path, ms],
  );

/**
 * Each scenario opens a tab and may go on from there. `still`, `step` and `opens` start its next part and say what may
 * move in it: nothing in a still one; in a step (the owner adding or choosing something) whatever moves moves at once,
 * in a single frame; in one that opens something, anything.
 */
export const scenarios = [
  // Loading, with every response, picture and font late.
  ...tabs.map((tab) => ({ tab, name: "loads" })),
  { tab: "compose", name: "loads the saved short-form preset", storage: preset("short") },
  { tab: "compose", name: "loads the saved photo preset", storage: preset("photo") },
  {
    tab: "compose",
    name: "loads the saved long video preset",
    storage: preset("video", { video: { caption: "A default caption" } }),
  },
  { tab: "compose", name: "loads a linked piece", query: { content: linkedPiece } },
  { tab: "compose", name: "opens a draft", query: { draft: draftId }, wait: 5500 },
  { tab: "compose", name: "opens a draft with a Chinese version", query: { draft: chineseDraftId }, wait: 7000 },
  {
    tab: "compose",
    name: "opens a draft that's gone",
    query: { draft: "00000000-0000-4000-8000-000000000bad" },
  },
  ...["compose", "pipeline", "history", "calendar", "analytics", "footage", "archive", "accounts"].flatMap((tab) => [
    {
      tab,
      name: "loads with nothing in it",
      init: () => {
        const none = {
          history: { posts: [], next: null },
          drafts: { drafts: [] },
          content: { items: [] },
          calendar: { posts: [] },
          analytics: { posts: [], next: null },
          "footage/links": { links: {} },
          "archive/days": { days: [] },
        };
        window.publisherFixture.change = (path, value) =>
          none[path] ?? (path === "footage/ledger" ? { ...value, clips: {}, projects: {} } : value);
      },
    },
    {
      tab,
      name: "fails to load, then loads",
      init: () => {
        // Drafts come first in History, and any that come after the posts are shown are new above them.
        window.publisherFixture.change = (path, value, method, call) =>
          method === "GET" && call <= 2 && path !== "drafts"
            ? { error: "The publisher is unavailable right now" }
            : value;
      },
      run: async (page) => {
        // Where nothing polls, the tab reads it again once it's shown again.
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
          await sleep(900);
        }
      },
    },
  ]),
  ...["pipeline", "history", "calendar", "analytics"].map((tab) => ({
    tab,
    name: "loads without its pictures",
    pictures: false,
  })),
  // Titles in the faces that only load once they're needed.
  ...["pipeline", "history", "calendar", "analytics"].map((tab) => ({
    tab,
    name: "loads titles in other scripts",
    init: () => {
      const titles = ["波哥大的四季与一杯咖啡的故事", "Почему в Боготе не бывает зимы и лета"];
      window.publisherFixture.change = (path, value) => {
        for (const [i, item] of Object.entries(value.items ?? value.posts ?? [])) {
          const title = titles[i % 2];
          if (path === "content" || path === "calendar") Object.assign(item, { title, notes: title });
          if (path === "history" || path === "analytics")
            Object.assign(item.post, { title, caption: `${title} ${title}` });
        }
        return value;
      };
    },
  })),
  {
    tab: "compose",
    name: "asks to sign in",
    props: { initialAccess: "loading" },
    init: () => {
      window.publisherFixture.change = (path, value) =>
        path === "session" ? { allowed: false, signedIn: false } : value;
    },
  },
  // Every tab from every other, the header and tabs staying put.
  {
    tab: "compose",
    name: "switches tabs",
    run: async (page, { still }) => {
      for (const name of [...tabNames.slice(1), ...tabNames.toReversed().slice(1)]) {
        await still(`opens ${name}`);
        await page
          .getByRole("navigation", { name: "Publisher sections" })
          .getByRole("button", { name, exact: true })
          .click();
        await sleep(2400);
      }
    },
  },
  {
    tab: "compose",
    name: "switches tabs from a little way down",
    run: async (page, { still }) => {
      await page.evaluate(() => scrollTo(0, 60));
      const place = () => page.locator(".publisher-tabs").evaluate((bar) => bar.getBoundingClientRect().top);
      const was = await place();
      // Grade fills the window under the tabs, so it goes back up to the top.
      for (const name of [...tabNames, ...tabNames.toReversed()].filter(
        (tab) => tab !== "Grade" && tab !== "Compose",
      )) {
        await still(`opens ${name}`);
        await page
          .getByRole("navigation", { name: "Publisher sections" })
          .getByRole("button", { name, exact: true })
          .click();
        await sleep(1500);
        const now = await place();
        if (Math.abs(now - was) > 0.5) throw new Error(`${name} moved the tabs from ${was}px to ${now}px`);
      }
    },
  },
  // The laptop going away and coming back, under every tab.
  ...tabs.map((tab) => ({
    tab,
    name: "polls the laptop",
    run: async (page, { still }) => {
      await still("the laptop and its accounts come and go");
      for (const [seen, platforms] of [
        [0, []],
        [1, ["bluesky"]],
        [1, ["bluesky", "twitter", "youtube-footage"]],
        [0, ["bluesky", "twitter", "grain"]],
        [1, ["bluesky", "twitter", "grain", "instagram", "youtube-footage"]],
      ]) {
        await page.evaluate(
          ([seen, platforms]) => {
            window.publisherFixture.change = (path, value) =>
              path === "status"
                ? {
                    ...value,
                    helper: { last_seen: seen ? Date.now() : 0, platforms: JSON.stringify(platforms) },
                  }
                : value;
          },
          [seen, platforms],
        );
        await sleep(1300);
      }
    },
  })),

  ...["compose", "history", "footage"].map((tab) => ({
    tab,
    name: "switches theme and back",
    run: async (page, { still }) => {
      await still("switches");
      for (let i = 0; i < 2; i++) {
        await page.getByRole("button", { name: "Toggle theme" }).click();
        await sleep(300);
      }
    },
  })),

  // Compose.
  {
    tab: "compose",
    name: "holds its messages",
    run: async (page, { still, media }) => {
      await post(page).fill("Hello");
      await sleep(400);
      await page.locator(".publish-button").click();
      await page.getByRole("status").getByText("Post queued.").waitFor();
      await still("an error comes over a notice, which goes first");
      await page
        .locator('.publisher-composer-tools input[type="file"][accept="image/*"]')
        .setInputFiles(Array.from({ length: 21 }, () => media.photo));
      await sleep(1800);
    },
  },
  ...["short", "text"].map((active) => ({
    tab: "compose",
    name: `writes with the ${active} preset`,
    storage: preset(active),
    run: async (page, { still }) => {
      await still("types past every limit and back");
      for (const length of [10, 120, 281, 310, 1100, 2300, 400, 12, 0]) {
        await post(page).fill(words(length));
        await sleep(150);
      }
      await page.getByRole("textbox", { name: "Tags" }).fill("#travel #bogota #film");
      await sleep(300);
    },
  })),
  {
    tab: "compose",
    name: "publishes a text post",
    run: async (page, { still }) => {
      await post(page).fill("Hello");
      await sleep(400);
      await still("queues it");
      await slow(page, "jobs", 700);
      await page.locator(".publish-button").click();
      await sleep(2600);
    },
  },
  {
    tab: "compose",
    name: "fails to publish",
    run: async (page, { still }) => {
      await post(page).fill("Hello");
      await sleep(400);
      await still("the queue refuses it, then takes it");
      await slow(page, "jobs", 700);
      await page.evaluate(() => {
        window.publisherFixture.change = (path, value, _method, call) =>
          path === "jobs" && call === 1
            ? { error: "The queue is unavailable right now. Try again in a minute, or check the laptop." }
            : value;
      });
      await page.locator(".publish-button").click();
      await sleep(1500);
      await page.locator(".publish-button").click();
      await sleep(2600);
    },
  },
  ...[
    ["photos", ["photo", "photo"], "photo"],
    ["a vertical video", ["tall"], "short"],
    ["a horizontal video", ["wide"], "short"],
    ["a horizontal video for YouTube", ["wide"], "video"],
    ["a video it can't read", ["broken"], "short"],
    ["a video beside a photo", ["photo", "tall"], "short"],
  ].map(([what, kinds, active]) => ({
    tab: "compose",
    name: `attaches ${what}`,
    storage: preset(active),
    run: async (page, { step, still, media }) => {
      await step("attaches it");
      const accept = kinds.length === 1 && kinds[0] !== "photo" ? "video/*" : "image/*";
      await page
        .locator(`.publisher-composer-tools input[type="file"][accept="${accept}"]`)
        .setInputFiles(kinds.map((kind) => media[kind]));
      await page.locator(".publisher-previews").first().waitFor({ timeout: 8000 });
      await sleep(1800);
      await still("the laptop's accounts change");
      await page.evaluate(() => {
        window.publisherFixture.change = (path, value) =>
          path === "status" ? { ...value, helper: { ...value.helper, platforms: "[]" } } : value;
      });
      await sleep(1300);
    },
  })),
  {
    tab: "compose",
    name: "chooses a cover and translates",
    storage: preset("short"),
    run: async (page, { still, step, media }) => {
      await step("attaches a video");
      await page.locator('.publisher-composer-tools input[type="file"][accept="video/*"]').setInputFiles(media.tall);
      await page.locator(".publisher-cover video").waitFor({ timeout: 8000 });
      await sleep(1500);
      await still("takes a frame as the cover");
      await post(page).fill("Words to translate");
      await page.getByRole("slider", { name: "Frame to use as the cover" }).fill("1.2");
      await sleep(200);
      await page.getByRole("button", { name: /^Use the frame/ }).click();
      await sleep(900);
      await still("chooses another");
      await page.getByRole("button", { name: "Choose another" }).click();
      await sleep(900);
      await still("translates");
      await page.getByRole("button", { name: "Translate", exact: true }).click();
      await sleep(1200);
    },
  },
  {
    tab: "compose",
    name: "edits an open draft",
    query: { draft: draftId },
    wait: 5500,
    run: async (page, { still }) => {
      await still("saves as it's edited");
      await page.getByRole("textbox", { name: "Tags" }).fill("film motion more");
      await sleep(1800);
      await post(page).fill("A film about films, edited");
      await sleep(1800);
    },
  },

  // Pipeline.
  {
    tab: "pipeline",
    name: "adds an idea",
    run: async (page, { step }) => {
      await step("adds it");
      await page.getByRole("textbox", { name: "New idea" }).fill("Hammock physics");
      await page.getByRole("button", { name: "Add" }).click();
      await sleep(1200);
    },
  },
  {
    tab: "pipeline",
    name: "reads itself again",
    run: async (page, { still }) => {
      await still("its pieces' views and footage change");
      await page.evaluate(() => {
        window.publisherFixture.change = (path, value) => {
          if (path === "content")
            for (const item of value.items)
              for (const target of item.post?.targets ?? []) if (target.metrics?.views) target.metrics.views *= 1200;
          if (path === "footage/ledger") for (const clip of Object.values(value.clips)) clip.graded = null;
          return value;
        };
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await sleep(2500);
    },
  },
  {
    tab: "pipeline",
    name: "edits a piece",
    run: async (page, { still }) => {
      await page.getByRole("button", { name: /Square windows/ }).click();
      const editor = page.getByRole("dialog");
      await editor.waitFor();
      await sleep(500);
      await still("every field changes, then it saves");
      for (const stage of ["idea", "script", "posted", "edit"]) {
        await editor.getByLabel("Stage").selectOption(stage);
        await sleep(150);
      }
      for (const footage of ["", "project:014-walk", "day:2026-11-21"]) {
        await editor.getByRole("combobox", { name: /^Footage/ }).selectOption(footage);
        await sleep(150);
      }
      await page.evaluate(() => {
        window.publisherFixture.delay = () => 900;
      });
      await editor.getByRole("button", { name: "Save" }).click();
      await sleep(700);
    },
  },
  {
    tab: "pipeline",
    name: "edits a posted piece",
    run: async (page, { still }) => {
      await page.getByRole("button", { name: /Lorax wisdom, part 7/ }).click();
      const editor = page.getByRole("dialog");
      await editor.waitFor();
      await sleep(500);
      await still("its stage changes");
      for (const stage of ["idea", "edit", "posted"]) {
        await editor.getByLabel("Stage").selectOption(stage);
        await sleep(150);
      }
    },
  },

  // History.
  ...[false, true].map((open) => ({
    tab: "history",
    name: open ? "watches an open post publish" : "watches posts publish",
    run: async (page, { still, opens }) => {
      if (open) {
        await opens("Manage");
        await page
          .locator(".publisher-history-item", { hasText: "A clip" })
          .getByRole("button", { name: "Manage" })
          .click();
        await sleep(900);
      }
      await still("its destinations queue, publish, fail and are deleted");
      const at = Date.now();
      const done = { state: "succeeded", url: "https://example.invalid/x", finished_at: at };
      const failed = (message, state = "failed") => ({ state, message, finished_at: at, started_at: at });
      for (const [youtube, tiktok] of [
        [{ state: "working" }, { state: "working" }],
        [done, failed("TikTok asked to confirm it isn't a robot. Sign in again from Accounts, then retry.")],
        [
          { ...done, deletion_state: "working" },
          failed("TikTok did not confirm a post URL. Check TikTok before retrying.", "uncertain"),
        ],
        [{ ...done, deletion_state: "deleted", deleted_at: at }, done],
        [done, { state: "queued", started_at: null }],
      ]) {
        await page.evaluate(
          ([youtube, tiktok]) => {
            window.publisherFixture.change = (path, value) => {
              if (path !== "history") return value;
              const clip = value.posts.find((item) => item.post.title === "A clip");
              for (const target of clip.targets)
                Object.assign(target, target.platform === "youtube" ? youtube : tiktok);
              return value;
            };
          },
          [youtube, tiktok],
        );
        await sleep(1000);
      }
    },
  })),
  {
    tab: "history",
    name: "turns the page",
    init: () => {
      window.publisherFixture.change = (path, value) => (path === "history" ? { ...value, next: "older" } : value);
    },
    run: async (page, { step }) => {
      for (const name of ["Older", "Newer"]) {
        await step(`${name} posts`);
        await page.getByRole("button", { name, exact: true }).click();
        await sleep(2200);
      }
    },
  },

  // Calendar.
  {
    tab: "calendar",
    name: "turns through the months",
    run: async (page, { still }) => {
      await still("goes on a year and back to today");
      for (let i = 0; i < 12; i++) {
        await page.getByRole("button", { name: "Next month" }).click();
        await sleep(i % 4 ? 120 : 900);
      }
      await page.getByRole("button", { name: "Today" }).click();
      await sleep(2200);
    },
  },
  { tab: "calendar", name: "opens on another month", query: { month: "2026-08" } },
  {
    tab: "calendar",
    name: "loads busy days",
    init: () => {
      window.publisherFixture.change = (path, value) => {
        if (path !== "calendar") return value;
        const more = (n) =>
          value.posts.map((item) => ({
            ...item,
            id: `${item.id.slice(0, -1)}${n}`,
            targets: item.targets.map((target) => ({ ...target, id: `${target.id}-${n}` })),
          }));
        return { posts: [...value.posts, ...[5, 6, 7, 8].flatMap(more)] };
      };
    },
  },
  {
    tab: "calendar",
    name: "edits a post",
    run: async (page, { still }) => {
      await page
        .getByRole("button", { name: /Better schools/ })
        .first()
        .click();
      const editor = page.getByRole("dialog");
      await editor.waitFor();
      await sleep(500);
      await still("its caption grows past the limits and back");
      for (const length of [100, 2300, 4000, 20]) {
        await editor.getByLabel("Caption").fill(words(length));
        await sleep(150);
      }
      await still("a destination is cancelled");
      await editor
        .getByRole("button", { name: /^Cancel publishing to/ })
        .first()
        .click();
      await sleep(2000);
      await still("it's translated");
      await editor.getByRole("button", { name: /^Translate/ }).click();
      await sleep(900);
    },
  },

  // Analytics.
  {
    tab: "analytics",
    name: "chooses posts, periods and kinds",
    wait: 5500,
    run: async (page, { still, step }) => {
      for (const i of [1, 2, 0]) {
        await step(`opens post ${i + 1}`);
        await page.locator(".publisher-analytics-posts > button").nth(i).click();
        await sleep(2400);
      }
      for (const period of ["7d", "All time", "30d"]) {
        await still(`shows ${period}`);
        await page.getByRole("group", { name: "Period" }).getByRole("button", { name: period }).click();
        await sleep(600);
      }
      for (const name of ["Daily", "Cumulative"]) {
        await step(`shows ${name}`);
        await page.getByRole("button", { name }).click();
        await sleep(600);
      }
      await step("lists text posts too");
      await page.getByRole("group", { name: "Post types" }).getByRole("button", { name: "Text" }).click();
      await sleep(3000);
    },
  },
  {
    tab: "analytics",
    name: "refreshes metrics",
    wait: 5500,
    run: async (page, { still }) => {
      await still("asks for new readings");
      await slow(page, "analytics/refresh", 800);
      await page.evaluate(() => {
        let reads = 0;
        window.publisherFixture.change = (path, value) => {
          if (path === "analytics/refresh")
            return { at: Date.now(), queued: ["analytics-youtube", "analytics-tiktok"], ok: true };
          if (path === "analytics") {
            reads++;
            for (const item of value.posts)
              for (const target of item.targets)
                if (reads > 4 || (reads > 2 && target.id === "analytics-youtube"))
                  target.checked_at = Date.now() + 1000;
          }
          return value;
        };
      });
      await page.getByRole("button", { name: "Refresh metrics" }).click();
      await sleep(6000);
    },
  },
  {
    tab: "analytics",
    name: "polls",
    wait: 5500,
    run: async (page, { still }) => {
      await still("the numbers grow");
      await page.evaluate(() => {
        window.publisherFixture.change = (path, value) => {
          if (path === "analytics")
            for (const item of value.posts)
              for (const target of item.targets) {
                for (const key of Object.keys(target.metrics ?? {})) target.metrics[key] *= 37;
                target.observed_at = Date.now() - 1000;
              }
          return value;
        };
      });
      await sleep(5500);
      await still("the list fails to load, then loads");
      await page.evaluate(() => {
        const { change } = window.publisherFixture;
        window.publisherFixture.change = (path, value, ...rest) =>
          path === "analytics" ? { error: "The publisher is unavailable right now" } : change(path, value, ...rest);
        setTimeout(() => {
          window.publisherFixture.change = change;
        }, 2500);
      });
      await sleep(6000);
    },
  },

  // Footage.
  {
    tab: "footage",
    name: "follows the uploads",
    run: async (page, { still }) => {
      await still("a clip goes up, and what holds the uploads changes");
      for (const state of [
        { sent: 800e6, speed: 2.51e6 },
        { sent: 999e6, speed: 998_000 },
        { sent: 1_250e6, speed: 12.4e6, today: 1 },
        { sent: 1_839e6, speed: null },
        { state: "paused", error: "YouTube refused part of the upload (503)" },
        {
          state: "paused",
          error: "YouTube says the channel reached its daily upload limit. Try again after it resets at midnight.",
        },
        { state: "limit" },
        { state: "busy" },
        { state: "done" },
        { state: "waiting" },
        { sent: 20e6, speed: 1.1e6 },
        { age: 120_000, sent: 40e6, speed: 1e6 },
        { none: true },
        { sent: 60e6, speed: 31e6 },
      ]) {
        await page.evaluate((state) => {
          window.publisherFixture.change = (path, value) => {
            // Saying the tab's open answers with the uploads too.
            if (!/^footage(\/watch)?$/.test(path) || !value.status) return value;
            if (state.none) return { ...value, age: null, status: null };
            const { status } = value;
            if (state.state)
              Object.assign(status, {
                state: state.state,
                current: null,
                speed: null,
                lastError: state.error ? { clip: "x", message: state.error, at: "" } : null,
                pausedUntil: state.error ? Date.now() + 9e5 : null,
              });
            else {
              status.current.sent = state.sent;
              status.speed = state.speed;
            }
            if (state.today) status.totals.today = state.today;
            if (state.age) value.age = state.age;
            status.totals.upBytes += (state.sent ?? 0) * 7;
            status.totals.dueBytes -= state.sent ?? 0;
            return value;
          };
        }, state);
        await sleep(1300);
      }
    },
  },
  {
    tab: "footage",
    name: "follows the ledger",
    run: async (page, { still }) => {
      await still("copies come and go, and the ledger fails to load");
      for (const turn of [1, 2, 3, 4]) {
        await page.evaluate((turn) => {
          window.publisherFixture.change = (path, value) => {
            if (path !== "footage/ledger") return value;
            if (turn === 3) return { error: "The archive is unavailable right now" };
            value.updatedAt = new Date().toISOString();
            for (const clip of Object.values(value.clips)) {
              if (turn > 1) clip.original = { camera: true, mac: true, cloudflare: true };
              if (clip.graded) clip.graded.cloudflare = "current";
              if (clip.graded && turn > 1) clip.graded.youtube = { video: "abcDEF12345", at: "", current: turn === 4 };
            }
            return value;
          };
        }, turn);
        await sleep(2400);
      }
    },
  },

  // Archive.
  {
    tab: "archive",
    name: "changes days",
    query: { day: "2026-11-08" },
    run: async (page, { step }) => {
      for (const day of ["11 Nov", "21 Nov", "8 Nov"]) {
        await step(`opens ${day}`);
        await page
          .getByRole("navigation", { name: "Shoot days" })
          .getByRole("button", { name: new RegExp(day) })
          .click();
        await sleep(1000);
      }
    },
  },
  {
    tab: "archive",
    name: "opens a clip and picks its looks",
    query: { day: "2026-11-08" },
    run: async (page, { opens, still, step }) => {
      await opens("opens the clip");
      await page.getByRole("button", { name: "Clip 0086, recorded 12:22:04" }).click();
      await sleep(1500);
      await still("reads its transcript and grade");
      await sleep(1500);
      const player = page.getByRole("dialog");
      await step("picks a line to start from");
      await player.getByRole("button", { name: /market at noon/ }).click();
      await sleep(500);
      for (const look of ["Default look", "Its grade", "Log"]) {
        await step(`picks ${look}`);
        await player.getByRole("group", { name: "Look" }).getByRole("button", { name: look }).click();
        await sleep(900);
      }
    },
  },
  {
    tab: "archive",
    name: "watches a clip in each look",
    query: { day: "2026-11-08", clip: "DJI_20261108122204_0086_D" },
    // A browser that plays HEVC, given a WebM in the original's place.
    init: () => {
      const can = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function (type) {
        return /hvc1|hev1/.test(type) ? "probably" : can.call(this, type);
      };
    },
    run: async (page, { still, step, media }) => {
      await page.route(`**/api/publisher/archive/files/${"0".repeat(62)}56/**`, (route) =>
        route.fulfill({ contentType: media.wide.mimeType, body: media.wide.buffer }).catch(() => {}),
      );
      const player = page.getByRole("dialog");
      await step("starts watching");
      await player.getByRole("button", { name: "Watch", exact: true }).click();
      await sleep(600);
      await still("plays, its lines said over it");
      await sleep(2500);
      for (const look of ["Default look", "Its grade", "Log"]) {
        await step(`picks ${look}`);
        await player.getByRole("group", { name: "Look" }).getByRole("button", { name: look }).click();
        await sleep(900);
      }
      await step("seeks from the transcript");
      await player.getByRole("button", { name: /Let's walk/ }).click();
      await sleep(900);
    },
  },

  // Grade.
  {
    tab: "grade",
    name: "can't reach the Mac",
    grade: false,
    run: async (page, { still }) => {
      await still("tries again");
      await page.getByRole("button", { name: "Try again" }).click({ timeout: 3000 });
      await sleep(1500);
    },
  },

  // Accounts.
  {
    tab: "accounts",
    name: "connects an account",
    run: async (page, { still }) => {
      await still("accounts connect, fail, finish and are disconnected");
      for (const [platform, action, state, message, archive] of [
        ["tiktok", "connect", "queued", null],
        ["tiktok", "connect", "working", null],
        ["tiktok", "connect", "failed", "TikTok sign-in wasn't finished. Connect again and sign in."],
        [
          "lens",
          "connect",
          "working",
          "Add 0x1111111111111111111111111111111111111111 as an account manager at https://hey.xyz/settings/manager with your wallet. It only needs to execute transactions, so leave token transfers off. Waiting for Lens to list it…",
        ],
        ["lens", "connect", "failed", "Lens never listed the key."],
        ["grain", "connect", "working", null],
        ["grain", "connect", "succeeded", null],
        ["youtube-footage", "connect", "queued", null],
        ["youtube-footage", "connect", "working", null],
        ["youtube-footage", "connect", "succeeded", null, true],
        ["instagram", "disconnect", "working", null],
        ["instagram", "disconnect", "succeeded", null],
      ]) {
        await page.evaluate(
          ([platform, action, state, message, archive]) => {
            window.publisherFixture.change = (path, value) =>
              path === "status"
                ? {
                    helper: {
                      last_seen: Date.now(),
                      platforms: JSON.stringify([
                        "bluesky",
                        "twitter",
                        "grain",
                        archive ? "youtube-footage" : "instagram",
                      ]),
                    },
                    connections: [{ id: "c", platform, action, state, confirmed: 0, message }],
                  }
                : value;
          },
          [platform, action, state, message, archive],
        );
        await sleep(1300);
      }
    },
  },
];
