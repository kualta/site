import { useSyncExternalStore } from "react";
import { getBlueskyAuthSnapshot, getBlueskyAuthServerSnapshot, subscribeBlueskyAuth } from "@/lib/bluesky/auth";
import BlueskyLogin from "./BlueskyLogin";

export default function BlueskyCallback() {
  const auth = useSyncExternalStore(subscribeBlueskyAuth, getBlueskyAuthSnapshot, getBlueskyAuthServerSnapshot);
  let status = "Sign-in was not completed. Try again or return to the feed.";
  if (auth.loading) status = "Finishing sign-in and returning you to the conversation…";
  else if (auth.agent) status = "Signed in. Returning you to the conversation…";
  return (
    <div className="flex flex-col gap-6">
      <p role="status">{status}</p>
      {auth.error && <p role="alert">{auth.error}</p>}
      {!auth.loading && !auth.agent && <BlueskyLogin />}
    </div>
  );
}
