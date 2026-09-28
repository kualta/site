import { useState } from "react";
import { platforms, platformNames, type Platform } from "@/lib/publisher/presets";
import { encryptCredentials } from "@/lib/publisher/credentials";

export interface Connection {
  id: string;
  platform: Platform;
  action: "connect" | "disconnect";
  state: "queued" | "working" | "succeeded" | "failed" | "cancelled";
  confirmed: number;
  message: string | null;
}
interface Props {
  online: boolean;
  connected: Platform[];
  publicKey: JsonWebKey | null;
  connections: Connection[];
  request: (path: string, body?: unknown) => Promise<unknown>;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}
export default function PublisherConnections({
  online,
  connected,
  publicKey,
  connections,
  request,
  refresh,
  onError,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [service, setService] = useState("https://bsky.social");
  const [identifier, setIdentifier] = useState("kualta.dev");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const active = connections.find((c) => c.state === "queued" || c.state === "working");
  async function send(path: string, body: unknown) {
    setBusy(true);
    onError("");
    try {
      await request(path, body);
      await refresh();
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : "Connection failed");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function connectAtproto() {
    if (!publicKey) {
      onError("Waiting for the laptop connection. Try again shortly.");
      return;
    }
    setBusy(true);
    try {
      const credentials = await encryptCredentials(publicKey, { service, identifier, password });
      if (await send("accounts", { platform: "grain", action: "connect", credentials })) {
        setPassword("");
        setEditing(false);
      }
    } catch {
      onError("Could not encrypt account details. Refresh and try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="publisher-accounts" aria-label="Publishing accounts">
      <h2>Accounts</h2>
      {!online && <p className="publisher-note">Start your laptop helper to connect accounts.</p>}
      {platforms
        .filter((p) => p !== "bluesky")
        .map((platform) => {
          const label = platform === "grain" ? "Grain / Bluesky" : platformNames[platform];
          const ready = connected.includes(platform);
          const latest = connections.find(
            (c) => c.platform === platform || (platform === "grain" && c.platform === "bluesky"),
          );
          const current =
            active &&
            (active.platform === platform || (platform === "grain" && active.platform === "bluesky"));
          let status = ready ? "Connected" : "Not connected";
          if (current) {
            status = "Connecting…";
            if (active.state === "queued") status = "Waiting for laptop…";
            else if (active.action === "disconnect") status = "Disconnecting…";
          }
          return (
            <div className="publisher-account" key={platform}>
              <div className="publisher-account-row">
                <span>{label}</span>
                <span className="publisher-note">{status}</span>
                <button
                  disabled={!online || busy || !!active}
                  onClick={() => {
                    if (ready) {
                      if (
                        confirm(
                          `Disconnect ${label} from this publisher? Queued posts will wait until you reconnect.`,
                        )
                      )
                        void send("accounts", { platform, action: "disconnect" });
                    } else if (platform === "grain") setEditing(true);
                    else void send("accounts", { platform, action: "connect" });
                  }}
                >
                  {ready ? "Disconnect" : "Connect"}
                </button>
              </div>
              {current && (
                <div className="publisher-account-actions">
                  {active.state === "working" && active.action === "connect" && platform !== "grain" && (
                    <>
                      <p className="publisher-note">
                        Sign in in the Chrome window on your laptop, then finish here.
                      </p>
                      <button
                        disabled={busy || !!active.confirmed}
                        onClick={() => void send(`accounts/${active.id}`, { action: "finish" })}
                      >
                        {active.confirmed ? "Checking…" : "Finish sign-in"}
                      </button>
                    </>
                  )}
                  <button
                    disabled={busy}
                    onClick={() => void send(`accounts/${active.id}`, { action: "cancel" })}
                  >
                    Cancel
                  </button>
                </div>
              )}
              {!current && latest?.state === "failed" && (
                <p role="status" className="publisher-note">
                  {latest.message}
                </p>
              )}
            </div>
          );
        })}
      {editing && (
        <form
          className="publisher-account-form"
          onSubmit={(event) => {
            event.preventDefault();
            void connectAtproto();
          }}
        >
          <label>
            PDS URL
            <input
              type="url"
              autoFocus
              required
              value={service}
              onChange={(e) => setService(e.target.value)}
            />
          </label>
          <label>
            Handle
            <input
              required
              value={identifier}
              autoComplete="username"
              onChange={(e) => setIdentifier(e.target.value)}
            />
          </label>
          <label>
            App password
            <input
              type="password"
              required
              value={password}
              autoComplete="off"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <p className="publisher-note">
            Use an AT Protocol app password. It is encrypted for your laptop and never saved in browser
            storage.
          </p>
          <div className="publisher-account-actions">
            <button disabled={busy || !online || !!active || !publicKey} type="submit">
              Connect Grain / Bluesky
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setPassword("");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
