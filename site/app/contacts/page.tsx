import { roboto_mono } from '@/components/Fonts';
import { Contact } from '@prisma/client';
import Link from 'next/link';

async function ContactsPage() {
    let contacts: Contact[] = await (await fetch('https://kualta.dev/api/contacts', { cache: 'no-store' })).json();

    return (
        <div className="flex flex-col m-4 gap-4 p-4 my-10">
            {contacts.map((contact) => {
                return (
                    <a
                        className="flex group border-b p-4 border-stone-800 items-center"
                        href={contact.link}
                        key={contact.link}
                    >
                        <b className={`${roboto_mono.className} pr-4 w-24`}>{contact.platform}</b>
                        <b className={`${roboto_mono.className} group-hover:underline w-auto`}>{contact.label}</b>
                    </a>
                );
            })}

            <div className="flex justify-center items-center">
                <Link href={'/'}>{`< back`}</Link>
            </div>
        </div>
    );
}

export default ContactsPage;
