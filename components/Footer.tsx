import Link from "next/link";

export default function Footer() {
  return (
    <div className="flex flex-row place-content-between w-full border-t dark:border-neutral-800 p-4 place-items-center ">
      <Link className="hover:underline" href="/blog">
        {"< back"}
      </Link>
    </div>
  );
}
