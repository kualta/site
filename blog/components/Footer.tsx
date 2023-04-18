import Link from 'next/link';
import { roboto_mono } from './Fonts';

export default function Footer() {
    return (
        <footer
            className={`flex flex-col underline-offset-2 border-t dark:border-neutral-800 p-4 mt-8 mb-3 place-content-between place-items-center w-full ${roboto_mono.className}`}
        >
            <div className="flex flex-row place-content-between w-full place-items-center text-sm ">
                <Link className="no-underline hover:underline" href="/">{`< blog`}</Link>

                <div className="flex flex-row gap-4">
                    <a href={'https://kualta.dev/contacts'} className="no-underline hover:underline">{`contact me`}</a>
                </div>

                <a className="no-underline hover:underline" href="https://kualta.dev/">{`site >`}</a>
            </div>
        </footer>
    );
}
