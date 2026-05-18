import { useEffect, useState } from "react";

interface Props {
  toc: (string | null)[];
}

export default function TableOfContents({ toc }: Props) {
  const hash = useHash();

  return (
    <div className="top-10 left-16 fixed hidden lg:flex flex-col gap-3">
      <ol className="list-decimal">
        {toc.map((element) => {
          if (!element) return null;
          const link = element
            .replace(/[.,/#!$%^&*;:{}'=_`~()]/g, "")
            .split(" ")
            .join("-")
            .slice(1)
            .toLowerCase()
            .replace(/^/, "#");
          const text = element.replaceAll("#", "");
          const className = hash === link ? " font-bold" : "";
          return (
            <li key={link} className={className}>
              <a href={link}>{text}</a>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function useHash() {
  const [hash, setHash] = useState("");

  useEffect(() => {
    setHash(window.location.hash);
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return hash;
}
