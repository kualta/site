"use client";
import Link from "next/link";

export const LinkHeader = (props: { href: string; text: string }) => {
  return (
    <Link href={props.href} className={"hover:underline font-bold"}>
      {props.text}
    </Link>
  );
};

export function DataList({ data }: { data: any[] }) {
  return (
    <span className="flex flex-col space-y-2 pl-4 pt-2">
      {data.map((data) => {
        const link = data.link ? data.link : data.git_link;
        const name = data.name ? data.name : data.platform;
        const description = data.name ? data.description : data.label;

        return (
          <a
            className="w-fit items-center hover:underline"
            href={link}
            key={data.link + data.name + data.date}
          >
            <b>{name}</b>
            {" - "}
            <span>{description}</span>
          </a>
        );
      })}
    </span>
  );
}
