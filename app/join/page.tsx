import SubscriptionBox from "../../components/SubscriptionBox";
import { FiAtSign } from "react-icons/fi";
import { RiDiscordFill } from "react-icons/ri";
import { TbBox } from "react-icons/tb";
import { SiMatrix } from "react-icons/si";
import { Card } from "@/components/Card";
import { CornersScope } from "@/components/CornersScope";

export const metadata = {
  title: "Subscribe",
  description: "Subscribe to Kunet News",
};

export default function page() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 p-10 mt-20 relative">
        <CornersScope top_left={false} bottom_right={false} />
        <h1 className="text-3xl font-bold text-center">Subscribe</h1>
        <SubscriptionBox />
        <p className="text-xl text-center p-4 pt-0">
          Kurier will deliver latest news and events <br />
          right into your mailbox.
        </p>
      </div>

      <div className="flex flex-col gap-4 p-10 mt-20 relative">
        <CornersScope top_right={false} bottom_left={false} />
        <h1 className="text-3xl font-bold text-center ">Join Kunet</h1>
        <div className="px-4 min-w-0">
          <div className="flex flex-col sm:flex-row gap-20 py-4 sm:px-4 place-content-around items-center ">
            <a
              href="https://discord.gg/DhMeQAXW4F"
              className="flex flex-col justify-center items-center hover:drop-shadow-glow hover:transition-all hover:duration-300 hover:cursor-pointer"
              target="_blank"
              rel="noreferrer"
            >
              Discord
              <RiDiscordFill size={32} />
            </a>
            <div className="opacity-50 flex flex-col justify-center items-center gap-2">
              Matrix
              <SiMatrix size={30} />
              Soon
            </div>
            <div className="opacity-50 flex flex-col justify-center items-center gap-2">
              Ping
              <FiAtSign size={30} />
              Soon
            </div>
            <div className="opacity-50 flex flex-col justify-center items-center gap-2">
              Black Box
              <TbBox size={32} />
              Soon
            </div>
          </div>
        </div>
        <div className="text-xl place-items-center justify-center flex flex-row gap-2">
          An open community. <b className="drop-shadow-glow">Coming soon.</b>
        </div>
      </div>
    </div>
  );
}
