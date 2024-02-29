import Gallery from "@/components/Gallery";
import { FadeIn } from "@/components/Transitions";

export const metadata = {
  title: "gallery",
  description: "kualta's art gallery portal",
};

async function GalleryPage() {
  return (
    <FadeIn>
      <div className={"flex justify-center items-center flex-col gap-4 mt-16"}>gallery</div>
      <Gallery />
    </FadeIn>
  );
}

export default GalleryPage;
