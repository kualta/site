import Image from "next/image";

export default function Sticker(props: { name: string; width?: number; height?: number; className?: string }) {
  return (
    <Image
      className={props.className}
      alt={`${props.name} sticker`}
      src={`/images/stickers/${props.name}.png`}
      width={props.width || 512}
      height={props.height || 512}
      priority={true}
    />
  );
}
