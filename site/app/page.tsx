import { Contact } from './api/contacts/route';

const HomePage = async () => {
    const contacts = await getData<Contact[]>(
        'https://kualta.dev/api/contacts'
    );

    let links = contacts.map((contact) => (
        <a href={contact.link} key={contact.link}>
            {contact.name}
        </a>
    ));

    return (
        <div className="flex place-items-center justify-center flex-row flex-wrap gap-8 p-4 border-b border-neutral-800">
            {links}
        </div>
    );
};

async function getData<T>(url: string): Promise<T> {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(response.statusText);
    }

    return await (response.json() as Promise<T>);
}

export default HomePage;
