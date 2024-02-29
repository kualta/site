import ThemeToggle, { BackButton } from "@/components/MetaButton";
import "styles/globals.css";
import { Analytics } from "@vercel/analytics/react";
import Link from "next/link";
import { fredoka } from "styles/fonts";
import { IsChristmas, Snow } from "@/components/Effects";
import { CornersScope } from "@/components/CornersScope";
import { FiBell } from "react-icons/fi";
import { Metadata } from "next";

export const metadata: Metadata = {
  metadataBase: new URL("https://kualta.dev"),
  title: {
    default: "kualta",
    template: "%s - kualta",
  },
  description: "glimpse into the void",
  keywords: [
    "kualta",
    "kualts",
    "kualta.dev",
    "kualta.com",
    "kualta.art",
    "kualta gallery",
    "kualtadev",
    "kuollut",
    "ku",
    "kualta website",
    "kualta blog",
    "ai blog",
    "philosophy",
    "philosophy blog",
    "kualta philosophy",
    "kualta philosophy blog",
    "kualta philosophy website",
    "beauty in the mad world",
  ],
  robots: {
    index: true,
    follow: true,
    nocache: true,
    googleBot: {
      index: true,
      follow: true,
      noimageindex: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  twitter: {
    card: "summary_large_image",
    images: "/og_image.png",
    title: "kualta.dev",
    description: "glimse into the void",
    creator: "@kualts",
  },
  category: "blog",
  openGraph: {
    images: "/og_image.png",
  },
  icons: {
    icon: "/favicon.ico",
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
