import { useEffect, useId, useRef, useState } from "react";
import { LuCheck } from "react-icons/lu";

interface Props {
  focusOnMount?: boolean;
  showHelper?: boolean;
}

export function EmailSubscription({ focusOnMount = false, showHelper = true }: Props) {
  const id = useId();
  const pending = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusOnMount) inputRef.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  const [state, setState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const form = event.currentTarget;
    const email = new FormData(form).get("email");
    pending.current = true;
    setState("pending");
    setMessage("");
    try {
      const response = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Couldn't subscribe. Please try again.");
      setState("success");
      setMessage(data.message || "You’re subscribed.");
      form.reset();
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Couldn't subscribe. Please try again.");
    } finally {
      pending.current = false;
    }
  }

  let buttonLabel = "Join";
  if (state === "pending") buttonLabel = "Joining…";
  if (state === "success") buttonLabel = "Joined";

  return (
    <form onSubmit={handleSubmit} className="newsletter-form" aria-busy={state === "pending"}>
      <label htmlFor={id} className="sr-only">
        Email address
      </label>
      <div className="newsletter-fields">
        <input
          ref={inputRef}
          id={id}
          name="email"
          type="email"
          autoComplete="email"
          required
          maxLength={254}
          placeholder="Your email"
          aria-describedby={`${id}-message`}
          readOnly={state === "pending" || state === "success"}
        />
        <button
          type="submit"
          disabled={state === "pending" || state === "success"}
          aria-label={state === "success" ? "Subscribed" : "Subscribe"}
        >
          <span>{buttonLabel}</span>
          {state === "success" && <LuCheck aria-hidden="true" />}
        </button>
      </div>
      <p id={`${id}-message`} className="newsletter-message" role="status" data-error={state === "error"}>
        {message || (showHelper ? "New essays, occasionally. Unsubscribe anytime." : "")}
      </p>
    </form>
  );
}
