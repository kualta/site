import ContactIcons from '@/components/ContactIcons';
import LinkList from '@/components/DataList';
import { roboto_mono } from '@/components/Fonts';
import Link from 'next/link';
import { Article } from './api/articles/route';
import { Contact } from './api/contacts/route';
import { Project } from './api/projects/route';

async function HomePage() {
    const projects = await getData<Project[]>('https://kualta.dev/api/projects');
    const articles = await getData<Article[]>('https://kualta.dev/api/articles');
    const contacts = await getData<Contact[]>('https://kualta.dev/api/contacts');

    return (
        <>
            <div className="flex flex-row justify-center place-items-center gap-x-8 p-4">
                <ContactIcons contacts={contacts} />
            </div>
            <div className={`${roboto_mono.className}`}>
                <Link
                    href="/projects"
                    className={`flex items-center underline-offset-4 align-text-top font-semibold text-xl pt-8 group`}
                >
                    <span className="text-xl group-hover:underline my-auto">projects</span>
                    <span className="hidden group-hover:block text-base px-2 align-baseline">{'>'}</span>
                </Link>
                <LinkList list={projects} />
                <a
                    href="https://blog.kualta.dev/"
                    className={`flex items-center underline-offset-4 align-text-top font-semibold text-xl pt-8 group`}
                >
                    <span className="text-xl group-hover:underline my-auto">articles</span>
                    <span className="hidden group-hover:block text-base px-2 align-baseline">{'>'}</span>
                </a>
                <LinkList list={articles} />
                <Link
                    href="/contacts"
                    className={`flex items-center underline-offset-4 align-text-top font-semibold text-xl pt-8 group`}
                >
                    <span className="text-xl group-hover:underline my-auto">contacts</span>
                    <span className="hidden group-hover:block text-base px-2 align-baseline">{'>'}</span>
                </Link>
                <LinkList list={contacts} />
            </div>
        </>
    );
}

async function getData<T>(url: string): Promise<T> {
    const response = await fetch(url, { cache: 'no-store' });

    if (!response.ok) {
        throw new Error(response.statusText);
    }

    return (await response.json()) as Promise<T>;
}

export default HomePage;
