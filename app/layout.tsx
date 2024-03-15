import "styles/globals.css";
import { Analytics } from "@vercel/analytics/react";
import { fredoka } from "styles/fonts";
import { IsChristmas, Snow } from "@/components/Effects";
import { CornersScope } from "@/components/CornersScope";
import { Metadata } from "next";
import Head from "next/head";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  metadataBase: new URL("https://kualta.dev"),
  title: {
    default: "kualta",
    template: "%s",
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
    googleBot: {
      index: true,
      follow: true,
    },
  },
  twitter: {
    card: "summary_large_image",
    images: "/opengraph-image.png",
    title: "kualta.dev",
    description: "glimse into the void",
    creator: "@kualts",
  },
  category: "blog",
  openGraph: {
    images: "/opengraph-image.png",
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
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      </Head>
      <body
        className={`bg-bg dark:bg-dark-bg disable-scrollbars text-text transition-all 
        ease-in-out delay-150 dark:text-dark-text place-items-center 
        min-h-screen flex flex-col justify center relative ${fredoka.className}`}
      >
        <div className="noise" />

        <IsChristmas>
          <Snow />
        </IsChristmas>

        <Header />

        <div className="flex flex-col items-center grow w-full h-full">{children}</div>

        <div className="hidden sm:flex  border-text dark:border-dark-text">
          <CornersScope />
        </div>

        <Analytics />
      </body>
    </html>
  );
}
