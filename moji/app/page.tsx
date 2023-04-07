import { kaomoji } from '@/public/kaomoji';
import Nossr from './nossr';

const HomePage = () => {
    let chosenOne = kaomoji[Math.floor(Math.random() * kaomoji.length)];

    return (
        <Nossr>
            <div className="flex flex-col h-full w-full place-items-center justify-center gap-10 flex-wrap p-4 text-6xl">
                <div className="m-28">{chosenOne}</div>
                <a className="text-xl rounded-xl border p-4" href="/">
                    another one
                </a>
            </div>
        </Nossr>
    );
};

export default HomePage;
