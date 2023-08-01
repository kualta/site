import Link from "next/link";

export const LinkHeader = (props: { href: string; text: string }) => {
  return (
    <Link href={props.href} className={"hover:text-lit-accent hover:dark:text-dark-accent font-mono font-bold"}>
      {props.text}
    </Link>
  );
};
