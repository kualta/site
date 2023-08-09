"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MdArrowBack } from "react-icons/md";
import { MetaButton } from "./MetaButton";
import { FiGithub } from "react-icons/fi";
import { TbEqualDouble } from "react-icons/tb";

export default function MojiButton() {
  const path = usePathname();
  const isRepoPage = path.includes("kaomoji");

  if (isRepoPage) {
    return null;
  }

  return (
    <MetaButton>
      <Link href={"/kaomoji"}>
        <TbEqualDouble strokeWidth={2.5} />
      </Link>
    </MetaButton>
  );
}
