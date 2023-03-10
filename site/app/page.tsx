import ContactIcons from '@/components/ContactIcons';
import { Article } from './api/articles/route';
import { Contact } from './api/contacts/route';
import { Project } from './api/projects/route';

const HomePage = async () => {
    const projects = await getData<Project[]>(
        'https://kualta.dev/api/projects'
    );
    const articles = await getData<Article[]>(
        'https://kualta.dev/api/articles'
    );
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

    return await response.json() as Promise<T>;
}

export default HomePage;
