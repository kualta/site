import Link from "next/link";
import { Project } from "@/types";
import { FiExternalLink, FiGithub } from "react-icons/fi";

export const ProjectCard = ({ project }: { project: Project }) => {
  const href = project.link || project.git_link || "#";

  return (
    <Link href={href} target="_blank" rel="noreferrer" className="w-full flex flex-row items-baseline gap-2 hover:opacity-70 text-lg">
      <span className="font-medium whitespace-nowrap">{project.full_name || project.name}</span>
      <span className="text-sm text-secondary-text truncate">{project.description}</span>
      <span className="flex-grow border-b border-dotted border-secondary-text opacity-50" />
      <span className="w-16 shrink-0 text-left text-sm text-secondary-text whitespace-nowrap font-mono">{project.status}</span>
      <span className="w-5 shrink-0 flex justify-center">
        {project.git_link && (
          <span className="text-secondary-text">
            <FiGithub />
          </span>
        )}
      </span>
      <span className="w-5 shrink-0 flex justify-center">
        {project.link && (
          <span className="text-secondary-text">
            <FiExternalLink />
          </span>
        )}
      </span>
    </Link>
  );
};
