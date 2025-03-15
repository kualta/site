import { CornersScope } from "@/components/CornersScope";
import Sticker from "@/components/Sticker";
import { EmailSubscription } from "@/components/SubscriptionBox";
import { FiAtSign } from "react-icons/fi";
import { RiDiscordFill } from "react-icons/ri";
import { SiMatrix } from "react-icons/si";

export const metadata = {
  title: "join",
  description: "join kunet",
};

export default function page() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 p-10 px-16 mb-32 relative">
        <CornersScope top_left={false} bottom_right={false} />
        <h1 className="text-3xl font-bold text-center">Subscribe</h1>
        <EmailSubscription />
        <p className="text-lg sm:text-xl text-center p-4 pt-0">
          Kurier will deliver latest articles <br /> right into your mailbox.
        </p>
        <Sticker
          name="kurier"
          className="hidden sm:flex absolute w-32 h-32 md:w-48 md:h-48 -right-10 -bottom-10 md:-right-24 md:-bottom-24"
        />
      </div>
    </div>
  );
}
