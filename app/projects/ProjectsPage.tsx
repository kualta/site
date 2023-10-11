"use client";
import { Project } from "@prisma/client";
import Link from "next/link";
import { useState } from "react";

const ProjectsPage = ({ projects }: { projects: Project[] }) => {
  const [selectedStatuses, setSelectedStatuses] = useState(["complete", "ongoing", "paused", "archived"]);

  function handleStatusChange(e: { target: { value: any } }) {
    const value = e.target.value;
    setSelectedStatuses((prevSelectedStatuses) => {
      if (prevSelectedStatuses.includes(value)) {
        return prevSelectedStatuses.filter((status) => status !== value);
      } else {
        return [...prevSelectedStatuses, value];
      }
    });
  }

  const filteredProjects = projects.filter((project) => {
    return selectedStatuses.includes(project.status);
  });

  const projectsGrid = filteredProjects.map((project) => {
    const link = project.link ? project.link : project.git_link;

    return (
      <div key={project.id}>
        <a
          key={project.id}
          className={"flex group border-2 border-yell aspect-video items-center justify-center active-bg"}
          href={link}
        >
          <b className={"$group-hover:underline"}>{project.name}</b>
        </a>
      </div>
    );
  });

  const projectsList = filteredProjects.map((project) => {
    const link = project.link ? project.link : project.git_link;

    return (
      <div
        key={project.id}
        className="flex text-sm flex-col gap-1 group p-4 rounded-lg max-w-xl font-mono active-bg bg-secondary drop-shadow-md"
      >
        <span className={"text-base -mt-2 flex group items-center gap-2"}>
          <b className="text-lg">{project.name}</b>
          <span className="grow">
            {project.full_name && (
              <span className="flex text-xs">
                {"(aka"}
                &nbsp;
                <p>{project.full_name}</p>
                {")"}
              </span>
            )}
          </span>
          <p className="text-xs border px-2 py-0.5 rounded-lg text-secondary-text">{project.status}</p>
        </span>
        <span className="gap-2 flex font-mono">
          <b>what: </b>
          <p> {project.description}</p>
        </span>
        <span className="gap-2 flex font-mono items-center">
          <b>how: </b>
          <p className="flex flex-wrap gap-2">
            <span className="border px-2 py-0.5 rounded-lg">{project.language}</span>
            {project.tech_stack.map((v) => (
              <span key={v} className="border px-2 py-0.5 rounded-lg">{v}</span>
            ))}
          </p>
        </span>
        {project.git_link && (
          <span className="flex font-mono">
            <b>where: </b>
            &nbsp;
            <a href={project.git_link}>{project.git_link}</a>
          </span>
        )}
        {project.link && (
          <span className="flex font-mono mt-2">
            <a className="underline" href={project.link}>
              <code className="rounded-lg py-1 px-2 active-bg">{project.link}</code>
            </a>
          </span>
        )}
      </div>
    );
  });

  const CheckBox = ({ value }: { value: string }) => {
    return (
      <label>
        <input
          type="checkbox"
          value={value}
          checked={selectedStatuses.includes(value)}
          onChange={handleStatusChange}
          className="mr-2 accent-primary dark:accent-dark-primary text-secondary"
        />
        <span>{value}</span>
      </label>
    );
  };

  return (
    <div>
      <div className={"flex flex-wrap gap-4 p-4 justify-center items-center "}>
        <CheckBox value="complete" />
        <CheckBox value="ongoing" />
        <CheckBox value="paused" />
        <CheckBox value="archived" />
      </div>

      {/* <div className="grid grid-cols-3 grid-flow-row m-4 gap-4 p-4 my-10">{projectsGrid}</div> */}
      <div className="flex flex-col m-4 gap-4 p-4">{projectsList}</div>
    </div>
  );
};

export default ProjectsPage;
