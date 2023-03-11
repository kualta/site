import { roboto_mono } from '@/components/fonts';
import '@/styles/globals.css';
import Link from 'next/link';

export const metadata = {
    title: "kualta's blog",
    description: "kualta's official blog",
    icons: {
        icon: '/icon.png',
    },
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    let texts = ['simply writes words', 'writes simple words'];
    let action = texts[Math.floor(Math.random() * texts.length)];

    let header = (
        <header
            className={`flex items-center justify-between border-b py-4 dark:border-neutral-800 ${roboto_mono.className}`}
        >
            <Link href={'/'}>
                <b>kualta</b> {action}
            </Link>
            <a href="https://kualta.dev/">{`site >`}</a>
        </header>
    );

    return (
        <html className="dark dark:bg-[#111111]">
            <head />
            <body className="mx-auto flex flex-col min-h-screen max-w-2xl dark:text-stone-200 px-4">
                {header}
                {children}
            </body>
        </html>
    );
}
