import { kaomoji } from "public/kaomoji";

export const metadata = {
  title: "kaomoji",
  description: "the most complete kaomoji library in the world",
};

export default function page() {
  const list = Object.keys(kaomoji).map((key: string) => {
    const randomSubset = kaomoji[key].sort(() => Math.random() - 0.5).slice(0, 7);
    const kaomojis = randomSubset.map((emote: any) => {
      return <div key={emote}>{emote}</div>;
    });

    return (
      <div key={key} className="flex w-64 h-80 items-center flex-col gap-2">
        <b className="text-xl">{key}</b>
        <div className="flex text-lg flex-col text-center gap-2">{kaomojis}</div>
      </div>
    );
  });

  return (
    <div className="flex w-screen absolute place-items-center items-center inset-0 font-mono top-20 justify-center flex-wrap gap-10 p-4">
      {list}
    </div>
  );
}
