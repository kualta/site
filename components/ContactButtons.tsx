"use client";

import { Card } from "@/components/Card";
import { EtheriumIcon } from "@/components/Icons";
import toast from "react-hot-toast";
import { FiCopy, FiDownload } from "react-icons/fi";
import { LuKeyRound } from "react-icons/lu";

export function PGPButton() {
  return (
    <a
      type="button"
      href="/keys/kualta_pgp.asc"
      download={"kualta_pgp.asc"}
      onClick={async () => {
        toast.loading("Downloading PGP key...", { id: "pgp" });
        // sleep for 1s
        await new Promise((resolve) => setTimeout(resolve, 500));
        toast.success("Downloaded PGP key!", { id: "pgp" });
      }}
    >
      <Card>
        <div className={"flex justify-center flex-row gap-4 p-1 w-64"}>
          <LuKeyRound size={22} />
          <p className="grow text-left">PGP key</p>
          <FiDownload size={21} className="text-secondary-text -mr-0.5" />
        </div>
      </Card>
    </a>

  );
}

export function EtheriumButton() {
  const etheriumAdderess = "0xDeAd010d1c8f9B463F5dE853902761Cdbac53fb7";

  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(etheriumAdderess);
        toast.success("Copied EVM address to clipboard!");
      }}
    >
      <Card>
        <div className={"flex justify-center flex-row gap-4 p-1 w-64"}>
          <EtheriumIcon size={22} />
          <p className="text-left grow">kualta.eth</p>
          <FiCopy size={21} className="text-secondary-text -mr-0.5" />
        </div>
      </Card>
    </button>

  );
}
