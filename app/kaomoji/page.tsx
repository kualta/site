import { kaomoji } from "public/kaomoji";
import KaomojiPage from "./KaomojiPage";
import { useId } from "react";

export const metadata = {
  title: "kaomoji",
  description: "the most complete kaomoji library in the world",
};

export default function page() {
  return <KaomojiPage />;
}
