import { useEffect, useState } from "react";
import { MdArrowBack } from "react-icons/md";

/**
 * `path` arrives from the server so the link is in the markup on first paint —
 * it used to start as "/" on every page, which rendered an empty box and left
 * the site with no link home for anything that does not run scripts.
 */
export function BackButton({ path: initial = "/" }: { path?: string }) {
  const [path, setPath] = useState(initial);

  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    update();
    document.addEventListener("astro:after-swap", update);
    return () => document.removeEventListener("astro:after-swap", update);
  }, []);

  if (path === "/") {
    return <div className="sm:w-8 sm:h-8" />;
  }

  return (
    <div className="w-8 h-8 flex items-center justify-center rounded-xl active:text-secondary-text">
      <a href="/" aria-label="Home">
        <MdArrowBack size={22} aria-hidden="true" />
      </a>
    </div>
  );
}
