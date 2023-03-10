import { Contact } from "./api/contacts/route";

const HomePage = async () => {
    const contacts = await getData<Contact[]>('/api/contacts');

    let links = contacts.map((contact) => (
        <a href={contact.link} key={contact.link}>
            {contact.name}
        </a>
    ));

    return <div>
        {links}
    </div>;
};

async function getData<T>(url: string): Promise<T> {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(response.statusText);
    }

    return await (response.json() as Promise<T>);
}

export default HomePage;
