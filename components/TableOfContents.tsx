"use client";

import { useEffect, useState } from "react";

export default function TableOfContents({ toc }: { toc: (string | null)[] }) {
  const hash = useHash();

  const table = toc.map((element) => {
    const link = element
      ?.replace(/[.,\/#!$%\^&\*;:{}'=\_`~()]/g, "")
      .split(" ")
      .join("-")
      .slice(1)
      .toLowerCase()
      .replace(/^/, "#");

    const text = element?.replaceAll("#", "");

    const className = hash === link ? " font-bold" : "";

    if (element)
      return (
        <li key={`${link}`} className={className}>
          <a href={link}>{text}</a>
        </li>
      );
  });

  return (
    <div className="top-10 left-16 fixed hidden lg:flex flex-col gap-3">
      <ol className="list-decimal">{table}</ol>
    </div>
  );
}

export function useHash() {
  const [isMounted, setMounted] = useState(false);
  const [hash, setHash] = useState("");

  useEffect(() => {
    const isClient = typeof window !== "undefined";

    if (isClient) {
      setHash(window.location.hash);
    }

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
