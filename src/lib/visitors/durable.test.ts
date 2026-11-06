import { afterEach, expect, spyOn, test } from "bun:test";
import { LiveVisitors, PING, PONG, STALE_MS, VISITORS_PATH, type VisitorSocket, type VisitorState, network, people, visitorsSocket } from "./durable";

class Socket implements VisitorSocket {
  sent: string[] = [];
  closed?: number;
  private attachment: unknown;
  send(message: string) {
    if (this.closed) throw new Error("closed");
    this.sent.push(message);
  }
  close(code = 1000) { this.closed = code; }
  serializeAttachment(value: unknown) { this.attachment = value; }
  deserializeAttachment() { return this.attachment; }
  get last() { return this.sent.at(-1); }
}

class State implements VisitorState {
  sockets = new Map<Socket, string[]>();
  pings = new Map<Socket, Date>();
  autoResponse?: { request: string; response: string };
  alarm: number | null = null;
  storage = {
    getAlarm: async () => this.alarm,
    setAlarm: async (time: number) => { this.alarm = time; },
  };
  acceptWebSocket(socket: VisitorSocket, tags: string[] = []) { this.sockets.set(socket as Socket, tags); }
  getWebSockets(tag?: string) {
    return [...this.sockets].filter(([socket, tags]) => !socket.closed && (!tag || tags.includes(tag))).map(([socket]) => socket);
  }
  getTags(socket: VisitorSocket) { return this.sockets.get(socket as Socket) ?? []; }
  getWebSocketAutoResponseTimestamp(socket: VisitorSocket) { return this.pings.get(socket as Socket) ?? null; }
  setWebSocketAutoResponse(pair?: unknown) { this.autoResponse = pair as State["autoResponse"]; }
}

let accepted: Socket | undefined;
Object.assign(globalThis, {
  WebSocketPair: class {
    0 = new Socket();
    1 = new Socket();
    constructor() {
      accepted = this[1];
    }
  },
  WebSocketRequestResponsePair: class { constructor(public request: string, public response: string) {} },
});

function room() {
  const state = new State();
  return { state, object: new LiveVisitors(state) };
}

async function join(object: LiveVisitors, id: string | null, ip = "203.0.113.1") {
  const url = new URL(`https://live.internal${VISITORS_PATH}`);
  if (id !== null) url.searchParams.set("id", id);
  const response = await object.fetch(new Request(url, { headers: { Upgrade: "websocket", "CF-Connecting-IP": ip } }));
  return { response, socket: accepted as Socket };
}

afterEach(() => { accepted = undefined; });

test("pings are answered by the runtime without waking the object", () => {
  const { state } = room();
  expect(state.autoResponse).toEqual({ request: PING, response: PONG });
});

test("counts people rather than tabs, and tells everyone only when the count moves", async () => {
  const { object, state } = room();
  const first = await join(object, "visitor-aaaa");
  expect(first.response.status).toBe(101);
  expect(first.socket.sent).toEqual(["1"]);
  expect(state.alarm).not.toBeNull();

  const second = await join(object, "visitor-bbbb", "198.51.100.2");
  expect(first.socket.last).toBe("2");
  expect(second.socket.sent).toEqual(["2"]);

  const sameTab = await join(object, "visitor-bbbb", "198.51.100.2");
  expect(sameTab.socket.sent).toEqual(["2"]);
  expect(first.socket.sent).toEqual(["1", "2"]);

  // the address hash, never the address, is what the object keeps
  expect(JSON.stringify([...state.sockets.values()])).not.toContain("203.0.113.1");
});

test("two browsers on one connection are one person", async () => {
  const { object } = room();
  const chrome = await join(object, "visitor-aaaa");
  const safari = await join(object, "visitor-bbbb");
  expect(chrome.socket.sent).toEqual(["1"]);
  expect(safari.socket.sent).toEqual(["1"]);
  await join(object, "visitor-cccc", "198.51.100.2");
  expect(chrome.socket.last).toBe("2");
});

test("one browser reaching the site over IPv4 and IPv6 is one person", async () => {
  const { object } = room();
  const v4 = await join(object, "visitor-aaaa", "203.0.113.1");
  await join(object, "visitor-aaaa", "2001:db8:1:2::5");
  // a second browser on the IPv6 side joins the same person through the shared address
  await join(object, "visitor-bbbb", "2001:db8:1:2:aaaa:bbbb:cccc:dddd");
  expect(v4.socket.sent).toEqual(["1"]);
});

