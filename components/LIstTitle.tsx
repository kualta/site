import Link from "next/link";

export const LinkHeader = (props: { href: string; text: string }) => {
  return (
    <Link
      href={props.href}
      className={
        "flex items-center text-base font-mono underline-offset-4 align-text-top font-semibold group text-center hover:underline "
      }
    >
      {props.text}
    </Link>
  );
};
