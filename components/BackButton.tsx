"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MdArrowBack } from "react-icons/md";
import { MetaButton } from "./MetaButton";

export default function BackButton() {
  const path = usePathname();
  const isMainPage = path === "/";

  if (isMainPage) {
    return null;
  }

  return (
    <MetaButton>
      <Link href={"/"}>
        <MdArrowBack />
      </Link>
    </MetaButton>
  );
}
