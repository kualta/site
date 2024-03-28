import { CornersScope } from "@/components/CornersScope";
import { SubscriptionBox } from "@/components/SubscriptionBox";
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
    <div className="my-auto flex flex-col items-center justify-center">
      <div className="relative flex flex-col place-items-center justify-center gap-4 sm:p-10">
        <div className="w-[30vh] h-[30vh] sm:w-[40vh] sm:h-[40vh] overflow-hidden relative">
          {/* <CornersScope className="hidden sm:flex" bottom_left={false} top_right={false} /> */}
          <Image
            priority
            src="/images/stickers/kumeditate.png"
            alt="a kuollut meditating, view from the back"
            fill={true}
          />
        </div>
        <div className="flex flex-col place-items-center justify-center gap-4 sm:p-4 relative">
          <CornersScope className="hidden sm:flex" top_left={false} bottom_right={false} />
          <h1 className="text-2xl   text-center sm:px-8 sm:p-2">
            If you're going to try, go all the way. <br />
            Otherwise, don't even start.
          </h1>
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
  );
}
