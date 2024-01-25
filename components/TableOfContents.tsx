"use client";

import { useEffect, useState } from "react";

export function TableOfContents({ toc }: { toc: (string | null)[] }) {
  const table = toc.map((element) => {
    const link = element
      ?.replace(/[.,\/#!$%\^&\*;:{}'=\_`~()]/g, "")
      .split(" ")
      .join("-")
      .slice(1)
      .toLowerCase()
      .replace(/^/, "#");

    const text = element?.replaceAll("#", "");
    const hash = useHash();

    const className = hash === link ? " font-bold" : "";
    const [isMounted, setMounted] = useState(false);

    useEffect(() => {
      if (!isMounted) {
        setMounted(true);
      }
    }, [isMounted]);

    if (!isMounted) return null;

    if (element)
      return (
        <li key={`${link}`} className={className}>
          <a href={link}>{text}</a>
        </li>
      );
  });

  return (
    <div className="top-10 left-10 text-right fixed hidden 2xl:flex flex-col gap-3">
      <ol className="">{table}</ol>
    </div>
  );
}

export function useHash() {
  const [isMounted, setMounted] = useState(false);
  const [hash, setHash] = useState("");

  useEffect(() => {
    const hashChange = () => {
      if (isMounted && window?.location?.hash) {
        setHash(window.location.hash);
      } else {
        setMounted(true);
      }
    };

    window.addEventListener("hashchange", hashChange);

    return () => {
      window.removeEventListener("hashchange", hashChange);
    };
  }, [isMounted]);

  return hash;
}
