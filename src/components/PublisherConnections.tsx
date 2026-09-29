import { useState } from "react";
import { platforms, platformNames, type Platform } from "@/lib/publisher/presets";

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
  connections: Connection[];
  request: (path: string, body?: unknown) => Promise<unknown>;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}
export default function PublisherConnections({ online, connected, connections, request, refresh, onError }: Props) {
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
            active && (active.platform === platform || (platform === "grain" && active.platform === "bluesky"));
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
                        confirm(`Disconnect ${label} from this publisher? Queued posts will wait until you reconnect.`)
                      )
                        void send("accounts", { platform, action: "disconnect" });
                    } else void send("accounts", { platform, action: "connect" });
                  }}
                >
                  {ready ? "Disconnect" : "Connect"}
                </button>
              </div>
              {current && (
                <div className="publisher-account-actions">
                  {active.state === "working" && active.action === "connect" && platform === "grain" && (
                    <p className="publisher-note">Authorize Grain and Bluesky in the browser window on your laptop.</p>
                  )}
                  {active.state === "working" && active.action === "connect" && platform !== "grain" && (
                    <>
                      <p className="publisher-note">
                        Sign in in the Chrome window on your laptop, then finish here. Finishing closes that window and
                        checks the saved session.
                      </p>
                      <button
                        disabled={busy || !!active.confirmed}
                        onClick={() => void send(`accounts/${active.id}`, { action: "finish" })}
                      >
                        {active.confirmed ? "Checking…" : "Finish sign-in"}
                      </button>
                    </>
                  )}
                  <button disabled={busy} onClick={() => void send(`accounts/${active.id}`, { action: "cancel" })}>
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
    </section>
  );
}
