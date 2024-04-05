import { FiAtSign } from "react-icons/fi";
import { RiDiscordFill, RiTwitterXFill, RiTwitterXLine } from "react-icons/ri";
import { TbBox } from "react-icons/tb";
import { SiMatrix } from "react-icons/si";
import { Card } from "@/components/Card";
import { CornersScope } from "@/components/CornersScope";
import Sticker from "@/components/Sticker";
import { EmailSubscription } from "@/components/SubscriptionBox";

export const metadata = {
  title: "join",
  description: "join kunet",
};

export default function page() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col place-items-center justify-center gap-4 p-10 mt-20 relative">
        <CornersScope top_left={false} bottom_right={false} />
        <h1 className="text-3xl font-bold text-center">Subscribe</h1>
        <EmailSubscription />
        <p className="text-lg sm:text-xl text-center p-4 pt-0">
          Kurier will deliver latest news <br /> and events right into your mailbox.
        </p>
        <Sticker
          name="kurier"
          className="hidden sm:flex absolute w-32 h-32 md:w-48 md:h-48 -right-10 -bottom-10 md:-right-24 md:-bottom-24"
        />
      </div>

      <div className="flex flex-col gap-4 p-10 mt-20 relative">
        <CornersScope top_right={false} bottom_left={false} />
        <h1 className="text-3xl font-bold text-center">Notifications</h1>
        <div className="px-4 min-w-0">
          <div className="flex flex-wrap gap-10 sm:gap-20 py-4 sm:px-4 place-content-around items-center ">
            <a
              href="https://twitter.com/kualts"
              className="flex flex-col justify-center items-center hover:drop-shadow-glow hover:transition-all hover:duration-300 hover:cursor-pointer"
              target="_blank"
              rel="noreferrer"
            >
              Twitter
              <RiTwitterXFill size={32} />
            </a>
            <a
              href="https://discord.gg/DhMeQAXW4F"
              className="flex flex-col justify-center items-center hover:drop-shadow-glow hover:transition-all hover:duration-300 hover:cursor-pointer"
              target="_blank"
              rel="noreferrer"
            >
              Discord
              <RiDiscordFill size={32} />
            </a>
            <a
              href="https://lensfrens.xyz/kualta"
              className="flex flex-col justify-center items-center hover:drop-shadow-glow hover:transition-all hover:duration-300 hover:cursor-pointer"
              target="_blank"
              rel="noreferrer"
            >
              Lens
              <FiAtSign size={32} />
            </a>
            <div className="opacity-50 flex flex-col justify-center items-center gap-2">
              Matrix
              <SiMatrix size={30} />
              Soon
            </div>
            {/* <div className="opacity-50 flex flex-col justify-center items-center gap-2">
              Ping
              <FiAtSign size={30} />
              Soon
            </div> */}
            {/* <div className="opacity-50 flex flex-col justify-center items-center gap-2">
              Black Box
              <TbBox size={32} />
              Soon
            </div> */}
          </div>
        </div>
        <div className="text-lg sm:text-xl place-items-center justify-center flex flex-row gap-2">
          Follow to not miss anything
        </div>
      </div>
    </div>
  );
}
