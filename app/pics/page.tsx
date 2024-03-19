import { getRandomImage } from "prisma/dataFetch";
import { CornersScope } from "@/components/CornersScope";

export const revalidate = 0;

export const metadata = {
  title: "pics",
  description: "AI-generated kuolluts",

};

async function page() {
  const { url } = await (await getRandomImage()).json();

  return (
    <div className="flex flex-col justify-center place-items-center place-content-center my-auto gap-2 sm:gap-8">
      <h1 className="uppercase text-xl sm:text-3xl">this kuollut does not exist</h1>
      <div className="relative">
        <CornersScope />
        <div className="m-10">
          <img src={url} alt="" className="rounded-xl w-56 h-56 sm:w-96 sm:h-96 aspect-square object-cover" />
        </div>
      </div>
      <h1 className="uppercase text-xl sm:text-3xl">but do you?</h1>
    </div>
  );
}

export default page;
