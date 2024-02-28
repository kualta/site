import ThemeToggle, { BackButton } from "@/components/MetaButton";
import "styles/globals.css";
import { Analytics } from "@vercel/analytics/react";
import Link from "next/link";
import { fredoka } from "styles/fonts";
import { IsChristmas, Snow } from "@/components/Effects";
import { CornersScope } from "@/components/CornersScope";
import { Card } from "@/components/Card";
import { FiBell } from "react-icons/fi";

export const metadata = {
  metadataBase: new URL("https://kualta.dev"),
  title: "kualta",
  keywords: [
    "kualta",
    "kualts",
    "kualta.dev",
    "kualta.com",
    "kualta.art",
    "kualta gallery",
    "kualtaagency.com",
    "kualtadev",
    "kuollut",
    "kualta agency",
    "kualta digital marketing",
    "ku",
    "kualta website",
    "kualta blog",
    "ai",
    "artificial intelligence",
    "artificial intelligence blog",
    "artificial intelligence website",
    "philosophy",
    "philosophy blog",
    "philosophy website",
    "kualta philosophy",
    "kualta philosophy blog",
    "kualta philosophy website",
    "philosophy in the mad world",
    "beauty in the mad world",
  ],
  robots: {
    index: false,
    follow: true,
    nocache: true,
    googleBot: {
      index: true,
      follow: false,
      noimageindex: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  twitter: {
    card: "/og_image.png",
    title: "kualta.dev",
    description: "glimse into the void",
    creator: "@kualts",
  },
  category: "blog",
  openGraph: {
    images: "/og_image.png",
  },
  description: "glimpse into the void",
  url: "https://kualta.dev",
  icons: {
    icon: "/icon.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="scroll-smooth dark">
      <head />
      <body
        className={`bg-bg dark:bg-dark-bg disable-scrollbars text-text transition-all 
        ease-in-out delay-150 dark:text-dark-text place-items-center w-screen 
        min-h-screen flex flex-col justify center relative ${fredoka.className}`}
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

        <div className="flex flex-col items-center grow w-full h-full">{children}</div>

        <div className="hidden sm:flex  border-text dark:border-dark-text">
          <CornersScope />
        </div>

        <div className="hidden sm:flex absolute top-0 right-0 p-5 m-4">
          <Link className="active:text-secondary-text" href="/join">
            <FiBell size={20} />
          </Link>
        </div>

        <Analytics />
      </body>
    </html>
  );
}
