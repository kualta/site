'use client';

import { kaomoji } from '@/public/kaomoji';
import { useState } from 'react';

const HomePage = () => {
    let [emote, setEmote] = useState('(´･ω･`)');

    let chooseEmote = () => {
        setEmote(kaomoji[Math.floor(Math.random() * kaomoji.length)]);
    };

    return (
        <div className="flex flex-col h-full w-full place-items-center justify-center gap-10 flex-wrap p-4 text-6xl">
            <div className="m-28 select-text" onClick={chooseEmote}>
                {emote}
            </div>
        </div>
    );
};

export default HomePage;
