import { contacts, projects } from '@prisma/client';
import Link from 'next/link';
import { roboto_mono } from './Fonts';

export function DataList(props: { data: contacts[] }) {
    return (
        <div className="">
            <div className="flex flex-col space-y-2 p-4">
                {props.data.map((project) => (
                    <a
                        className="group decoration-slate-200 decoration-1 underline-offset-4 w-fit"
                        href={project.link}
                        key={project.link}
                    >
                        <b className={`${roboto_mono.className} group-hover:underline`}>{project.platform}</b>
                        <span className="px-1">{` - `}</span>
                        <span className={`${roboto_mono.className} group-hover:underline`}>{project.label}</span>
                    </a>
                ))}
            </div>
        </div>
    );
}

interface Article {
    name: string;
    link: string;
    description: string;
}

export function ArticleList(props: { articles: Article[] }) {
    return (
        <div className="">
            <div className="flex flex-col space-y-2 p-4">
                {props.articles.map((project, i) => {
                    let latest = i === 0 ? <span className="text-xs text-stone-600 px-2">latest</span> : <></>;
                    let title = project.name.toLocaleLowerCase();
                    return (
                        <a
                            className="flex group decoration-slate-200 decoration-1 underline-offset-4 w-fit items-center"
                            href={project.link}
                            key={project.link}
                        >
                            <b className={`${roboto_mono.className} group-hover:underline`}>{title}</b>
                            <span className="px-1">{` - `}</span>
                            <span className={`${roboto_mono.className} group-hover:underline`}>
                                {project.description}
                            </span>
                            {latest}
                        </a>
                    );
                })}
            </div>
        </div>
    );
}

export function ProjectList(props: { projects: projects[] }) {
    return (
        <div className="">
            <div className="flex flex-col space-y-2 p-4">
                {props.projects.map((project) => {
                    let link = project.link ? project.link : project.git_link
                    let current =
                        project.status === 'development' ? (
                            <span className="text-xs text-stone-600 px-2">current</span>
                        ) : (
                            <></>
                        );
                    return (
                        <a
                            className="flex group decoration-slate-200 decoration-1 underline-offset-4 w-fit items-center"
                            href={link}
                            key={project.link}
                        >
                            <b className={`${roboto_mono.className} group-hover:underline`}>{project.name}</b>
                            <span className="px-1">{` - `}</span>
                            <span className={`${roboto_mono.className} group-hover:underline`}>
                                {project.description}
                            </span>
                            {current}
                        </a>
                    );
                })}
            </div>
        </div>
    );
}

export function ProjectGrid(props: { projects: projects[] }) {
    return (
        <div className="grid grid-cols-3 grid-flow-row m-4 gap-4 p-4 my-10">
            {props.projects.map((project) => {
                let link = project.link ? project.link : project.git_link
                return (
                    <a
                        key={project.link}
                        className="flex group border border-stone-800 aspect-video items-center justify-center"
                        href={link}
                    >
                        <b className={`${roboto_mono.className} group-hover:underline`}>{project.name}</b>
                    </a>
                );
            })}
            <div className="flex justify-center items-center">
                <Link href={'/'}>{`< back`}</Link>
            </div>
        </div>
    );
}

export function ContactList(props: { contacts: contacts[] }) {
    return (
        <div className="flex flex-col m-4 gap-4 p-4 my-10">
            {props.contacts.map((contact) => {
                return (
                    <a
                        className="flex group border-b p-4 border-stone-800 items-center"
                        href={contact.link}
                        key={contact.link}
                    >
                        <b className={`${roboto_mono.className} pr-4 w-24`}>{contact.platform}</b>
                        <b className={`${roboto_mono.className} group-hover:underline w-auto`}>{contact.label}</b>
                    </a>
                );
            })}
            <div className="flex justify-center items-center">
                <Link href={'/'}>{`< back`}</Link>
            </div>
        </div>
    );
}
