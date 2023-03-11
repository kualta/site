import { roboto_mono } from '@/components/fonts';
import { Project } from '../site/app/api/projects/route';

const Projects = (props: { projects: Project[] }) => {
    return (
        <div className="flex flex-col space-y-4 py-8">
            {props.projects.map((project) => (
                <a href={project.link} key={project.link} className="">
                    <b className={roboto_mono.className}>{project.name}</b>
                    {` - `}
                    <span className={roboto_mono.className}>
                        {project.description}
                    </span>
                </a>
            ))}
        </div>
    );
};

export default Projects;
