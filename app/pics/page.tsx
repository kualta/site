import { GET, getRandomImage } from "app/api/image/route";
import { ImagePage } from "./ImagePage";

async function page() {
  const { url } = await (await getRandomImage()).json();

  return (
    <div className="flex flex-col justify-center place-items-center gap-8 text-3xl">
      <h1>THIS KUOLLUT DOES NOT EXIST</h1>
      <ImagePage url={url} />
    </div>
  );
}

export default page;
