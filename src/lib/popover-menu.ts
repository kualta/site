import { useEffect, useState, type RefObject } from "react";

/** Pin a fixed popover panel under its trigger, aligned to the trigger's start or end edge, and track whether it is open. */
export function usePopoverMenu(
  trigger: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  align: "start" | "end" = "end",
) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const menu = panel.current;
    if (!menu) return;
    function position() {
      const button = trigger.current;
      if (!button || !menu) return;
      const rect = button.getBoundingClientRect();
      if (align === "end") menu.style.right = `${Math.max(8, innerWidth - rect.right)}px`;
      else menu.style.left = `${Math.max(8, rect.left)}px`;
      menu.style.top = `${rect.bottom + 4}px`;
      if (menu.matches(":popover-open")) {
        const { height, width } = menu.getBoundingClientRect();
        menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - height - 8))}px`;
        if (align === "start") menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
      }
    }
    const toggle = (event: Event) => {
      const visible = (event as ToggleEvent).newState === "open";
      setOpen(visible);
      if (visible) {
        position();
        window.addEventListener("scroll", position, { passive: true });
        window.addEventListener("resize", position, { passive: true });
      } else {
        window.removeEventListener("scroll", position);
        window.removeEventListener("resize", position);
      }
    };
    menu.addEventListener("beforetoggle", position);
    menu.addEventListener("toggle", toggle);
    return () => {
      menu.removeEventListener("beforetoggle", position);
      menu.removeEventListener("toggle", toggle);
      window.removeEventListener("scroll", position);
      window.removeEventListener("resize", position);
    };
  }, [trigger, panel, align]);

  return open;
}
