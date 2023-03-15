import ContactIcons from '@/components/ContactIcons';
import LinkList from '@/components/DataList';
import { roboto_mono } from '@/components/Fonts';
import Link from 'next/link';
import { Article } from './api/articles/route';
import { Contact } from './api/contacts/route';
import { Project } from './api/projects/route';

const HomePage = async () => {
    const projects = await getData<Project[]>('https://kualta.dev/api/projects');
    const articles = await getData<Article[]>('https://kualta.dev/api/articles');
    const contacts = await getData<Contact[]>('https://kualta.dev/api/contacts');

    return (
        <>
            <div className="flex flex-row justify-center place-items-center gap-x-8 p-4">
                <ContactIcons contacts={contacts} />
            </div>
            <div className={roboto_mono.className}>
                {/* TODO: add /projects */}
                <h2 className={`flex font-semibold text-xl pt-8`}>projects</h2>
                <LinkList list={projects} />
                <a href="https://blog.kualta.dev/" className={`flex font-semibold text-xl pt-8`}>
                    articles {'>'}
                </a>
                <LinkList list={articles} />
                <h2 className={` font-semibold text-xl pt-8`}>contacts</h2>
                <LinkList list={contacts} />
            </div>
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
