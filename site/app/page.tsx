import ContactIcons from '@/components/ContactIcons';
import DataList from '@/components/DataList';
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
        <>
            <div className="flex flex-row place-items-center gap-x-8 p-4">
                <ContactIcons contacts={contacts} />
            </div>
            <DataList list={projects} title="Projects" />
            <DataList list={articles} title="Articles" />
            <DataList list={contacts} title="Contacts" />
        </>
    );
};

async function getData<T>(url: string): Promise<T> {
    const response = await fetch(url, { cache: 'no-store' });

    if (!response.ok) {
        throw new Error(response.statusText);
    }

    return (await response.json()) as Promise<T>;
}

export default HomePage;
