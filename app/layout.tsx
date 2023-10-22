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

import { FadeIn } from "@/components/FadeIn";
import Link from "next/link";
import { gilda } from "styles/fonts";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head />

      <body
        className={`bg-bg dark:bg-dark-bg text-text transition-all ease-in-out delay-150 dark:text-dark-text h-screen w-screen ${gilda.className}`}
      >
        <div className="fixed top-0 left-0 m-2">
          <BackButton />
        </div>
        <div className="flex flex-row place-content-center gap-12 text-3xl tracking-wide w-full h-fit">
          <Link className="p-4" href="/projects">
            projects
          </Link>
          <Link className="p-4" href="/posts">
            posts
          </Link>
          <Link className="p-4" href="/contacts">
            contacts
          </Link>
        </div>
        <div className="fixed top-0 right-0 flex-col flex m-2">
          <ThemeToggle />
        </div>
        <div className="flex flex-col w-full h-full grow">
          <FadeIn>{children}</FadeIn>
        </div>
      </body>
    </html>
  );
}
