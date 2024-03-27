import { CornersScope } from "@/components/CornersScope";
import { MetaButton } from "@/components/MetaButton";
import Image from "next/image";
import Link from "next/link";
import { FiHome } from "react-icons/fi";
import { LuMessageSquare } from "react-icons/lu";
import { MdArrowBack, MdHome } from "react-icons/md";

export const metadata = {
  title: "about",
  description: "about kualta",
};

export default function page() {
  return (
    <div className="my-auto ">
      <div className="relative flex flex-col place-items-center justify-center gap-4 sm:p-10">
        <div className="w-[30vh] h-[30vh] sm:w-[40vh] sm:h-[40vh] overflow-hidden relative">
          <Image
            priority
            src="/images/stickers/kumeditate.png"
            alt="a kuollut meditating, view from the back"
            fill={true}
          />
        </div>
        <div className="flex flex-col place-items-center justify-center gap-4 sm:p-4 relative">
          <CornersScope className="hidden sm:flex" top_right={false} bottom_left={false} />
          <h1 className="text-xl sm:text-2xl  text-center sm:px-8 sm:p-2">
            If you're going to try, go all the way. <br />
            Otherwise, don't even start.
          </h1>
        </div>
      </div>
      {/* <div className="flex flex-row place-items-center justify-center gap-4 sm:gap-8 p-4">
        <MetaButton>
          <Link href={"/"}>
            <MdArrowBack size={25} />
          </Link>
        </MetaButton>
        <MetaButton>
          <Link href={"/"}>
            <FiHome size={25} />
          </Link>
        </MetaButton>
        <MetaButton>
          <Link href={"/"}>
            <LuMessageSquare size={25} />
          </Link>
        </MetaButton>
      </div> */}
    </div>
  );
}
