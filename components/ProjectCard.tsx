"use client";
import { Project } from "@prisma/client";
import { Card } from "./Card";
import { fredoka } from "styles/fonts";
import { useState } from "react";
import { FiCopy, FiExternalLink, FiGithub } from "react-icons/fi";
import { MdOutlineExpandLess, MdOutlineExpandMore } from "react-icons/md";

export const ProjectCard = ({ project, expandAll }: { project: Project; expandAll: boolean }) => {
  const [expanded, setExpanded] = useState(expandAll);
  const statusStyles =
    project.status === "complete" || project.status === "ongoing" ? "text-text dark:text-dark-text" : "text-secondary";
  const dateText = new Date(project.date).toLocaleDateString();

  return (
    <div onClick={() => setExpanded(!expanded)} onKeyDown={() => setExpanded(!expanded)}>
      <Card>
        <div className={"min-w-0 w-full flex text-sm flex-col gap-2 -mb-1 group"}>
          <span className={"text-base -mt-2 flex group items-center gap-2 place-items-center justify-center min-w-0"}>
            <b className="text-lg min-w-fit">{project.name}</b>
            {project.full_name && (
              <span className="hidden sm:flex text-xs truncate overflow-hidden text-elipsis truncate">
                {"(aka"}
                &nbsp;
                <p>{project.full_name}</p>
                {")"}
              </span>
            )}
            <p className=" truncate ">- {project.description}</p>
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
              className={`text-xs hidden sm:flex border px-2 pb-0.5 rounded-lg text-secondary-text leading-4 -mb-1 ${statusStyles}`}
            >
              {project.status}
            </p>
            <button type="button" className="text-secondary-text hover:text-text dark:hover:text-dark-text -mb-1">
              {expanded || expandAll ? <MdOutlineExpandLess /> : <MdOutlineExpandMore />}
            </button>
          </span>
          {expanded || expandAll ? (
            <>
              <span className="gap-2 flex sm:hidden items-center">
                <b>status: </b>

                <p className={`border px-2 pb-0.5 rounded-lg text-secondary-text leading-4 ${statusStyles}`}>
                  {project.status}
                </p>
              </span>
              <span className="gap-2 flex">
                <b>date: </b>
                <p>{dateText}</p>
              </span>
              <span className="gap-2 flex items-center">
                <b>tech: </b>
                <p className="flex flex-wrap gap-2">
                  <span className="border px-2 py-0.5 rounded-lg">{project.language}</span>
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
                      onClick={() => navigator.clipboard.writeText(project.git_link)}
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
    </div>
  );
};
