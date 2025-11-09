"use client";
import { Project } from "@/types";
import { Card } from "./Card";
import { FiExternalLink, FiGithub } from "react-icons/fi";
import { motion } from "framer-motion";

export const ProjectCard = ({ project }: { project: Project }) => {
  const statusStyles =
    project.status === "complete" || project.status === "ongoing" ? "text-text dark:text-dark-text" : "text-secondary";

  return (
    <div className="relative">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
      >
        <Card>
          <div className={"min-w-0 w-full text-sm px-1"}>
            <div className={"text-base flex items-center gap-2 min-w-0"}>
              <b className="text-md min-w-fit">{project.full_name || project.name}</b>
              <p className="truncate">- {project.description}</p>
              {project.link && (
                <a
                  target="_blank"
                  rel="noreferrer"
                  href={project.link}
                  className="text-secondary-text hover:scale-110 hover:text-text dark:hover:text-dark-text"
                  onClick={(e) => e.stopPropagation()}
                >
                  <FiExternalLink />
                </a>
              )}
              {project.git_link && (
                <>
                  <a
                    target="_blank"
                    rel="noreferrer"
                    href={project.git_link}
                    className="text-secondary-text hover:scale-110 hover:text-text dark:hover:text-dark-text"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <FiGithub />
                  </a>
                </>
              )}
              <span className="grow shrink" />
              <p
                className={`text-xs hidden sm:flex border px-2 pb-0.5 rounded-lg text-secondary-text leading-4 ${statusStyles}`}
              >
                {project.status}
              </p>
            </div>
          </div>
        </Card>
      </motion.div>
    </div>
  );
};
