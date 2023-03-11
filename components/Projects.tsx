import { Project } from '../site/app/api/projects/route';

const Articles = (props: { projects: Project[] }) => {
    return (
        <>
            {props.projects.map((project) => (
                <a href={project.link} key={project.link}>
                    {project.name}
                    {project.description}
                </a>
            ))}
        </>
    );
};

export default Articles;
