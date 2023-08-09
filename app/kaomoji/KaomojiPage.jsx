"use client";

import { kaomoji } from "public/kaomoji";
import { useEffect, useId, useState } from "react";
import dynamic from "next/dynamic";

export default function KaomojiPage() {
  const [list, setList] = useState();

  useEffect(() => {
    const list = Object.keys(kaomoji).map((key) => {
      const randomSubset = kaomoji[key].sort(() => Math.random() - 0.5).slice(0, 7);
      const kaomojis = randomSubset.map((emote) => {
        return <div key={crypto.randomUUID()}>{emote}</div>;
      });

      return (
        <div key={key} className="flex w-64 h-80 items-center flex-col gap-2">
          <b className="text-xl">{key}</b>
          <div className="flex text-lg flex-col text-center gap-2">{kaomojis}</div>
        </div>
      );
    });
    setList(list);
  }, []);

  return (
    <div className="flex w-full place-items-center items-center font-mono justify-center flex-wrap gap-10">{list}</div>
  );
}
