import { useEffect, useState } from "react";

interface Heading {
  depth: number;
  slug: string;
  text: string;
}

interface Props {
  headings: Heading[];
}

export default function TableOfContents({ headings }: Props) {
  const hash = useHash();

  return (
    <div className="top-10 left-16 fixed hidden lg:flex flex-col gap-3">
      <ol className="list-decimal">
        {headings.map((heading) => {
          const link = `#${heading.slug}`;
          const className = hash === link ? " font-bold" : "";
          return (
            <li key={heading.slug} className={className}>
              <a href={link}>{heading.text}</a>
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
