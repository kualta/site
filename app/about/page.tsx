import { Card } from "@/components/Card";
import { CornersScope } from "@/components/CornersScope";
import { SubscriptionBox } from "@/components/SubscriptionBox";
import { FadeIn } from "@/components/Transitions";
import Roadmap from "app/roadmap/page";
import Image from "next/image";

export const metadata = {
  title: "about",
  description: "kualta's vision",
  keywords: [
    "about kualta",
    "about kualta.dev",
    "about kualta.com",
    "about kualta art",
    "about ku",
    "about kualta website",
    "about kualta blog",
    "about kualta philosophy",
  ],
};

export default function page() {
  return (
    <FadeIn>
      <div className="my-auto flex flex-col items-center justify-center">
        <div className="relative flex flex-col place-items-center justify-center gap-4 sm:p-10">
          <div className="flex flex-col place-items-center justify-center gap-4 sm:p-4 relative">
            <div className="border-l-2 border-primary">
              <h1 className="text-lg text-left p-2 py-1">
                if you're going to try, go all the way. otherwise, don't even start.
              </h1>
            </div>
          </div>
        </div>

        <div className="flex flex-col place-items-center justify-center w-fit relative">
          <CornersScope className="hidden sm:flex" />
          <div className="px-14">
            <Roadmap />
          </div>
        </div>
        <div className="sm:mt-10">
          <SubscriptionBox />
        </div>
      </div>
    </FadeIn>
  );
}
