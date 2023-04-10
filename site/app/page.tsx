import { contacts, projects } from '@prisma/client';
import ContactIcons from 'components/ContactIcons';
import { ArticleList, ContactList, ProjectList } from 'components/DataList';
import { roboto_mono } from 'components/Fonts';
import Link from 'next/link';

async function HomePage() {
    let projects = await (await fetch('https://kualta.dev/api/projects', { cache: 'no-store' })).json();
    let articles = await (await fetch('https://blog.kualta.dev/api/posts', { cache: 'no-store' })).json();
    let contacts = await (await fetch('https://kualta.dev/api/contacts', { cache: 'no-store' })).json();
    projects = projects.filter((project: projects) => project.status !== 'planned').slice(0, 12);
    contacts = contacts.filter((contact: contacts) => contact.is_main)

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
                <ProjectList projects={projects} />
                <a className="hover:underline ml-8" href="/projects">
                    more...
                </a>
                <a
                    href="https://blog.kualta.dev/"
                    className={`flex items-center underline-offset-4 align-text-top font-semibold text-xl pt-8 group`}
                >
                    <span className="text-xl group-hover:underline my-auto">articles</span>
                    <span className="hidden group-hover:block text-base px-2 align-baseline">{'>'}</span>
                </a>
                <ArticleList articles={articles} />
                <Link
                    href="/contacts"
                    className={`flex items-center underline-offset-4 align-text-top font-semibold text-xl pt-8 group`}
                >
                    <span className="text-xl group-hover:underline my-auto">contacts</span>
                    <span className="hidden group-hover:block text-base px-2 align-baseline">{'>'}</span>
                </Link>
                <ContactList contacts={contacts} />
            </div>
        </>
    );
}

export default HomePage;
