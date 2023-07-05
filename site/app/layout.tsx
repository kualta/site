import { roboto_mono } from "components/Fonts";
import Link from "next/link";
import "styles/globals.css";

export const metadata = {
	title: "kualta",
	description: "kualta's official website",
	icons: {
		icon: "/icon.png",
	},
};

export default function RootLayout({
	children,
}: { children: React.ReactNode }) {
	return (
		<html lang="en" className="dark">
			<head />

			<body className="dark:bg-[#1d1d1d] bg-[#fafafa] text-[#1d1d1d] mx-auto flex flex-col min-h-screen max-w-2xl dark:text-[#fafafa] px-4">
				<header className={"flex items-center justify-center py-4"}>
					<Link href={"/"} className="text-6xl select-none">
						<div className="active:scale-90">==</div>
					</Link>
				</header>

				{children}
			</body>
		</html>
	);
}
