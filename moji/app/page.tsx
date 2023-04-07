'use client';

import { kaomoji } from '@/public/kaomoji';

const HomePage = () => {
    let chosenOne = kaomoji[Math.floor(Math.random() * kaomoji.length)];

    return (
            <div className="flex flex-col h-full w-full place-items-center justify-center gap-10 flex-wrap p-4 text-6xl">
                <div className="m-28">{chosenOne}</div>
                <a className="text-xl rounded-xl border p-4" href="/">
                    another one
                </a>
            </div>
    );
};

export default HomePage;
