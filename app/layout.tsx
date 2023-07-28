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

      <body className="dark:bg-[#222222] h-screen max-w-fit bg-[#fafafa] text-[#000000] p-10 py-auto dark:text-[#ffffff] ">
        {children}
      </body>
    </html>
  );
}
