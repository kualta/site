import { useEffect, useId, useRef, useState } from "react";
import { CheckIcon, ChevronRightIcon } from "@/components/icons";
import { FORM_TOKEN_MAX_AGE_MS, FORM_TOKEN_MIN_AGE_MS } from "@/lib/newsletter/form-age";

type FormToken = { token: string; receivedAt: number };
const CLOCK_SLACK_MS = 250;

async function fetchFormToken(): Promise<FormToken> {
  const response = await fetch("/api/subscribe", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok || typeof data.token !== "string")
    throw new Error(data.message || "Couldn't subscribe. Please try again.");
  return { token: data.token, receivedAt: Date.now() };
}

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
  // Fetched when the field is focused; each token signs up once.
  const formToken = useRef<Promise<FormToken> | null>(null);

  function prepareToken(): Promise<FormToken> {
    if (formToken.current) return formToken.current;
    const next = fetchFormToken();
    formToken.current = next;
    next.catch(() => {
      if (formToken.current === next) formToken.current = null;
    });
    return next;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    pending.current = true;
    setState("pending");
    setMessage("");
    try {
      let signup = await prepareToken();
      formToken.current = null;
      // A tab left open past the token's lifetime gets a fresh one.
      if (Date.now() - signup.receivedAt > FORM_TOKEN_MAX_AGE_MS - 60_000) signup = await fetchFormToken();
      // The server rejects young tokens, so wait out the rest, with a little slack for clocks.
      const wait = FORM_TOKEN_MIN_AGE_MS + CLOCK_SLACK_MS - (Date.now() - signup.receivedAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const response = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: fields.get("email"),
          website: fields.get("website") ?? "",
          token: signup.token,
          automated: navigator.webdriver === true,
        }),
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
          placeholder="your@email.com"
          aria-describedby={`${id}-message`}
          readOnly={state === "pending" || state === "success"}
          onFocus={() => prepareToken().catch(() => {})}
          onInput={(event) => setHasEmail(event.currentTarget.value.length > 0)}
        />
        {/* Honeypot: hidden from people and screen readers; bots that fill every field fill this. */}
        <div className="newsletter-trap" aria-hidden="true">
          <label>
            Website
            <input name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
          </label>
        </div>
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
