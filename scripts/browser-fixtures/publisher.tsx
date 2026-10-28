import { createRoot } from "react-dom/client";
import Publisher from "../../src/components/Publisher";
import "../../src/styles/globals.css";

// The composer against a signed-in owner and an online laptop; requests are recorded, never sent.
const requests: { path: string; method: string; body: unknown }[] = [];
Object.assign(window, { publisherRequests: requests });
const json = (value: unknown, status = 200) => Response.json(value, { status });
const history = {
  posts: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      created_at: Date.parse("2026-10-20T12:00:00Z"),
      post: { kind: "text", title: "", caption: "An earlier text post\nwith a second line", media: [], alt: "" },
      targets: [{ id: "t1", platform: "bluesky", state: "succeeded", url: "https://bsky.app/profile/x/post/y" }],
    },
  ],
  next: null,
};
window.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const path = new URL(String(input), location.href).pathname.replace("/api/publisher/", "");
  const method = init.method || "GET";
  requests.push({ path, method, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
  if (path === "session") return json({ allowed: true, signedIn: true });
  if (path === "status")
    return json({
      helper: { last_seen: Date.now(), platforms: JSON.stringify(["bluesky", "twitter", "grain", "instagram"]) },
      connections: [],
    });
  if (path === "history") return json(history);
  if (path === "media") return json({ id: crypto.randomUUID() });
  if (path === "jobs") return json({ id: JSON.parse(String(init.body)).id }, 201);
  return json({ error: `Unexpected ${method} ${path}` }, 404);
}) as typeof fetch;
createRoot(document.getElementById("root") as HTMLElement).render(<Publisher />);
