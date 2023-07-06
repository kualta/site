"use client";

import { kaomoji } from "public/kaomoji";
import { useState } from "react";

const KaomojiPage = () => {
	const [emote, setEmote] = useState("(´･ω･`)");

	const chooseEmote = () => {
		setEmote(kaomoji[Math.floor(Math.random() * kaomoji.length)]);
	};

	return (
		<div className="flex flex-col h-full w-full place-items-center justify-center gap-10 flex-wrap p-4 text-6xl">
			<div
				className="m-28 select-text overflow-visible w-fit"
				onKeyDown={chooseEmote}
				onClick={chooseEmote}
			>
				{emote}
			</div>
		</div>
	);
};

export default KaomojiPage;