test("an IPv6 device's rotating addresses stand for one network", () => {
  expect(network("2001:db8:1:2::5")).toBe("2001:db8:1:2::/64");
  expect(network("2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
  expect(network("2001:db8::1")).toBe("2001:db8:0:0::/64");
  expect(network("::1")).toBe("0:0:0:0::/64");
  expect(network("2001:db8:1:3::5")).not.toBe(network("2001:db8:1:2::5"));
  expect(network("203.0.113.1")).toBe("203.0.113.1");
  expect(network(null)).toBe("unknown");
});

test("shared browsers and shared networks chain into one person", () => {
  expect(people([])).toBe(0);
  expect(people([["v:a", "a:1"], ["v:b", "a:2"]])).toBe(2);
  expect(people([["v:a", "a:1"], ["v:a", "a:2"], ["v:b", "a:2"], ["v:c", "a:3"]])).toBe(2);
  expect(people([["v:a", "a:1"], ["v:b", "a:2"], ["v:c", "a:1"], ["v:c", "a:2"]])).toBe(1);
});

test("someone leaving updates everyone still here", async () => {
  const { object } = room();
  const first = await join(object, "visitor-aaaa");
  const second = await join(object, "visitor-bbbb", "198.51.100.2");
  object.webSocketClose(second.socket);
  expect(first.socket.last).toBe("1");
  object.webSocketError(first.socket);
  expect(second.socket.sent).toEqual(["2"]);
});

test("pages without a usable id each count once", async () => {
  const { object } = room();
  const first = await join(object, null);
  await join(object, "<script>", "198.51.100.2");
  expect(first.socket.last).toBe("2");
});

test("a page that stops pinging is dropped by the alarm, and the alarm stops with the room empty", async () => {
  const { object, state } = room();
  const start = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(start);
  try {
    const quiet = await join(object, "visitor-aaaa");
    const alive = await join(object, "visitor-bbbb", "198.51.100.2");
    clock.mockReturnValue(start + STALE_MS + 1);
    state.pings.set(alive.socket, new Date(start + STALE_MS));
    await object.alarm();
    expect(quiet.socket.closed).toBe(4000);
    expect(alive.socket.last).toBe("1");
    expect(state.alarm).toBe(start + STALE_MS + 1 + 60_000);

    clock.mockReturnValue(start + 3 * STALE_MS);
    state.alarm = null;
    await object.alarm();
    expect(alive.socket.closed).toBe(4000);
    expect(state.alarm).toBeNull();
  } finally {
    clock.mockRestore();
  }
});

test("one address cannot hold more than ten sockets", async () => {
  const { object } = room();
  for (let tab = 0; tab < 10; tab++) expect((await join(object, `visitor-${tab}-xxxx`)).response.status).toBe(101);
  expect((await join(object, "visitor-extra")).response.status).toBe(429);
  expect((await join(object, "visitor-elsewhere", "198.51.100.7")).response.status).toBe(101);
});

test("anything other than a ping closes the socket", async () => {
  const { object } = room();
  const first = await join(object, "visitor-aaaa");
  const noisy = await join(object, "visitor-bbbb", "198.51.100.2");
  object.webSocketMessage(noisy.socket);
  expect(noisy.socket.closed).toBe(1003);
  expect(first.socket.last).toBe("1");
});

test("the object only takes WebSocket upgrades", async () => {
  const { object } = room();
  expect((await object.fetch(new Request(`https://live.internal${VISITORS_PATH}`))).status).toBe(426);
});

test("the page Worker forwards only same-origin upgrades, all to one room", async () => {
  const names: string[] = [];
  const env = {
    LIVE_VISITORS: {
      idFromName: (name: string) => { names.push(name); return name; },
      get: () => ({ fetch: async () => new Response("forwarded") }),
    },
  };
  const request = (headers: Record<string, string>) => new Request(`https://kualta.dev${VISITORS_PATH}?id=visitor-aaaa`, { headers });
  expect((await visitorsSocket(request({ Origin: "https://kualta.dev" }), env)).status).toBe(426);
  expect((await visitorsSocket(request({ Upgrade: "websocket", Origin: "https://elsewhere.example" }), env)).status).toBe(403);
  expect((await visitorsSocket(request({ Upgrade: "websocket" }), env)).status).toBe(403);
  expect((await visitorsSocket(request({ Upgrade: "websocket", Origin: "https://kualta.dev" }), {})).status).toBe(503);
  expect(await (await visitorsSocket(request({ Upgrade: "websocket", Origin: "https://kualta.dev" }), env)).text()).toBe("forwarded");
  expect(names).toEqual(["site"]);
});
