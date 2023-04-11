import { roboto_mono } from '@/components/Fonts';
import { Project } from '@prisma/client';
import Link from 'next/link';

async function ProjectsPage() {
    let projects: Project[] = await (await fetch('https://kualta.dev/api/projects', { cache: 'no-store' })).json();

    return (
        <>
            <div className="grid grid-cols-3 grid-flow-row m-4 gap-4 p-4 my-10">
                {projects.map((project) => {
                    let link = project.link ? project.link : project.git_link;
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
        </>
    );
}

export default ProjectsPage;
