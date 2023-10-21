import ThemeToggle, { BackButton } from "@/components/MetaButton";
import Polyhedron from "@/components/Polyhedron";
import "styles/globals.css";

export const metadata = {
  title: "kualta",
  description: "kualta's website",
  icons: {
    icon: "/icon.png",
  },
};

import { Gilda_Display } from "next/font/google";
import { FadeIn } from "@/components/FadeIn";
import Link from "next/link";

const font = Gilda_Display({
  subsets: ["latin"],
  weight: "400",
  style: "normal",
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head />

      <body
        className={`p-2 md:p-10 py-auto bg-bg dark:bg-dark-bg text-text transition-all ease-in-out delay-150 dark:text-dark-text h-screen w-screen ${font.className}`}
      >
        <div className="fixed top-0 left-0 m-2">
          <BackButton />
        </div>
        <div className="flex flex-row place-content-center gap-12 text-3xl w-full h-fit">
          <Link href="/projects">projects</Link>
          <Link href="/posts">posts</Link>
          <Link href="/contacts">contacts</Link>
        </div>
        <div className="fixed top-0 right-0 flex-col flex m-2">
          <ThemeToggle />
        </div>
        <FadeIn>{children}</FadeIn>
      </body>
    </html>
  );
}
