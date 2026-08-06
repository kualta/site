import type { ReactNode, Ref, UIEventHandler } from "react";

interface Props {
  children: ReactNode;
  className?: string;
  ref?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
}

/** A scroll area that keeps a slim visible scrollbar, unlike the rest of the site. */
export function Scrollable({ children, className = "", ref, onScroll }: Props) {
  return (
    <div ref={ref} onScroll={onScroll} className={`pretty-scroll min-h-0 flex-1 ${className}`}>
      {children}
    </div>
  );
}
