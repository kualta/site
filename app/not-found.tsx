import Image from "next/image";

async function NotFoundPage() {
  return (
    <div className={"flex flex-col w-full grow justify-center place-content-center font-bold select-none"}>
      <div className="flex flex-col sm:flex-row items-center justify-center drop-shadow-glow">
        <h3 className="text-2xl p-8 sm:p-0">You're looking for something that simply isn't there. 404.</h3>
        <Image
          className="select-none"
          src="/404_image.png"
          alt="kuollut on a throne drinking wine"
          width={300}
          height={300}
        />
      </div>
    </div>
  );
}

export default NotFoundPage;
