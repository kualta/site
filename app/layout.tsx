import ThemeToggle from "@/components/ThemeToggle";
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

      <body className="dark:bg-dark-bg max-w-fit bg-lit-bg text-lit-text p-10 py-auto dark:text-dark-text w-screen h-screen">
        {children}
        <div className="absolute top-0 right-0">
          <ThemeToggle />
        </div>
      </body>
    </html>
  );
}
