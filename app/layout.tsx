import ThemeToggle, { BackButton } from "@/components/MetaButton";
import "styles/globals.css";
import { Analytics } from "@vercel/analytics/react";

export const metadata = {
  title: "kualta",
  description: "unite the universe",
  icons: {
    icon: "/icon.png",
  },
};

import Link from "next/link";
import { fredoka } from "styles/fonts";
import { IsChristmas, Snow } from "@/components/Effects";
import { CornersScope } from "@/components/CornersScope";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head />
      <body
        className={`bg-bg dark:bg-dark-bg disable-scrollbars text-text transition-all ease-in-out delay-150 dark:text-dark-text place-items-center w-screen min-h-screen flex flex-col justify center relative ${fredoka.className}`}
      >
        <div className="noise" />

        <IsChristmas>
          <Snow />
        </IsChristmas>

        <div
          className={
            "z-[100] flex flex-row place-content-between text-xl sm:text-2xl tracking-wide max-w-2xl w-full h-fit m-4 p-4"
          }
        >
          <div>
            <BackButton />
          </div>
          <Link className="active:text-secondary-text" href="/projects">
            projects
          </Link>
          <Link className="active:text-secondary-text" href="/posts">
            posts
          </Link>
          <Link className="active:text-secondary-text" href="/contacts">
            contacts
          </Link>
          <div>
            <ThemeToggle />
          </div>
        </div>
        <div className="flex flex-col grow w-full max-w-2xl h-full">{children}</div>
        <div className="hidden sm:flex -z-10 border-text dark:border-dark-text">
          <CornersScope />
        </div>
        <Analytics />
      </body>
    </html>
  );
}
