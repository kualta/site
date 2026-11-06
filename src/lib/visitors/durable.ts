// Who is on the site right now. Each open page holds one hibernatable
// WebSocket to a single object, which wakes only when someone arrives or
// leaves, so a quiet room costs nothing between visits.

/** The slice of the runtime's WebSocket API this object uses; the project does not load workers-types. */
export interface VisitorSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface VisitorState {
  acceptWebSocket(socket: VisitorSocket, tags?: string[]): void;
  getWebSockets(tag?: string): VisitorSocket[];
  getTags(socket: VisitorSocket): string[];
  getWebSocketAutoResponseTimestamp(socket: VisitorSocket): Date | null;
  setWebSocketAutoResponse(pair?: unknown): void;
  storage: {
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number): Promise<void>;
  };
}

export interface VisitorNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

declare const WebSocketPair: new () => { 0: unknown; 1: VisitorSocket };
declare const WebSocketRequestResponsePair: new (request: string, response: string) => unknown;

export const VISITORS_PATH = "/api/visitors";
export const PING = "ping";
export const PONG = "pong";
/** pages ping every 30s; a socket silent for three of those is a closed laptop */
export const STALE_MS = 90_000;
const WATCH_MS = 60_000;
/** enough for a household's tabs, not enough to make the number say anything */
const PER_ADDRESS = 10;
const MAX_SOCKETS = 5_000;
const VISITOR_TAG = "v:";
const ADDRESS_TAG = "a:";

/** The page's own id when it sent a sane one, so one person's tabs count once. */
function visitorTag(id: string | null): string {
  return VISITOR_TAG + (id && /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : crypto.randomUUID());
}

function isUpgrade(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

/** The socket may already be gone, and a goodbye to it is not worth an error. */
function closeQuietly(socket: VisitorSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {}
}

/**
 * The connection a person sits behind. An IPv6 device rotates its own address
 * within one /64, so that prefix stands for it, as the whole address does for IPv4.
 */
export function network(address: string | null): string {
  if (!address) return "unknown";
  if (!address.includes(":")) return address;
  const [head, tail] = address.toLowerCase().split("::");
  let groups = head ? head.split(":") : [];
  // "::" stands for however many zero groups bring the address to eight
  if (tail !== undefined) {
    const right = tail ? tail.split(":") : [];
    const zeros = Array(Math.max(0, 8 - groups.length - right.length)).fill("0");
    groups = [...groups, ...zeros, ...right];
  }
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}

/** Only a hash of the network is kept, and only for as long as the socket is open. */
async function addressTag(address: string | null): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(network(address)));
  const hex = [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return ADDRESS_TAG + hex;
}

/**
 * Sockets that share a browser or a network are one person: tabs in one
 * browser share its id, and two browsers on one connection share its address.
 * Each socket carries both, so the two links chain into groups.
 */
export function people(sockets: string[][]): number {
  const parent = new Map<string, string>();
  function root(tag: string): string {
    let node = tag;
    let next = parent.get(node);
    while (next !== undefined && next !== node) {
      node = next;
      next = parent.get(node);
    }
    return node;
  }
  for (const tags of sockets) {
    const [first, ...rest] = tags.map(root);
    if (first === undefined) continue;
    parent.set(first, first);
    for (const other of rest) parent.set(other, first);
  }
  return new Set(sockets.filter((tags) => tags.length > 0).map((tags) => root(tags[0]))).size;
}

export class LiveVisitors {
  /** what everyone was last told; forgotten on hibernation, which only costs one repeat */
  private told?: number;

  constructor(private ctx: VisitorState, _env?: unknown) {
    // answered by the runtime without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(request: Request): Promise<Response> {
    if (!isUpgrade(request)) return new Response("Expected a WebSocket", { status: 426 });
    const address = await addressTag(request.headers.get("CF-Connecting-IP"));
    if (
      this.ctx.getWebSockets(address).length >= PER_ADDRESS ||
      this.ctx.getWebSockets().length >= MAX_SOCKETS
    ) {
      return new Response("Too many connections", { status: 429 });
    }

    const pair = new WebSocketPair();
    const socket = pair[1];
    this.ctx.acceptWebSocket(socket, [visitorTag(new URL(request.url).searchParams.get("id")), address]);
    socket.serializeAttachment(Date.now());
    this.announce(socket);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + WATCH_MS);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  /** Pings never reach here, so anything that does is not one of our pages. */
  webSocketMessage(socket: VisitorSocket): void {
    closeQuietly(socket, 1003, "Unexpected message");
    this.announce(undefined, socket);
  }

  webSocketClose(socket: VisitorSocket): void {
    closeQuietly(socket, 1000, "Bye");
    this.announce(undefined, socket);
  }

  webSocketError(socket: VisitorSocket): void {
    this.announce(undefined, socket);
  }

  /** Clears out pages that went quiet without saying goodbye, while anyone is here. */
  async alarm(): Promise<void> {
    if (this.announce().length > 0) await this.ctx.storage.setAlarm(Date.now() + WATCH_MS);
  }

  /** Sockets still in the room, closing any that stopped pinging. */
  private present(leaving?: VisitorSocket): VisitorSocket[] {
    const now = Date.now();
    return this.ctx.getWebSockets().filter((socket) => {
      if (socket === leaving) return false;
      const joined = Number(socket.deserializeAttachment()) || 0;
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0;
      if (now - Math.max(joined, pinged) <= STALE_MS) return true;
      closeQuietly(socket, 4000, "Stale");
      return false;
    });
  }

  /** Tells everyone when the count moves, and a newcomer either way. */
  private announce(newcomer?: VisitorSocket, leaving?: VisitorSocket): VisitorSocket[] {
    const sockets = this.present(leaving);
    const count = people(sockets.map((socket) => this.ctx.getTags(socket)));
    let recipients: VisitorSocket[] = [];
    if (count !== this.told) recipients = sockets;
    else if (newcomer) recipients = [newcomer];
    this.told = count;
    for (const socket of recipients) {
      try {
        socket.send(String(count));
      } catch {}
    }
    return sockets;
  }
}

/** The page Worker's half: only our own pages may join, and the object does the rest. */
export function visitorsSocket(request: Request, env: Cloudflare.Env): Response | Promise<Response> {
  if (!isUpgrade(request)) return new Response("Expected a WebSocket", { status: 426 });
  if (request.headers.get("Origin") !== new URL(request.url).origin) {
    return new Response("Forbidden", { status: 403 });
  }
  const namespace = env.LIVE_VISITORS;
  if (!namespace) return new Response("Unavailable", { status: 503 });
  return namespace.get(namespace.idFromName("site")).fetch(request);
}
