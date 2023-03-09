import Link from 'next/link';
import '@/styles/globals.css'

export const metadata = {
  title: 'kualta\'s blog',
  description: 'I simply write words here',
  icons: {
    icon: "/icon.png"
  }
}

export default function RootLayout({ children }: {
    children: React.ReactNode
}) {
    let actionTexts = [
        'simply writes words',
        'writes simple words',
    ];
    let action = actionTexts[Math.floor(Math.random() * actionTexts.length)];

    let header = (
        <header className="flex items-center justify-between roboto-mono border-neutral-800 border-b py-4">
            <Link href={'/'}>
                <b>kualta</b> {action}
            </Link>
            <a href="https://kualta.dev/" target={'_blank'} rel={'noreferrer'}>{`site >`}</a>
        </header>
    );

    return (
        <html className='dark dark:bg-[#111111]'>
            <head />
            <body className='mx-auto flex flex-col min-h-screen max-w-2xl dark:text-stone-200 px-4'>
                {header}
                {children}
            </body>
        </html>
    )
}
