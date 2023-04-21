import { roboto_mono } from 'components/Fonts';
import Link from 'next/link';
import 'styles/globals.css';

export const metadata = {
    title: "kualta's blog",
    description: "kualta's blog",
    icons: {
        icon: '/icon.png',
    },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
    let texts = ['simply writes words', 'writes simple words'];
    let action = texts[Math.floor(Math.random() * texts.length)];

    let header = (
        <header className={`flex items-center justify-center border-b py-4 dark:border-neutral-800`}>
            <Link href={'/'} className={roboto_mono.className}>
                <b className="text-lg">kualta</b> {action}
            </Link>
        </header>
    );

    return (
        <html className="dark">
            <head />
            <body className="dark:bg-[#111111] mx-auto flex flex-col min-h-screen max-w-2xl dark:text-stone-200 px-4">
                {header}
                {children}
            </body>
        </html>
    );
}
