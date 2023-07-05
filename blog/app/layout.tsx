import { roboto_mono } from "components/Fonts";
import Link from "next/link";
import "styles/globals.css";

export const metadata = {
	title: "kualta's blog",
	description: "kualta's blog",
	icons: {
		icon: "/icon.png",
	},
};

export default async function RootLayout({
	children,
}: { children: React.ReactNode }) {
	const texts = ["simply writes words", "writes simple words"];
	const action = texts[Math.floor(Math.random() * texts.length)];

	const header = (
		<header
			className={
				"flex items-center justify-center border-b py-4 dark:border-neutral-800"
			}
		>
			<Link href={"/"} className={roboto_mono.className}>
				<b className="text-lg">kualta</b> {action}
			</Link>
		</header>
	);

	return (
		<html lang="en" className="dark">
			<head />
			<body className="dark:bg-[#111111] mx-auto flex flex-col min-h-screen max-w-2xl dark:text-stone-200 px-4">
				{header}
				{children}
			</body>
		</html>
	);
}
