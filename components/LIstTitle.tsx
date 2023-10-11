import Link from "next/link";

export const LinkHeader = (props: { href: string; text: string }) => {
  return (
    <Link href={props.href} className={"hover:text-primary hover:dark:text-dark-primary font-mono font-bold"}>
      {props.text}
    </Link>
  );
};
