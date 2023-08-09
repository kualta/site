"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MdArrowBack } from "react-icons/md";
import { MetaButton } from "./MetaButton";
import { FiGithub } from "react-icons/fi";

export default function GitButton() {
  const path = usePathname();
  const isRepoPage = path.includes("repo")

  if (isRepoPage) {
    return null;
  }

  return (
    <MetaButton>
      <Link href={"/repo/kualta"}>
        <FiGithub strokeWidth={2.5} />
      </Link>
    </MetaButton>
  );
}
