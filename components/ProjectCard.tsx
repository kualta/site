"use client";
import { Project } from "@prisma/client";
import { Card } from "./Card";
import { fredoka } from "styles/fonts";
import { useState } from "react";
import { FiCopy, FiExternalLink, FiGithub } from "react-icons/fi";
import { MdOutlineExpandLess, MdOutlineExpandMore } from "react-icons/md";

export const ProjectCard = ({ project }: { project: Project }) => {
  const [expanded, setExpanded] = useState(false);
  const expandedStyles = expanded ? "drop-shadow-sm" : "";
  const statusStyles =
    project.status === "complete" || project.status === "ongoing"
      ? "text-text dark:text-dark-text"
      : "text-secondary";

  return (
    <div
      className={`w-full p-3 rounded-lg flex text-sm flex-col gap-1 group ${fredoka.className} ${expandedStyles}`}
    >
      <span
        className={"text-base -mt-2 flex group items-center gap-2  min-w-fit"}
      >
        <b className="text-lg">{project.name}</b>
        {project.full_name && (
          <span className="flex text-xs">
            {"(aka"}
            &nbsp;
            <p>{project.full_name}</p>
            {")"}
          </span>
        )}
        <p>- {project.description}</p>
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
        <span className="grow" />
        <p
          className={`text-xs border px-2 py-0.5 rounded-lg text-secondary-text ${statusStyles}`}
        >
          {project.status}
        </p>
        <button
          type="button"
          className="text-secondary-text hover:text-text dark:hover:text-dark-text"
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
  );
};
