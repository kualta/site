"use client";

import { EtheriumIcon } from "@/components/Icons";
import toast from "react-hot-toast";
import { FiCopy } from "react-icons/fi";

export function EtheriumButton() {
  const etheriumAdderess = "0xDeAd010d1c8f9B463F5dE853902761Cdbac53fb7";

  return (
    <button
      type="button"
      className="w-full flex flex-row items-baseline gap-2 hover:opacity-70 text-lg"
      onClick={async () => {
        await navigator.clipboard.writeText(etheriumAdderess);
        toast.success("Copied EVM address to clipboard!");
      }}
    >
      <span className="flex items-center"><EtheriumIcon size={22} /></span>
      <span className="font-medium whitespace-nowrap">kualta.eth</span>
      <span className="flex-grow border-b border-dotted border-secondary-text opacity-50" />
      <span className="text-sm text-secondary-text whitespace-nowrap flex items-center gap-1">copy <FiCopy size={14} /></span>
    </button>
  );
}
