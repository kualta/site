import Link from 'next/link';
import '../styles/globals.css'

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  let header = (
    <header className="text-3xl">
      <Link href={'/'}>
        kualta writes things
      </Link>
    </header>
  );
  return (
    <html>
      <head />
      <body>
        {header}
        {children}
      </body>
    </html>
  )
}
