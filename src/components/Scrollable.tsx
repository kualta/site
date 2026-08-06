import type { ReactNode, Ref } from "react";

interface Props {
  children: ReactNode;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** A scroll area that keeps a slim visible scrollbar, unlike the rest of the site. */
export function Scrollable({ children, className = "", ref }: Props) {
  return (
    <div ref={ref} className={`pretty-scroll min-h-0 flex-1 ${className}`}>
      {children}
    </div>
  );
}
