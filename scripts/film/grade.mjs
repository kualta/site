// The grade app (scripts/grade, http://127.0.0.1:4777) as films use it: small graded preview copies of camera clips
// for OpenFilm's own preview, and graded trims at full quality for a render. Clips are named as films name them, by
// file name. Writes take the `X-Grade: 1` header, as the app asks of every POST.

export const GRADE_URL = process.env.GRADE_URL || "http://127.0.0.1:4777";
const RESTART = "launchctl kickstart -k gui/$(id -u)/dev.kualta.grade";

/** States a preview or trim stays in: there's nothing more to wait for. */
export const SETTLED = new Set(["ready", "failed", "missing"]);

export function gradeApp({ url = GRADE_URL, fetcher = fetch } = {}) {
  async function call(path, init) {
    let response;
    try {
      response = await fetcher(`${url}${path}`, init);
    } catch (error) {
      const why = error.cause?.code ?? error.message;
      throw new Error(
        `The grade app isn't answering at ${url} (${why}). It runs all the time on the laptop; restart it with: ${RESTART}`,
      );
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(`The grade app answered ${response.status} to ${path}: ${body.error ?? "no reason given"}`);
    return body;
  }
  const post = (path, json) =>
    call(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Grade": "1" },
      body: JSON.stringify(json),
    });
  return {
    url,
    /** Queues preview copies of these clips (those not current). */
    askPreviews: (names) => post("/api/previews", { names }),
    /** `{ <name>: { state, path, key, error } }`. */
    previews: (names) => call(`/api/previews?names=${names.map(encodeURIComponent).join(",")}`),
    /** Asks for full-quality trims, `[{ name, start, end }]`; says the request's id. */
    askTrims: async (trims) => (await post("/api/trims", { trims })).id,
    /** Each trim asked for, in order: `{ state, path, start, end, actualStart, actualEnd, error }`. */
    trims: async (id) => {
      const body = await call(`/api/trims?id=${encodeURIComponent(id)}`);
      return Array.isArray(body) ? body : body.trims;
    },
  };
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** Asks `look` every `every` ms until `settled` says what it said is final; `heard` hears each answer. */
export async function waitUntil(look, settled, { every = 1000, heard = () => {} } = {}) {
  for (;;) {
    const answer = await look();
    heard(answer);
    if (settled(answer)) return answer;
    await pause(every);
  }
}

/** What to tell the owner about clips the app only has in Cloudflare. */
export const inCloudflare = (names) =>
  `${names.join(", ")} ${names.length > 1 ? "are" : "is"} only in Cloudflare. Bring ${
    names.length > 1 ? "them" : "it"
  } back in the grade app (Clips from → Cloudflare, the clip's day, Bring), then run this again.`;
