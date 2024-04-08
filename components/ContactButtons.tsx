"use client";

import { Card } from "@/components/Card";
import { LuKeyRound } from "react-icons/lu";
import { FiCopy, FiDownload } from "react-icons/fi";
import { EtheriumIcon } from "@/components/Icons";
import toast from "react-hot-toast";

export function PGPButton() {
  return (
    <Card>
      <a
        type="button"
        className={"flex gap-4 items-center w-60"}
        href="/keys/kualta_pgp.asc"
        download={"kualta_pgp.asc"}
        onClick={async () => {
          toast.loading("Downloading PGP key...", { id: "pgp" });
          // sleep for 1s
          await new Promise((resolve) => setTimeout(resolve, 500));
          toast.success("Downloaded PGP key!", { id: "pgp" });
        }}
      >
        <LuKeyRound size={22} />
        <p className="grow text-left">PGP key</p>
        <FiDownload size={21} className="text-secondary-text" />
      </a>
    </Card>
  );
}

export function EtheriumButton() {
  const etheriumAdderess = "0xDeAd010d1c8f9B463F5dE853902761Cdbac53fb7";
  return (
    <Card>
      <button
        type="button"
        className={"flex gap-4 items-center w-60"}
        onClick={async () => {
          await navigator.clipboard.writeText(etheriumAdderess);
          toast.success("Copied to clipboard!");
        }}
      >
        <EtheriumIcon size={22} />
        <p className="grow text-left">0xdead010...</p>
        <FiCopy size={21} className="text-secondary-text" />
      </button>
    </Card>
  );
}
