import SubscriptionBox from "../../components/SubscriptionBox";
import { FiAtSign } from "react-icons/fi";
import { RiDiscordFill } from "react-icons/ri";
import { TbBox } from "react-icons/tb";
import { SiMatrix } from "react-icons/si";
import { Card } from "@/components/Card";

export const metadata = {
  title: "Subscribe",
  description: "Subscribe to Kunet News",
};

export default function page() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-3xl font-bold text-center mt-8">Subscribe</h1>
      <SubscriptionBox />
      <p className="text-2xl p-4">Kurier will deliver latest news and events right into your mailbox.</p>

      <h1 className="text-3xl font-bold text-center mt-32">Join Kunet</h1>
      <div className="px-4">
        <Card>
          <div className="flex flex-row gap-4 place-content-around items-center ">
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
        </Card>
      </div>
      <div className="text-2xl place-items-center justify-center flex flex-row gap-2">
        An open community. <b className="drop-shadow-glow">You're invited.</b>
      </div>
    </div>
  );
}
