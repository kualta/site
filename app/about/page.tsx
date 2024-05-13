import { Card } from "@/components/Card";
import { CornersScope } from "@/components/CornersScope";
import { SubscriptionBox } from "@/components/SubscriptionBox";
import { FadeIn } from "@/components/Transitions";

export const metadata = {
  title: "about",
  description: "kualta's vision",
  keywords: [
    "about ku",
    "about kunet",
    "about kudao",
    "about kudos",
    "about kualta",
    "about kuhaku",
    "about kualta.dev",
    "about kualta.com",
    "about kualta art",
    "about kualta blog",
    "about kualta website",
    "about kualta philosophy",
  ],
};

export default function page() {
  return (
    <FadeIn>
      <div className="my-auto flex flex-col items-center justify-center">
        <div style={{ pointerEvents: "none" }} className="select-none">
          <img className="min-w-64 shrink-0" src={"/planku.excalidraw.png"} alt="plan" />
        </div>
        <div className="sm:mt-10">
          <SubscriptionBox />
        </div>
      </div>
    </FadeIn>
  );
}
