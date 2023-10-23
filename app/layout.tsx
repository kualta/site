import ThemeToggle, { BackButton } from "@/components/MetaButton";
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
import { fredoka } from "styles/fonts";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head />
      <body className={`bg-bg dark:bg-dark-bg text-text transition-all ease-in-out delay-150 dark:text-dark-text place-items-center w-screen min-h-screen flex flex-col justify center relative + ${fredoka.className}`}>
        <div className="noise" />
        <div
          className={"flex flex-row place-content-around text-xl sm:text-2xl tracking-wide max-w-2xl w-full h-fit "}
        >
          <div className="p-3">
            <BackButton />
          </div>
          <Link className="p-4" href="/projects">
            projects
          </Link>
          <Link className="p-4" href="/posts">
            posts
          </Link>
          <Link className="p-4" href="/contacts">
            contacts
          </Link>
          <div className="p-3">
            <ThemeToggle />
          </div>
        </div>
        <div className="flex flex-col grow w-full max-w-2xl">
          <FadeIn>{children}</FadeIn>
        </div>
      </body>
    </html>
  );
}
