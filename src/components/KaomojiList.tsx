import { useEffect, useState, type ReactNode } from "react";
import { kaomoji } from "@/data/kaomoji";

export default function KaomojiList() {
  const [list, setList] = useState<ReactNode[]>([]);

  useEffect(() => {
    const built = Object.keys(kaomoji).map((key) => {
      const randomSubset = [...kaomoji[key]].sort(() => Math.random() - 0.5).slice(0, 7);
      return (
        <div key={key} className="flex w-64 h-80 items-center flex-col gap-2">
          <b className="text-xl">{key}</b>
          <div className="flex text-lg flex-col text-center gap-2">
            {randomSubset.map((emote) => (
              <div key={crypto.randomUUID()}>{emote}</div>
            ))}
          </div>
        </div>
      );
    });
    setList(built);
  }, []);

  return (
    <div className="flex w-full place-items-center items-center font-mono justify-center flex-wrap gap-10">
      {list}
    </div>
  );
}
