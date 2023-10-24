"use client";
import { Project } from "@prisma/client";
import { Card } from "./Card";
import { fredoka } from "styles/fonts";
import { useState } from "react";
import { FiCopy, FiExternalLink, FiGithub } from "react-icons/fi";
import { MdOutlineExpandLess, MdOutlineExpandMore } from "react-icons/md";

export const ProjectCard = ({ project }: { project: Project }) => {
  const [expanded, setExpanded] = useState(false);
  const statusStyles =
    project.status === "complete" || project.status === "ongoing"
      ? "text-text dark:text-dark-text"
      : "text-secondary";

  // FIXME: Fix trunaction
  return (
    <Card>
      <div
        className={`w-full flex text-sm flex-col gap-2 -mb-1 group ${fredoka.className}`}
      >
        <span
          className={
            "text-base -mt-2 flex group items-center gap-2 place-items-center justify-center min-w-0"
          }
        >
          <b className="text-lg min-w-fit">{project.name}</b>
          {project.full_name && (
            <span className="flex text-xs truncate overflow-hidden text-elipsis truncate">
              {"(aka"}
              &nbsp;
              <p>{project.full_name}</p>
              {")"}
            </span>
          )}
          <p className="truncate overflow-hidden text-elipsis">
            - {project.description}
          </p>
          {project.link && (
            <a
              href={project.link}
              className="text-secondary-text hover:scale-110 hover:text-text dark:hover:text-dark-text"
            >
              <FiExternalLink />
            </a>
          )}
          {project.git_link && (
            <>
              <a
                href={project.git_link}
                className="text-secondary-text hover:scale-110 hover:text-text dark:hover:text-dark-text"
              >
                <FiGithub />
              </a>
            </>
          )}
          <span className="grow shrink" />
          <p
            className={`text-xs border px-2 pb-0.5 rounded-lg text-secondary-text leading-4 -mb-1 ${statusStyles}`}
          >
            {project.status}
          </p>
          <button
            type="button"
            className="text-secondary-text hover:text-text dark:hover:text-dark-text -mb-1"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <MdOutlineExpandLess /> : <MdOutlineExpandMore />}
          </button>
        </span>
        {expanded ? (
          <>
            <span className="gap-2 flex items-center">
              <b>stack: </b>
              <p className="flex flex-wrap gap-2">
                <span className="border px-2 py-0.5 rounded-lg">
                  {project.language}
                </span>
                {project.tech_stack.map((v) => (
                  <span key={v} className="border px-2 py-0.5 rounded-lg">
                    {v}
                  </span>
                ))}
              </p>
            </span>
            <span>
              {project.git_link && (
                <span className="flex ">
                  <b>git: </b>
                  &nbsp;
                  <a href={project.git_link}>{project.git_link}</a>
                  <button
                    type="button"
                    className="text-secondary-text hover:text-text dark:hover:text-dark-text active:text-primary dark:active:text-dark-primary p-1"
                    onClick={() =>
                      navigator.clipboard.writeText(project.git_link)
                    }
                  >
                    <FiCopy size={15} />
                  </button>
                </span>
              )}
            </span>
          </>
        ) : (
          <></>
        )}
      </div>
    </Card>
  );
};