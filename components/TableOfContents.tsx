"use client";

export function TableOfContents({ toc }: { toc: (string | null)[] }) {
  const table = toc.map((element) => {
    const link = element
      ?.replace(/[.,\/#!$%\^&\*;:{}'=\-_`~()]/g, "")
      .split(" ")
      .join("-")
      .slice(1)
      .toLowerCase()
      .replace(/^/, "#");

    const text = element?.replaceAll("#", "");

    if (element)
      return (
        <a href={link} className="text-md" key={`${link}`}>
          {text}
        </a>
      );
  });

  return <div className="top-10 left-[70%] fixed hidden 2xl:flex flex-col gap-2">{table}</div>;
}
