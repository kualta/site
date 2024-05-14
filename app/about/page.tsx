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
      <div className="my-auto flex flex-col items-center justify-center relative">
        <div style={{ pointerEvents: "none" }} className="select-none ">
          <div className="absolute top-0 right-10 rounded-lg min-w-32 w-[15vw]">
            <img alt="plan legend" className="hidden dark:flex" src={"/images/planku/legend-dark.png"} />
            <img alt="plan" className="flex dark:hidden " src={"/images/planku/legend-light.png"} />
          </div>
          <img
            alt="kunet plan. can't see the picture? join discord!"
            className="hidden dark:flex object-scale-down min-h-screen"
            src={"/images/planku/planku-dark.excalidraw.png"}
          />
          <img
            alt="kunet plan. can't see the picture? join discord!"
            className="flex dark:hidden object-scale-down  m-auto"
            src={"/images/planku/planku-light.excalidraw.png"}
          />
        </div>
        <div className="sm:mt-10">
          <SubscriptionBox />
        </div>
      </div>
    </FadeIn>
  );
}
