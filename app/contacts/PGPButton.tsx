"use client";
import { Card } from "@/components/Card";
import { FiDownload, FiKey, FiLock } from "react-icons/fi";
import { MdKey } from "react-icons/md";
import { LuKeyRound, LuKeySquare } from "react-icons/lu";

export function PGPButton() {
  return (
    <Card>
      <a
        type="button"
        className={"flex gap-4 p-1 px-2 items-center w-60"}
        href="/keys/kualta_pgp.asc"
        download={"kualta_pgp.asc"}
      >
        <LuKeyRound size={22} />
        <p className="grow text-left">PGP Key</p>
        <FiDownload size={21} className="text-secondary-text" />
      </a>
    </Card>
  );
}
