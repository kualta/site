'use client';

import { kaomoji } from '@/public/kaomoji';
import { useState } from 'react';

const HomePage = () => {
    let [emote, setEmote] = useState("(´･ω･`)");

    let chooseEmote = () => {
        setEmote(kaomoji[Math.floor(Math.random() * kaomoji.length)]);
    };

    return (
        <div className="flex flex-col h-full w-full place-items-center justify-center gap-10 flex-wrap p-4 text-6xl">
            <div className="m-28">{emote}</div>
            <button className="text-xl rounded-xl border p-4" onClick={chooseEmote}>
                another one
            </button>
        </div>
    );
};

export default HomePage;
