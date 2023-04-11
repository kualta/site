import { ContactIcon } from '@/components/ContactIcons';
import { roboto_mono } from '@/components/Fonts';
import { Contact } from '@prisma/client';
import Link from 'next/link';

async function ContactsPage() {
    let contacts: Contact[] = await (await fetch('https://kualta.dev/api/contacts', { cache: 'no-store' })).json();

    return (
        <div className={`${roboto_mono.className} flex justify-center items-center flex-col m-4 gap-4 p-4 my-10`}>
            {contacts.map((contact: Contact) => {
                let icon = ContactIcon(contact, 22);
                return (
                    <a
                        className="flex gap-4 group border-b p-4 border-stone-800 w-full items-center"
                        href={contact.link}
                        key={contact.link}
                    >
                        {icon}
                        <p className="w-24 text-right">{contact.platform}</p>
                        {` - `}
                        <b className="group-hover:underline w-auto">{contact.label}</b>
                        <p className="grow text-xs text-stone-400">{contact.description}</p>
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
