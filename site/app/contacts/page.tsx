import { ContactList } from 'components/DataList';

async function ContactsPage() {
    let contacts = await (await fetch('https://kualta.dev/api/contacts', { cache: 'no-store' })).json();

    return (
        <>
            <ContactList contacts={contacts} />
        </>
    );
}

export default ContactsPage;
