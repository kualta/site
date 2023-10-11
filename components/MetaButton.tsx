"use client";

import { PropsWithChildren } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MdArrowBack } from "react-icons/md";
import { FiGithub, FiGlobe } from "react-icons/fi";
import { TbEqualDouble } from "react-icons/tb";

export const MetaButton = (props: PropsWithChildren) => {
  return (
    <div
      className="w-8 h-8 flex items-center justify-center rounded-md 
      hover:text-primary hover:dark:text-dark-primary 
      hover:shadow-primary/30 hover:dark:shadow-dark-primary/50 
      dark:shadow-dark-text/50 shadow-md bg-secondary dark:bg-dark-secondary m-2"
    >
      {props.children}
    </div>
  );
};

export function MojiButton() {
  const path = usePathname();
  const isRepoPage = path.includes("kaomoji");

  if (isRepoPage) {
    return null;
  }

  return (
    <MetaButton>
      <Link href={"/kaomoji"}>
        <TbEqualDouble strokeWidth={2} />
      </Link>
    </MetaButton>
  );
}

export function BackButton() {
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

export function GitButton() {
  const path = usePathname();
  const isRepoPage = path.includes("repo");

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

export function KunetButton() {
  const path = usePathname();
  const isRepoPage = path.includes("kunet");

  if (isRepoPage) {
    return null;
  }

  return (
    <MetaButton>
      <Link href={"/kunet"}>
        <FiGlobe />
      </Link>
    </MetaButton>
  );
}
