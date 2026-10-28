import { useEffect, useId, useRef, useState } from "react";
import { CheckIcon, ChevronRightIcon } from "@/components/icons";

interface Props {
  focusOnMount?: boolean;
  showHelper?: boolean;
  compact?: boolean;
}

export function EmailSubscription({ focusOnMount = false, showHelper = true, compact = false }: Props) {
  const id = useId();
  const pending = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusOnMount) inputRef.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  const [state, setState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [hasEmail, setHasEmail] = useState(false);

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

  let buttonLabel = "Subscribe";
  if (state === "pending") buttonLabel = "Subscribing…";
  if (state === "success") buttonLabel = "Subscribed";

  return (
    <form
      onSubmit={handleSubmit}
      onReset={() => setHasEmail(false)}
      className="newsletter-form"
      data-compact={compact || undefined}
      data-has-email={hasEmail || undefined}
      aria-busy={state === "pending"}
    >
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
          onInput={(event) => setHasEmail(event.currentTarget.value.length > 0)}
        />
        <button
          type="submit"
          disabled={state === "pending" || state === "success"}
          aria-label={buttonLabel}
          aria-hidden={compact && !hasEmail ? true : undefined}
          tabIndex={compact && !hasEmail ? -1 : undefined}
        >
          {compact ? (
            state === "success" ? (
              <CheckIcon size={20} />
            ) : state === "pending" ? (
              <span aria-hidden="true">…</span>
            ) : (
              <ChevronRightIcon size={20} />
            )
          ) : (
            ["Subscribe", "Subscribing…", "Subscribed"].map((label) => (
              <span
                key={label}
                className="newsletter-button-label"
                aria-hidden={label !== buttonLabel}
                style={{ visibility: label === buttonLabel ? "visible" : "hidden" }}
              >
                {label}
                {label === "Subscribed" && <CheckIcon aria-hidden="true" />}
              </span>
            ))
          )}
        </button>
      </div>
      <p
        id={`${id}-message`}
        className={!showHelper && state !== "error" ? "sr-only" : "newsletter-message"}
        role="status"
        data-error={state === "error"}
      >
        {message || (showHelper ? "Essays by email. Unsubscribe anytime." : "")}
      </p>
    </form>
  );
}
