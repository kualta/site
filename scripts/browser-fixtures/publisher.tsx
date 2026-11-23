import { createRoot, hydrateRoot } from "react-dom/client";
import Publisher from "../../src/components/Publisher";
import { archiveAnswer } from "./archive.mjs";
import "../../src/styles/globals.css";

// The composer against a signed-in owner and an online laptop; requests are recorded, never sent.
const requests: { path: string; method: string; body: any; query: string }[] = [];
Object.assign(window, { publisherRequests: requests });
const json = (value: unknown, status = 200) => Response.json(value, { status });
const connecting = new URLSearchParams(location.search).get("connecting");
const minutes = (count: number) => Date.now() - count * 60_000;
const target = (platform: string, state: string, extra: Record<string, unknown> = {}) => ({
  id: `${platform}-${state}-${Math.random()}`,
  platform,
  state,
  url: state === "succeeded" ? `https://example.invalid/${platform}/post` : null,
  message: null,
  deletion_state: null,
  deletion_message: null,
  started_at: state === "queued" ? null : Date.now() - 40_000,
  finished_at: ["succeeded", "failed", "uncertain"].includes(state) ? Date.now() - 20_000 : null,
  deleted_at: "deletion_state" in extra ? Date.now() - 10_000 : null,
  linked: 0,
  earlier_sign_in: 0,
  ...extra,
});
// Two days of posts plus an older one, covering every destination state the list shows.
const history = {
  posts: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      created_at: minutes(1),
      post: {
        kind: "photo",
        title: "this, too, is modern art",
        caption: "Two frames from the gallery walk",
        media: ["m-photo-1", "m-photo-2"],
        alt: "",
      },
      targets: [
        target("grain", "succeeded"),
        target("bluesky", "succeeded", { deletion_state: "deleted", deletion_message: "Deleted from the platform" }),
        target("instagram", "failed", {
          message: "Instagram asked to confirm the login. Sign in again from Accounts.",
        }),
      ],
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      created_at: minutes(2),
      post: { kind: "text", title: "", caption: "meow", media: [], alt: "" },
      targets: [
        target("bluesky", "succeeded", { deletion_state: "deleted", deletion_message: "Deleted from the platform" }),
      ],
    },
    // Scheduled for tomorrow on Instagram; Xiaohongshu was stopped before it published, to move it.
    {
      id: "00000000-0000-4000-8000-000000000007",
      created_at: minutes(3),
      post: { kind: "video", title: "Better schools", caption: "", media: ["m-schools"], alt: "" },
      targets: [
        target("instagram", "queued", { id: "instagram-scheduled", scheduled_at: Date.now() + 86_400_000 }),
        target("xiaohongshu", "failed", { id: "xiaohongshu-stopped", message: "Stopped before publishing." }),
      ],
    },
    {
      id: "00000000-0000-4000-8000-000000000003",
      created_at: minutes(24 * 60),
      post: { kind: "video", title: "A clip", caption: "", media: ["m-expired"], alt: "" },
      targets: [target("youtube", "working"), target("tiktok", "queued")],
    },
    // TikTok's sign-in changed since these went out: one can go to the new account, the other has its repost linked.
    {
      id: "00000000-0000-4000-8000-000000000005",
      created_at: minutes(24 * 60),
      post: { kind: "video", title: "I LOVE EARTHQUAKES", caption: "", media: ["m-quake"], alt: "" },
      targets: [target("youtube", "succeeded"), target("tiktok", "succeeded", { earlier_sign_in: 1 })],
    },
    {
      id: "00000000-0000-4000-8000-000000000006",
      created_at: minutes(24 * 60),
      post: {
        kind: "video",
        title: "Colombian halloween is pure cinema",
        caption: "",
        media: ["m-halloween"],
        alt: "",
      },
      targets: [
        target("tiktok", "succeeded", { id: "tiktok-earlier", earlier_sign_in: 1 }),
        target("tiktok", "succeeded", {
          id: "tiktok-repost",
          linked: 1,
          url: "https://www.tiktok.com/@kualtq/video/7710000000000000001",
        }),
      ],
    },
    // Its videos expired from storage before YouTube was retried; the post can take them again.
    {
      id: "00000000-0000-4000-8000-000000000008",
      created_at: minutes(24 * 60),
      post: {
        kind: "video",
        title: "Lorax wisdom, part 7",
        caption: "",
        media: ["m-lorax"],
        alt: "",
        zh: { title: "洛拉克斯", text: "", topics: [], video: "m-lorax-zh" },
      },
      targets: [
        target("instagram", "succeeded"),
        target("youtube", "failed", { message: "This post's media has expired." }),
      ],
      expired: ["m-lorax", "m-lorax-zh"],
    },
    {
      id: "00000000-0000-4000-8000-000000000004",
      created_at: Date.parse("2026-09-28T22:00:06Z"),
      post: {
        kind: "text",
        title: "",
        caption: "An earlier text post\nwith a second line that runs long enough to wrap onto another line in the list",
        media: [],
        alt: "",
      },
      targets: [
        target("bluesky", "succeeded"),
        target("twitter", "uncertain", { message: "X did not confirm a post URL. Check X before retrying." }),
      ],
    },
  ],
  next: null,
};
// A draft sent from the terminal; its video comes through the page's real fetch, so the check can serve a real clip.
const draftVideo = "00000000-0000-4000-8000-00000000d1d0";
const draft = {
  id: "00000000-0000-4000-8000-00000000d1af",
  video: draftVideo,
  preset: "short",
  title: "Rendered film",
  caption: "A film about films",
  alt: "Titles fade over a dark stage",
  tags: ["film", "motion"],
  short: "A film",
  zh: { title: "短片", text: "一部关于电影的短片。", topics: ["短片", "动画"] },
};
// The same film with a version made for Chinese audiences.
const chineseVideo = "00000000-0000-4000-8000-00000000d1d1";
const chineseDraft = {
  ...draft,
  id: "00000000-0000-4000-8000-00000000d1b0",
  zh: { ...draft.zh, video: chineseVideo },
};
// A video read on three platforms; two of them show their creator how long people watched.
const day = 86_400_000;
const analyticsPost = "00000000-0000-4000-8000-0000000a0001";
const youtubeShort = { views: 1213, likes: 30, comments: 4, average_watch_ms: 39_786, duration_ms: 29_000 };
const tiktokVideo = {
  views: 96,
  likes: 6,
  comments: 1,
  shares: 0,
  saves: 2,
  average_watch_ms: 6_060,
  duration_ms: 28_075,
};
const analyticsTarget = (
  platform: string,
  metrics: Record<string, number>,
  retention: Record<string, number> | null,
) => ({
  ...target(platform, "succeeded"),
  id: `analytics-${platform}`,
  metrics,
  retention,
  observed_at: minutes(12),
  checked_at: minutes(12),
  next_at: Date.now() + 48 * 60_000,
  analytics_error: null,
});
// Beside it, a newer text post the tab leaves out until asked, an older photo post whose upload is still there and
// has no thumbnail yet, and an older video that kept one before its upload expired.
const analyticsPhoto = "00000000-0000-4000-8000-0000000a0002";
const analytics = {
  posts: [
    {
      id: "00000000-0000-4000-8000-0000000a0003",
      created_at: minutes(60),
      post: { kind: "text", title: "", caption: "meow", media: [], alt: "" },
      thumbnail: null,
      targets: [analyticsTarget("bluesky", { likes: 2 }, null)],
    },
    {
      id: analyticsPost,
      created_at: minutes(3 * 24 * 60),
      post: { kind: "video", title: "A film about films", caption: "Titles fade over a dark stage.", media: [], alt: "" },
      thumbnail: null,
      targets: [
        { ...analyticsTarget("youtube", youtubeShort, youtubeShort), url: "https://www.youtube.com/shorts/CJs864wmjB0" },
        { ...analyticsTarget("tiktok", tiktokVideo, tiktokVideo), earlier_sign_in: 1 },
        // Reposted by hand on a new account and linked, so its views add to the original's.
        { ...analyticsTarget("tiktok", { views: 30, likes: 4 }, null), id: "analytics-tiktok-repost", linked: 1 },
        analyticsTarget("bluesky", { likes: 12, comments: 2, shares: 3 }, null),
      ],
    },
    {
      id: analyticsPhoto,
      created_at: minutes(5 * 24 * 60),
      post: { kind: "photo", title: "", caption: "Two frames from the gallery walk", media: ["m-photo-a"], alt: "" },
      thumbnail: null,
      targets: [analyticsTarget("instagram", { views: 310, likes: 41 }, null)],
    },
    {
      id: "00000000-0000-4000-8000-0000000a0004",
      created_at: minutes(9 * 24 * 60),
      post: { kind: "video", title: "An older reel", caption: "", media: ["m-expired"], alt: "" },
      thumbnail: 1_761_900_000_000,
      targets: [{ ...analyticsTarget("tiktok", { views: 75 }, null), id: "analytics-tiktok-older" }],
    },
  ],
  next: null,
};
const today = Math.floor(Date.now() / day);
const overview = {
  changes: [5, 4, 3, 2, 1, 0].flatMap((ago) => [
    {
      platform: "youtube",
      day: today - ago,
      at: Date.now() - ago * day,
      change: [400, 120, 700, 260, 90, 43][5 - ago],
    },
    { platform: "tiktok", day: today - ago, at: Date.now() - ago * day, change: [0, 0, 60, 20, 10, 6][5 - ago] },
  ]),
  videos: [{ id: analyticsPost, at: minutes(3 * 24 * 60), label: "A film about films", thumbnail: null }],
  retention: [
    {
      platform: "youtube",
      at: minutes(6 * 24 * 60),
      metrics: { views: 400, average_watch_ms: 87_833, duration_ms: 330_000 },
    },
    { platform: "youtube", at: minutes(3 * 24 * 60), metrics: youtubeShort },
    { platform: "tiktok", at: minutes(3 * 24 * 60), metrics: tiktokVideo },
  ],
};
const samples = [48, 24, 12, 1].flatMap((hours) => [
  ...["youtube", "tiktok"].map((platform) => ({
    target_id: `analytics-${platform}`,
    platform,
    observed_at: minutes(hours * 60),
    metrics: { views: Math.round((platform === "youtube" ? 1213 : 96) / (1 + hours / 24)) },
  })),
  ...(hours < 24
    ? [
        {
          target_id: "analytics-tiktok-repost",
          platform: "tiktok",
          observed_at: minutes(hours * 60 - 1),
          metrics: { views: Math.round(30 / (1 + hours / 24)) },
        },
      ]
    : []),
]);
// The month: a film out two days ago (TikTok failed), and the next part scheduled for tomorrow and the day after.
const atHour = (days: number, hour: number) => {
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, hour).getTime();
};
const calendarTarget = (platform: string, state: string, at: number, scheduled = false) => ({
  id: crypto.randomUUID(),
  platform,
  state,
  url: state === "succeeded" ? `https://example.test/${platform}` : null,
  at,
  scheduled,
  deleted: false,
  stopped: false,
});
const calendar = [
  {
    id: "00000000-0000-4000-8000-0000000c0001",
    title: "Square windows",
    caption: "Lorax wisdom, part 7",
    kind: "video",
    media: [],
    thumbnail: null,
    tags: [],
    short: "",
    expires: null,
    targets: [
      calendarTarget("youtube", "succeeded", atHour(-2, 16)),
      calendarTarget("tiktok", "failed", atHour(-2, 18)),
    ],
  },
  {
    id: "00000000-0000-4000-8000-0000000c0002",
    title: "Better schools",
    caption: "Lorax wisdom, part 6",
    kind: "video",
    media: [],
    thumbnail: null,
    tags: ["lorax"],
    short: "",
    zh: { title: "更好的学校", text: "罗拉克斯的智慧，第六部分", topics: ["罗拉克斯"] },
    // Its video went up yesterday, so it goes out within six days.
    expires: atHour(5, 23),
    targets: [
      calendarTarget("instagram", "queued", atHour(1, 18), true),
      calendarTarget("xiaohongshu", "queued", atHour(2, 7), true),
    ],
  },
];
const calendarTargets = () => calendar.flatMap((post) => post.targets);
// Both drafts wait in Cloudflare: the plain one sent half an hour ago, the one with a Chinese version yesterday.
let drafts = [
  { id: draft.id, title: draft.title, caption: draft.caption, video: draftVideo, chinese: false, created: minutes(30) },
  {
    id: chineseDraft.id,
    title: draft.title,
    caption: draft.caption,
    video: draftVideo,
    chinese: true,
    created: minutes(26 * 60),
  },
].map((item) => ({ ...item, expires: item.created + 7 * day }));
// Drafts the composer saved, kept across reloads as Cloudflare would keep them.
const SAVED = "publisher.fixture.drafts";
const saved: Record<string, { id: string; title: string; caption: string; video: string; zh?: { video?: string } }> =
  JSON.parse(localStorage.getItem(SAVED) ?? "{}");
