import '@/styles/globals.css';

export const metadata = {
    title: "kualta's kaomojis",
    description: 'random kaomji generator',
    icons: {
        icon: '/icon.png',
    },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html className="dark dark:bg-[#111111]">
            <head />
            <body className="h-screen w-screen text-stone-200 px-4">{children}</body>
        </html>
    );
}
