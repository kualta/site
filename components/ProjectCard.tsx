"use client";
import { Project } from "@prisma/client";
import { Card } from "./Card";
import { fredoka } from "styles/fonts";
import { useState } from "react";

export const ProjectCard = ({ project }: { project: Project }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card>
      <div
        className={`flex text-sm flex-col gap-1 group ${fredoka.className}`}
        onKeyDown={() => setExpanded(!expanded)}
        onClick={() => setExpanded(!expanded)}
      >
        <span
          className={"text-base -mt-2 flex group items-center gap-2  min-w-fit"}
        >
          <b className="text-lg">{project.name}</b>
          <span>
            {project.full_name && (
              <span className="flex text-xs">
                {"(aka"}
                &nbsp;
                <p>{project.full_name}</p>
                {")"}
              </span>
            )}
          </span>
          <p className="grow">- {project.description}</p>
          <p className="text-xs border px-2 py-0.5 rounded-lg text-secondary-text">
            {project.status}
          </p>
        </span>
        {expanded ? (
          <>
            <span className="gap-2 flex items-center">
              <b>how: </b>
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
                  <b>where: </b>
                  &nbsp;
                  <a href={project.git_link}>{project.git_link}</a>
                </span>
              )}
            </span>
          </>
        ) : (
          <></>
        )}
        {project.link && (
          <span className="flex mt-2">
            <a className="underline" href={project.link}>
              <code className="rounded-lg py-1 px-2 active-bg">
                {project.link}
              </code>
            </a>
          </span>
        )}
      </div>
    </Card>
  );
};
