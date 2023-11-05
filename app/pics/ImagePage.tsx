"use client"
import Image from "next/image";

export const ImagePage = (props: { url: string }) => (
  <div className="w-64 h-auto">
    <Image
      src={props.url}
      className="rounded-lg"
      style={{ width: "100%", height: "auto" }}
      width={1000}
      height={1000}
      alt="a random kuollut"
    />
  </div>
);
