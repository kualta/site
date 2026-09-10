import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { FiBell, FiX } from "react-icons/fi";
import { EmailSubscription } from "./EmailSubscription";

export function NewsletterSignup() {
  const [open, setOpen] = useState(false);
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    let wasNearEnd = false;
    function updateNearEnd() {
      const remaining = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
      const nearEnd = remaining <= 240;
      if (nearEnd === wasNearEnd) return;
      wasNearEnd = nearEnd;
      setFocusOnOpen(false);
      setOpen(nearEnd);
    }
    updateNearEnd();
    window.addEventListener("scroll", updateNearEnd, { passive: true });
    window.addEventListener("resize", updateNearEnd);
    const observer = new ResizeObserver(updateNearEnd);
    observer.observe(document.body);
    return () => {
      window.removeEventListener("scroll", updateNearEnd);
      window.removeEventListener("resize", updateNearEnd);
      observer.disconnect();
    };
  }, []);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <div
      className="newsletter-dock"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          close();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="newsletter-toggle"
        aria-label={open ? "Close newsletter signup" : "Subscribe to newsletter"}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          if (open) close();
          else {
            setFocusOnOpen(true);
            setOpen(true);
          }
        }}
      >
        {open ? <FiX size={22} aria-hidden="true" /> : <FiBell size={22} strokeWidth={1.7} aria-hidden="true" />}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={id}
            className="newsletter-expand"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: "auto", opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="newsletter-panel">
              <EmailSubscription focusOnMount={focusOnOpen} showHelper={false} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