const listed = (item: (typeof saved)[string], created: number) => ({
  id: item.id,
  title: item.title,
  caption: item.caption,
  video: item.video,
  chinese: Boolean(item.zh?.video),
  created,
  expires: created + 7 * day,
});
drafts = [...Object.values(saved).map((item) => listed(item, Date.now())), ...drafts].filter(
  (item, i, all) => all.findIndex((other) => other.id === item.id) === i,
);
// The pipeline: a piece at every stage, the posted one linked to the first post in History.
type Piece = {
  id: string;
  title: string;
  notes: string;
  stage: string;
  job_id: string | null;
  created_at: number;
  stage_at: number;
  thumbnail: number | null;
  post: {
    kind: string;
    media: string[];
    targets: { id: string; platform: string; url: string | null; deleted: boolean; metrics: Record<string, number> | null }[];
  } | null;
};
const piece = (n: number, title: string, stage: string, daysAgo: number, notes = ""): Piece => ({
  id: `00000000-0000-4000-8000-0000000c0${String(n).padStart(3, "0")}`,
  title,
  notes,
  stage,
  job_id: null,
  created_at: Date.now() - (daysAgo + 3) * day,
  stage_at: Date.now() - daysAgo * day,
  thumbnail: null,
  post: null,
});
let pieces: Piece[] = [
  piece(1, "Lorax wisdom, part 8", "idea", 0),
  piece(2, "Why Bogotá has no seasons", "idea", 4, "Rain at 3pm every day. Find the IDEAM chart."),
  piece(
    3,
    "Colombian breakfast tier list",
    "script",
    1,
    "Hook: arepa vs. calentado.\nS tier: changua (fight me)\nA tier: tamal\nEnd on the coffee.",
  ),
  piece(4, "Night market walk", "footage", 2, "42 clips on the Pocket, graded."),
  piece(5, "Square windows", "edit", 0, "Final cut is in OpenFilm."),
  // Posted: a photo post with its thumbnail kept, and a video whose picture is its YouTube still, read on two platforms.
  {
    ...piece(6, "this, too, is modern art", "posted", 0),
    job_id: history.posts[0].id,
    thumbnail: 1_761_900_000_000,
    post: {
      kind: "photo",
      media: ["m-photo-1", "m-photo-2"],
      targets: [
        { id: "grain-art", platform: "grain", url: "https://example.invalid/grain/post", deleted: false, metrics: { likes: 4 } },
        { id: "bluesky-art", platform: "bluesky", url: null, deleted: true, metrics: null },
      ],
    },
  },
  {
    ...piece(7, "Lorax wisdom, part 7", "posted", 1),
    job_id: "00000000-0000-4000-8000-000000000008",
    post: {
      kind: "video",
      media: ["m-lorax"],
      targets: [
        {
          id: "youtube-lorax",
          platform: "youtube",
          url: "https://www.youtube.com/shorts/CJs864wmjB0",
          deleted: false,
          metrics: { views: 1213, likes: 30, comments: 4 },
        },
        {
          id: "instagram-lorax",
          platform: "instagram",
          url: "https://www.instagram.com/reel/abc/",
          deleted: false,
          metrics: { views: 310, likes: 41 },
        },
      ],
    },
  },
];
// The Archive tab: the laptop is putting a clip up at 20 Mbit/s, two wait (one off the laptop) and one is up;
// ?archive=paused, limit, done or stale shows the uploads held up instead, and the check moves them along itself.
const upload = { state: new URLSearchParams(location.search).get("archive"), sent: 736_000_000, unreadable: false };
Object.assign(window, { publisherUpload: upload });
// Everything paused from the Footage tab since 10:42 with ?paused, else once Pause all is clicked; window.publisherPause
// changes it as another device would.
const pause = { since: new URLSearchParams(location.search).has("paused") ? new Date().setHours(10, 42, 0, 0) : null };
Object.assign(window, { publisherPause: pause });
const pausedNow = () => (pause.since === null ? null : { since: pause.since });
function footage() {
  const archiveState = upload.state;
  const clips = [
    ["DJI_20261121101500_0402_D.mp4", "2026-11-21 10:15:00 · clip 0402", 1_840_000_000, "exported", "uploading", null],
    ["DJI_20261120183012_0399_D.mp4", "2026-11-20 18:30:12 · clip 0399", 912_000_000, "exported", "due", "earlier1234"],
    ["DJI_20261111161230_0258_D.mp4", "2026-11-11 16:12:30 · clip 0258", 420_000_000, "exported", "up", "abcDEF12345"],
    ["DJI_20261108122204_0086_D.mp4", "2026-11-08 12:22:04 · clip 0086", 2_780_000_000, "archive", "due", null],
  ].map(([name, title, size, from, state, video]) => ({ name, title, size, from, state, video, uploadedAt: null }));
  const uploading = !archiveState || archiveState === "stale";
  const failed = archiveState === "paused" || archiveState === "dropped";
  const sent = uploading ? upload.sent : 0;
  return {
    watching: true,
    age: archiveState === "stale" ? 3_600_000 : 2_000,
    paused: pausedNow(),
    status: {
      at: Date.now() - (archiveState === "stale" ? 3_600_000 : 2_000),
      channel: "@kualta-footage",
      daily: 10,
      today: archiveState === "limit" ? 10 : 3,
      // Paused from the tab, the clip in flight is held after its part.
      state: pause.since !== null ? "held" : uploading ? "uploading" : failed ? "paused" : archiveState,
      pausedUntil: failed ? Date.now() + 30 * 60_000 : null,
      lastError: failed
        ? {
            clip: clips[0].name,
            // ?archive=dropped: the connection was cut mid-upload, as undici says it.
            message: archiveState === "dropped" ? "terminated" : "YouTube refused part of the upload (503)",
            at: new Date().toISOString(),
          }
        : null,
      current: uploading ? { name: clips[0].name, title: clips[0].title, size: clips[0].size, sent, from: "exported" } : null,
      speed: 2_500_000,
      totals: {
        up: 1,
        upBytes: 420_000_000,
        due: 3,
        dueBytes: 1_840_000_000 + 912_000_000 + 2_780_000_000 - sent,
        today: archiveState === "limit" ? 0 : 3,
        todayBytes: archiveState === "limit" ? 0 : 1_840_000_000 + 912_000_000 + 2_780_000_000 - sent,
      },
      clips: archiveState === "done" ? clips.map((clip) => ({ ...clip, state: "up", video: "doneDEF1234" })) : clips,
    },
  };
}
// This Mac: the grade app's offload, the card copied and Mac → Cloudflare 7 of 167 at 7.1 Mbit/s; ?mac=waiting, paused,
// stale, done, failed or none shows it otherwise, and so does window.publisherMac.state.
const macState = { state: new URLSearchParams(location.search).get("mac") };
Object.assign(window, { publisherMac: macState });
function macReply() {
  const { state } = macState;
  if (state === "none") return { age: null, report: null };
  const lane = (extra: Record<string, unknown>) => ({
    state: "running",
    done: 0,
    total: 0,
    sentBytes: 0,
    totalBytes: 0,
    speed: null,
    left: null,
    waiting: null,
    error: null,
    ...extra,
  });
  const ended = state === "done" || state === "failed";
  const until = new Date(Date.now() + 4 * 60_000).toISOString();
  const sending = { done: 7, total: 167, sentBytes: 1.4e9, totalBytes: 40.1e9 };
  // Paused from the Footage tab, a run going holds after the part in flight.
  const held = pause.since !== null && !ended ? "held" : null;
  const send =
    {
      held: lane({ ...sending, state: "paused", waiting: { for: "owner", why: "Paused from the Footage tab", until: null } }),
      paused: lane({ ...sending, state: "paused", waiting: { for: "page", why: "No Grade page is open", until: null } }),
      waiting: lane({ ...sending, state: "waiting", waiting: { for: "network", why: "fetch failed", until } }),
      done: lane({ state: "done", done: 167, total: 167, sentBytes: 40.1e9, totalBytes: 40.1e9 }),
      failed: lane({
        state: "failed",
        done: 90,
        total: 167,
        sentBytes: 21.6e9,
        totalBytes: 40.1e9,
        error: "Cloudflare refused the pairing (401): pair the crossposter helper again",
      }),
    }[held ?? state ?? ""] ?? lane({ ...sending, speed: 887_500, left: 43_600 });
  const copy =
    state === "waiting"
      ? lane({
          state: "waiting",
          done: 120,
          total: 167,
          sentBytes: 28.8e9,
          totalBytes: 40.1e9,
          waiting: { for: "camera", why: "The camera isn't plugged in", until },
        })
      : lane({ state: "done", done: 167, total: 167, sentBytes: 40.1e9, totalBytes: 40.1e9 });
  const started = Date.now() - 50 * 60_000;
  return {
    age: state === "stale" ? 25 * 60_000 : 20_000,
    report: {
      version: 1,
      at: new Date(Date.now() - 20_000).toISOString(),
      running: !ended,
      startedAt: new Date(started).toISOString(),
      endedAt: ended ? new Date(Date.now() - 5 * 60_000).toISOString() : null,
      lanes: { copy, send },
      camera: { mounted: state !== "waiting", clips: 0, bytes: 0 },
      mac: { clips: state === "done" ? 0 : 160, bytes: state === "done" ? 0 : 38.7e9 },
      freed: { camera: 40.1e9, mac: state === "done" ? 40.1e9 : 1.4e9 },
      skipped: [
        {
          lane: "send",
          name: "DJI_20261120183012_0399_D.MP4",
          why: "doesn't read back from Cloudflare as it was sent: it stays on this Mac",
        },
      ],
      transcripts: { made: 12, waiting: 3, failed: 1, toSend: 4, error: "uvx isn't installed, so Whisper can't run" },
      kept: { days: ["2026-11-08", "2026-11-15"], clips: 45 },
      room: { free: 123e9, keepFree: 5e9 },
    },
  };
}
// The footage ledger as the grade app sends it: the clip going up, one whose YouTube video is an earlier grade, one
// safe in Cloudflare and on YouTube, one only the archive holds, one with no copy left, and a phone clip on the Mac.
const original = (camera: boolean, mac: boolean, cloudflare = false) => ({ camera, mac, cloudflare });
const graded = (extra: Record<string, unknown>) => ({
  look: "Umbra",
  at: "2026-11-21T09:00:00Z",
  size: 1_000_000_000,
  mac: true,
  cloudflare: false,
  youtube: null,
  ...extra,
});
const ledgerClip = (name: string, recorded: string, extra: Record<string, unknown>) => ({
  name,
  recorded,
  profile: "dlog2",
  duration: 30,
  size: 3_000_000_000,
  original: original(false, false),
  graded: null,
  gradePending: false,
  ...extra,
});
const ledger = {
  version: 1,
  updatedAt: new Date(Date.now() - 60_000).toISOString(),
  camera: { name: "Pocket 4P", mounted: false, seenAt: new Date(Date.now() - 86_400_000).toISOString() },
  archiveAt: new Date().toISOString(),
  clips: {
    DJI_20261121101500_0402_D: ledgerClip("DJI_20261121101500_0402_D.MP4", "2026-11-21T10:15:00", {
      original: original(true, false),
      graded: graded({ size: 1_840_000_000 }),
      thumb: true,
    }),
    DJI_20261120183012_0399_D: ledgerClip("DJI_20261120183012_0399_D.MP4", "2026-11-20T18:30:12", {
      original: original(false, true),
      graded: graded({ youtube: { video: "earlier1234", at: "2026-11-20T20:00:00Z", current: false } }),
    }),
    DJI_20261111161230_0258_D: ledgerClip("DJI_20261111161230_0258_D.MP4", "2026-11-11T16:12:30", {
      original: original(true, false),
      graded: graded({ cloudflare: "current", youtube: { video: "abcDEF12345", at: "2026-11-17T10:00:00Z", current: true } }),
      thumb: true,
    }),
    DJI_20261108122204_0086_D: ledgerClip("DJI_20261108122204_0086_D.mp4", "2026-11-08T12:22:04", {
      size: null,
      graded: graded({ mac: false, cloudflare: "current" }),
    }),
    DJI_20261101090000_0001_D: ledgerClip("DJI_20261101090000_0001_D.MP4", "2026-11-01T09:00:00", {}),
    IMG_4857: ledgerClip("IMG_4857.MOV", "2026-10-30T20:15:04", { profile: "rec709", original: original(false, true) }),
  },
  // A film being made on the Mac, and one archived since it was posted.
  projects: {
    "013-maybe-later": {
      clips: ["DJI_20261108122204_0086_D", "DJI_20261111161230_0258_D"],
      local: false,
      archived: true,
    },
    "014-walk": { clips: ["DJI_20261120183012_0399_D", "DJI_20261121101500_0402_D"], local: true, archived: false },
  },
};
// Pipeline pieces' footage: a shoot day for the footage-ready walk, films for the edit and a posted piece.
const pieceId = (n: number) => `00000000-0000-4000-8000-0000000c0${String(n).padStart(3, "0")}`;
const links: Record<string, { project?: string; day?: string }> = {
  [pieceId(4)]: { day: "2026-11-21" },
  [pieceId(5)]: { project: "014-walk" },
  [pieceId(7)]: { project: "013-maybe-later" },
};
const realFetch = window.fetch.bind(window);
const respond = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = new URL(String(input), location.href);
  const path = url.pathname.replace("/api/publisher/", "");
  const method = init.method || "GET";
  const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
  requests.push({ path, method, body, query: url.search });
  if (path === `media/${draftVideo}` || path === `media/${chineseVideo}`) return realFetch(input, init);
  if (path.startsWith("drafts/") && method === "DELETE") {
    drafts = drafts.filter((item) => `drafts/${item.id}` !== path);
    return json({ ok: true });
  }
  if ((path === "drafts" && method === "POST") || (path.startsWith("drafts/") && method === "PUT")) {
    const id = method === "POST" ? crypto.randomUUID() : path.slice("drafts/".length);
    if (method === "PUT" && !saved[id] && id !== draft.id && id !== chineseDraft.id)
      return json({ error: "This draft has expired or was already posted" }, 404);
    saved[id] = { id, ...body };
    localStorage.setItem(SAVED, JSON.stringify(saved));
    drafts = [listed(saved[id], Date.now()), ...drafts.filter((item) => item.id !== id)];
    return json({ id }, method === "POST" ? 201 : 200);
  }
  const savedId = path.slice("drafts/".length);
  if (path.startsWith("drafts/") && saved[savedId]) return json(saved[savedId]);
  if (path === `drafts/${draft.id}`) return json(draft);
  if (path === `drafts/${chineseDraft.id}`) return json(chineseDraft);
  if (path.startsWith("drafts/")) return json({ error: "This draft has expired or was already posted" }, 404);
  if (path === "session") return json({ allowed: true, signedIn: true });
  if (path === "status")
    return json({
      helper: {
        last_seen: Date.now(),
        platforms: JSON.stringify(["bluesky", "twitter", "grain", "instagram", "youtube-footage"]),
      },
      connections: connecting
        ? [
            {
              id: "00000000-0000-4000-8000-00000000c044",
              platform: connecting,
              action: "connect",
              state: "working",
              confirmed: 0,
              message:
                connecting === "lens"
                  ? "Add 0x1111111111111111111111111111111111111111 as an account manager at https://hey.xyz/settings/manager with your wallet. It only needs to execute transactions, so leave token transfers off. Waiting for Lens to list it…"
                  : null,
            },
          ]
        : [],
    });
  if (path === "footage" || path === "footage/watch") {
    if (method === "DELETE") return json({ watching: false });
    return upload.unreadable ? json({ error: "Publisher unavailable" }, 503) : json(footage());
  }
  if (path === "footage/ledger") return json(ledger);
  const archived = archiveAnswer(path);
  if (archived) return archived;
  if (path === "footage/mac") return json(macReply());
  if (path === "footage/pause") {
    if (method === "POST") pause.since ??= Date.now();
    if (method === "DELETE") pause.since = null;
    return json({ paused: pausedNow() });
  }
  if (path === "footage/links") return json({ links });
  if (path.startsWith("footage/links/") && method === "PUT") {
    const id = path.slice("footage/links/".length);
    if (body.project) links[id] = { project: body.project };
    else if (body.day) links[id] = { day: body.day };
    else delete links[id];
    return json({ links });
  }
  if (path === "history") return json(history);
  if (path === "drafts") return json({ drafts });
  // Bluesky posted an hour ago, so its next free slot keeps its gap from that.
  if (path === "schedule") return json({ busy: { bluesky: [Date.now() - 3_600_000] } });
  // Every post with a destination in the range, with all its destinations.
  if (path === "calendar") {
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    return json({ posts: calendar.filter((post) => post.targets.some((t) => t.at >= from && t.at < to)) });
  }
  if (path === "analytics") {
    const kinds = url.searchParams.get("kinds")?.split(",");
    return json({ ...analytics, posts: analytics.posts.filter((post) => !kinds || kinds.includes(post.post.kind)) });
  }
  if (path === "analytics/overview") return json(overview);
  if (path.startsWith("analytics/") && method === "GET")
    return json({ samples: path === `analytics/${analyticsPost}` ? samples : [] });
  if (path === "media") return json({ id: crypto.randomUUID() });
  if (/^jobs\/[^/]+\/thumbnail$/.test(path) && method === "PUT") return json({ ok: true });
  // As the server does: the linked piece moves to Posted with the post, else the post gets a piece of its own.
  if (path === "jobs") {
    const linked = pieces.find((item) => item.id === url.searchParams.get("content") && !item.job_id);
    if (linked) Object.assign(linked, { stage: "posted", job_id: body.id, stage_at: Date.now() });
    else
      pieces.unshift({
        ...piece(0, body.title || body.caption.trim().split("\n")[0].slice(0, 80) || "Untitled", "posted", 0),
        id: body.id,
        job_id: body.id,
      });
    return json({ id: body.id }, 201);
  }
  // Stopped before publishing, a calendar destination can be scheduled again.
  if (path === "stop")
    for (const item of calendarTargets())
      if (item.id === body.target && item.state === "queued")
        Object.assign(item, { state: "failed", stopped: true, scheduled: false, at: Date.now() });
  if (path === "stop" || path === "mark-published" || path === "unlink") return json({ ok: true });
  if (path === "edit") {
    const { job, ...words } = body;
    Object.assign(calendar.find((post) => post.id === job) ?? {}, words);
    return json({ ok: true });
  }
  // A new time puts the destination back in the queue, waiting for it.
  if (path === "reschedule") {
    const { target: id, at } = body as { target: string; at: number };
    for (const post of history.posts)
      for (const item of post.targets as Record<string, unknown>[])
        if (item.id === id) Object.assign(item, { state: "queued", scheduled_at: at, message: null, finished_at: null });
    for (const item of calendarTargets())
      if (item.id === id) Object.assign(item, { state: "queued", at, scheduled: true, stopped: false });
    return json({ ok: true });
  }
  if (path === "link") return json({ id: crypto.randomUUID(), platform: "tiktok" }, 201);
  // The post takes its new uploads, so nothing is expired any more.
  if (path === "replace-media") {
    for (const post of history.posts as { id: string; expired?: string[] }[])
      if (post.id === body.job) post.expired = [];
    return json({ ok: true });
  }
  if (path === "content" && method === "GET")
    return json({ items: [...pieces].sort((a, b) => b.stage_at - a.stage_at) });
  if (path === "content" && method === "POST") {
    const created = { ...piece(0, body.title.trim(), "idea", 0), id: crypto.randomUUID(), notes: body.notes ?? "" };
    pieces = [created, ...pieces];
    return json(created, 201);
  }
  if (path.startsWith("content/")) {
    const found = pieces.find((item) => `content/${item.id}` === path);
    if (!found) return json({ error: "This piece was deleted" }, 404);
    if (method === "DELETE") {
      pieces = pieces.filter((item) => item !== found);
      return json({ ok: true });
    }
    if (method === "PATCH") {
      const stage = body.job ? "posted" : body.stage ?? found.stage;
      Object.assign(found, {
        title: body.title?.trim() ?? found.title,
        notes: body.notes ?? found.notes,
        stage_at: stage === found.stage ? found.stage_at : Date.now(),
        stage,
        job_id: stage === "posted" ? body.job ?? found.job_id : null,
        post: stage === "posted" && !body.job ? found.post : null,
      });
    }
    return json(found);
  }
  if (path === "crosspost") return json({ platforms: JSON.parse(String(init.body)).platforms });
  if (path === "translate") return json({ title: "波哥大短片", text: "周末的波哥大。", topics: ["波哥大", "旅行"] });
  return json({ error: `Unexpected ${method} ${path}` }, 404);
};
// A check can answer late, fail or change what comes back (scripts/publisher-shifts.mjs).
type Answer = (input: RequestInfo | URL, init?: RequestInit, usual?: Answer) => Promise<Response>;
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const { publisherAnswer = respond } = window as { publisherAnswer?: Answer };
  return publisherAnswer(input, init, respond);
}) as typeof fetch;
const root = document.getElementById("root") as HTMLElement;
// Rendered by the server, as the site renders it, the page only takes over; otherwise it renders from nothing.
const props = document.getElementById("props")?.textContent;
if (props) hydrateRoot(root, <Publisher {...JSON.parse(props)} />);
else createRoot(root).render(<Publisher />);
