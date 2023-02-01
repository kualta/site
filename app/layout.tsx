import Link from 'next/link';
import '../styles/globals.css'

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  let header = (
    <header className="flex items-center justify-between roboto-mono border-neutral-800 border-b py-4">
      <Link href={'/'}>
        <b>kualta</b> simply writes words
      </Link>
    </header>
  );
  return (
    <html className='dark bg-[#111111]'>
      <head />
      <body className='mx-auto flex flex-col min-h-screen max-w-2xl text-stone-200 px-4'>
        {header}
        {children}
      </body>
    </html>
  )
}
