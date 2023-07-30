import ThemeToggle from "@/components/ThemeToggle";
import Link from "next/link";
import "styles/globals.css";

export const metadata = {
  title: "kualta",
  description: "kualta's website",
  icons: {
    icon: "/icon.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head />

      <body className="dark:bg-dark-bg bg-lit-bg text-lit-text p-2 md:p-10 py-auto dark:text-dark-text h-screen w-screen ">
        {/* <header className={"flex items-center justify-center absolute top-10 inset-x-0"}>
          <Link href={"/"} className="text-6xl select-none">
            <div className="active:scale-90">==</div>
          </Link>
        </header> */}
        {children}
        <div className="absolute top-0 right-0">
          <ThemeToggle />
        </div>
      </body>
    </html>
  );
}
