import { getRandomImage } from "prisma/dataFetch";
import Image from "next/image";

export const revalidate = 0;
// export const dynamic = "force-dynamic";

async function page() {
  const { url } = await (await getRandomImage()).json();

  return (
    <div className="flex flex-col justify-center place-items-center gap-8 text-3xl">
      <h1>THIS KUOLLUT DOES NOT EXIST</h1>
      <div className="w-64 h-auto">
        <Image
          src={url}
          className="rounded-lg"
          style={{ width: "100%", height: "auto" }}
          width={1000}
          height={1000}
          alt="a random kuollut"
        />
      </div>
    </div>
  );
}

export default page;
