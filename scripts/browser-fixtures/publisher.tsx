import { createRoot } from "react-dom/client";
import Publisher from "../../src/components/Publisher";
import "../../src/styles/globals.css";

// The composer against a signed-in owner and an online laptop; requests are recorded, never sent.
const requests: { path: string; method: string; body: unknown }[] = [];
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
const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = new URL(String(input), location.href);
  const path = url.pathname.replace("/api/publisher/", "");
  const method = init.method || "GET";
  const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
  requests.push({ path, method, body });
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
      helper: { last_seen: Date.now(), platforms: JSON.stringify(["bluesky", "twitter", "grain", "instagram"]) },
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
  if (path === "history") return json(history);
  if (path === "drafts") return json({ drafts });
  // Bluesky posted an hour ago, so its next free slot keeps its gap from that.
  if (path === "schedule") return json({ busy: { bluesky: [Date.now() - 3_600_000] } });
  if (path === "analytics") {
    const kinds = url.searchParams.get("kinds")?.split(",");
    return json({ ...analytics, posts: analytics.posts.filter((post) => !kinds || kinds.includes(post.post.kind)) });
  }
  if (path === "analytics/overview") return json(overview);
  if (path.startsWith("analytics/") && method === "GET")
    return json({ samples: path === `analytics/${analyticsPost}` ? samples : [] });
  if (path === "media") return json({ id: crypto.randomUUID() });
  if (/^jobs\/[^/]+\/thumbnail$/.test(path) && method === "PUT") return json({ ok: true });
  if (path === "jobs") return json({ id: JSON.parse(String(init.body)).id }, 201);
  if (path === "stop" || path === "mark-published" || path === "unlink") return json({ ok: true });
  if (path === "link") return json({ id: crypto.randomUUID(), platform: "tiktok" }, 201);
  if (path === "crosspost") return json({ platforms: JSON.parse(String(init.body)).platforms });
  if (path === "translate") return json({ title: "波哥大短片", text: "周末的波哥大。", topics: ["波哥大", "旅行"] });
  return json({ error: `Unexpected ${method} ${path}` }, 404);
}) as typeof fetch;
createRoot(document.getElementById("root") as HTMLElement).render(<Publisher />);
