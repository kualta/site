import { createRoot } from "react-dom/client";
import Publisher from "../../src/components/Publisher";
import "../../src/styles/globals.css";

// The composer against a signed-in owner and an online laptop; requests are recorded, never sent.
const requests: { path: string; method: string; body: unknown }[] = [];
Object.assign(window, { publisherRequests: requests });
const json = (value: unknown, status = 200) => Response.json(value, { status });
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
const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const path = new URL(String(input), location.href).pathname.replace("/api/publisher/", "");
  const method = init.method || "GET";
  requests.push({ path, method, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
  if (path === `media/${draftVideo}`) return realFetch(input, init);
  if (path === `drafts/${draft.id}`) return method === "DELETE" ? json({ ok: true }) : json(draft);
  if (path.startsWith("drafts/")) return json({ error: "This draft has expired or was already posted" }, 404);
  if (path === "session") return json({ allowed: true, signedIn: true });
  if (path === "status")
    return json({
      helper: { last_seen: Date.now(), platforms: JSON.stringify(["bluesky", "twitter", "grain", "instagram"]) },
      connections: [],
    });
  if (path === "history") return json(history);
  if (path === "media") return json({ id: crypto.randomUUID() });
  if (path === "jobs") return json({ id: JSON.parse(String(init.body)).id }, 201);
  if (path === "stop" || path === "mark-published") return json({ ok: true });
  if (path === "crosspost") return json({ platforms: JSON.parse(String(init.body)).platforms });
  if (path === "translate") return json({ title: "波哥大短片", text: "周末的波哥大。", topics: ["波哥大", "旅行"] });
  return json({ error: `Unexpected ${method} ${path}` }, 404);
}) as typeof fetch;
createRoot(document.getElementById("root") as HTMLElement).render(<Publisher />);
