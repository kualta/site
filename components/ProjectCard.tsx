import Link from "next/link";
import { Project } from "@/types";
import { FiExternalLink, FiGithub } from "react-icons/fi";

export const ProjectCard = ({ project }: { project: Project }) => {
  const href = project.link || project.git_link || "#";

  return (
    <div className="w-full flex flex-row items-baseline gap-2 text-lg">
      <Link href={href} target="_blank" rel="noreferrer" className="flex flex-row items-baseline gap-2 min-w-0 flex-grow hover:opacity-70">
        <span className="font-medium whitespace-nowrap">{project.full_name || project.name}</span>
        <span className="text-sm text-secondary-text truncate">{project.description}</span>
        <span className="flex-grow border-b border-dotted border-secondary-text opacity-50" />
        <span className="w-16 shrink-0 text-left text-sm text-secondary-text whitespace-nowrap font-mono">{project.status}</span>
      </Link>
      <span className="w-5 shrink-0 flex justify-center">
        {project.git_link && (
          <Link href={project.git_link} target="_blank" rel="noreferrer" className="text-secondary-text hover:opacity-70">
            <FiGithub />
          </Link>
        )}
      </span>
      <span className="w-5 shrink-0 flex justify-center">
        {project.link && (
          <Link href={project.link} target="_blank" rel="noreferrer" className="text-secondary-text hover:opacity-70">
            <FiExternalLink />
          </Link>
        )}
      </span>
    </div>
  );
};
