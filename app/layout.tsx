import ThemeToggle, { BackButton } from "@/components/MetaButton";
import "styles/globals.css";

export const metadata = {
  title: "kualta",
  description: "kualta's website",
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
    <html lang="en" className="dark">
      <head />

      <body className="p-2 md:p-10 py-auto bg-bg dark:bg-dark-bg text-text dark:text-dark-text h-screen w-screen">
        <div className="fixed top-0 left-0 m-2">
          <BackButton />
        </div>
        <div className="fixed top-0 right-0 flex-col flex m-2">
          <ThemeToggle />
        </div>
        {children}
      </body>
    </html>
  );
}
