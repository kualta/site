import { Project } from 'app/api/projects/route';
import { roboto_mono } from './Fonts';

interface Data {
    name: string;
    description: string;
    link: string;
}

export function DataList(props: { data: Data[] }) {
    return (
        <div className="">
            <div className="flex flex-col space-y-2 p-4">
                {props.data.map((project) => (
                    <a
                        className="group decoration-slate-200 decoration-1 underline-offset-4 w-fit"
                        href={project.link}
                        key={project.link}
                    >
                        <b className={`${roboto_mono.className} group-hover:underline`}>{project.name}</b>
                        <span className="px-1">{` - `}</span>
                        <span className={`${roboto_mono.className} group-hover:underline`}>{project.description}</span>
                    </a>
                ))}
            </div>
        </div>
    );
}

export function ArticleList(props: { articles: Data[] }) {
    return (
        <div className="">
            <div className="flex flex-col space-y-2 p-4">
                {props.articles.map((project, i, list) => {
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

export function ProjectList(props: { projects: Project[] }) {
    return (
        <div className="">
            <div className="flex flex-col space-y-2 p-4">
                {props.projects.map((project) => {
                    let current =
                        project.status === 'development' ? (
                            <span className="text-xs text-stone-600 px-2">current</span>
                        ) : (
                            <></>
                        );
                    return (
                        <a
                            className="flex group decoration-slate-200 decoration-1 underline-offset-4 w-fit items-center"
                            href={project.link}
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

export function ProjectGrid(props: { projects: Project[] }) {
    return (
        <div className="grid grid-cols-3 grid-flow-row m-4 gap-4 p-4 my-10">
            {props.projects.map((project) => {
                return (
                    <a
                        key={project.link}
                        className="flex group border border-stone-800 aspect-video items-center justify-center"
                        href={project.link}
                    >
                        <b className={`${roboto_mono.className} group-hover:underline`}>{project.name}</b>
                    </a>
                );
            })}
        </div>
    );
}
