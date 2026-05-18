import { useEffect, useState } from "react";
import { MdArrowBack } from "react-icons/md";

export function BackButton() {
  const [path, setPath] = useState("/");

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
      <a href="/">
        <MdArrowBack size={22} />
      </a>
    </div>
  );
}
