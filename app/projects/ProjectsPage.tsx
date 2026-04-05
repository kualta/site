import { ProjectCard } from "@/components/ProjectCard";
import { Project } from "@/types";

const ProjectsPage = ({ projects }: { projects: Project[] }) => {
  const projectsList = projects.map((project) => {
    return <ProjectCard key={project.id} project={project} />;
  });

  return <div className="flex flex-col w-full gap-4 p-4">{projectsList}</div>;
};

export default ProjectsPage;
