import ContactIcons from '@/components/ContactIcons';
import { roboto_mono } from '@/components/Fonts';
import Link from 'next/link';

async function HomePage() {
    let contacts = await (await fetch('https://kualta.dev/api/contacts', { cache: 'no-store' })).json();

    return (
        <>
            <div className="flex flex-row justify-center place-items-center gap-x-8 p-4">
                <ContactIcons contacts={contacts} />
            </div>
            <div>vids! pogchampionship</div>
        </>
    );
}

export default HomePage;
