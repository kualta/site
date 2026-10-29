import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";

interface Props {
  children: ReactNode;
  className?: string;
  ref?: Ref<HTMLDivElement>;
  /** dissolve whichever edge has content hidden behind it */
  fade?: boolean;
}

/** A scroll area that keeps a slim visible scrollbar, unlike the rest of the site. */
export function Scrollable({ children, className = "", ref, fade = false }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });

  const readEdges = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const top = container.scrollTop > 4;
    const bottom = container.scrollTop + container.clientHeight < container.scrollHeight - 4;
    setEdges((previous) => (previous.top === top && previous.bottom === bottom ? previous : { top, bottom }));
  }, []);

  // the panel and its contents both change height (a resized window, a filtered list),
  // and either can bring an edge into view or hide one without a scroll
  useEffect(() => {
    const container = scrollRef.current;
    if (!fade || !container) return;
    readEdges();
    const observer = new ResizeObserver(readEdges);
    observer.observe(container);
    for (const child of container.children) observer.observe(child);
    return () => observer.disconnect();
  }, [fade, readEdges]);

  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const veil = fade ? `scroll-fade ${edges.top ? "fade-top" : ""} ${edges.bottom ? "fade-bottom" : ""}` : "";

  return (
    <div
      ref={attach}
      onScroll={fade ? readEdges : undefined}
      className={`pretty-scroll min-h-0 flex-1 ${veil} ${className}`}
    >
      {children}
    </div>
  );
}
