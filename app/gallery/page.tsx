import Gallery from "@/components/Gallery";

export const metadata = {
  title: "gallery",
  description: "kualta's art gallery portal",
};

async function GalleryPage() {
  return (
    <>
      <div className={"flex justify-center items-center flex-col gap-4 mt-16"}>gallery</div>
      <Gallery />
    </>
  );
}

export default GalleryPage;
