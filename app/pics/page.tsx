import { getRandomImage } from "prisma/dataFetch";
import Image from "next/image";
import { CornersScope } from "@/components/CornersScope";
import Link from "next/link";

export const revalidate = 0;
// export const dynamic = "force-dynamic";

async function page() {
  const { url } = await (await getRandomImage()).json();

  return (
    <div className="flex flex-col justify-center place-items-center gap-8 text-3xl">
      <h1>THIS KUOLLUT DOES NOT EXIST</h1>
      <div className="w-70 h-70 relative ">
        <CornersScope />
        <div className="w-64 h-auto m-10">
          <Image
            src={url}
            className="rounded-xl"
            style={{ width: "100%", height: "auto" }}
            width={1000}
            height={1000}
            alt="a random kuollut"
          />
        </div>
      </div>
      <p className="text-xs text-secondary-text flex flex-row gap-4">
        <Link href="https://creativecommons.org/publicdomain/zero/1.0/">license</Link>
        <Link href={"/contacts"}>contact</Link> 
      </p>
    </div>
  );
}

export default page;
