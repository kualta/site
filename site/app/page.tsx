import { Contact } from './api/contacts/route';
import ContactIcons from '../../components/ContactIcons'

const HomePage = async () => {
    const contacts = await getData<Contact[]>(
        'https://kualta.dev/api/contacts'
    );

    return (
        <div className="flex place-items-center justify-center flex-row flex-wrap gap-8 p-4 border-b border-neutral-800">
            <ContactIcons contacts={contacts} />
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
