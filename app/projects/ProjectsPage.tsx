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
    const border_color = getBorderStyleForStatus(project.status);

    return (
      <div key={project.id}>
        <a
          key={project.id}
          className={`flex group border-2 border-yell aspect-video items-center justify-center ${border_color}`}
          href={link}
        >
          <b className={"$group-hover:underline"}>{project.name}</b>
        </a>
      </div>
    );
  });

  const projectsList = filteredProjects.map((project) => {
    const link = project.link ? project.link : project.git_link;
    const border_color = getBorderStyleForStatus(project.status);
    const date = new Date(project.date);

    return (
      <div key={project.id} className={`flex flex-col gap-1 border p-4 rounded-xl font-mono ${border_color}`}>
        <a className={"flex group gap-2 group hover:underline "} href={link}>
          <b>title: </b>
          <p>{project.name}</p>
          {project.full_name && (
            <span className="flex font-mono">
              {"(aka"}
              &nbsp;
              <p>{project.full_name}</p>
              {")"}
            </span>
          )}
        </a>
        <span className="gap-2 flex font-mono">
          <b>description: </b>
          <p>{project.description}</p>
        </span>
        <span className="gap-2 flex font-mono">
          <b>status: </b>
          <p className="flex flex-wrap gap-2">
            {project.status}
          </p>
        </span>
        <span className="gap-2 flex font-mono">
          <b>date: </b>
          <p>{date.toLocaleDateString()}</p>
        </span>
        <span className="gap-2 flex font-mono">
          <b>language: </b>
          <p>{project.language}</p>
        </span>
        <span className="gap-2 flex font-mono">
          <b>stack: </b>
          <p className="flex flex-wrap gap-2">
            {project.tech_stack.map((v) => (
              <span>{v}</span>
            ))}
          </p>
        </span>
        {project.git_link && (
          <span className="flex font-mono">
            <b>git: </b>
            &nbsp;
            <code>{project.git_link}</code>
          </span>
        )}
        {project.link && (
          <span className="flex font-mono mt-4">
            <a className="underline" href={project.link}>
              <code className="rounded-lg border border-lit-secondary bg-lit-primary py-1 dark:border-dark-primary dark:bg-dark-bg px-2">
                {project.link}
              </code>
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
          className="mr-2 accent-gray-700"
        />
        {value}
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

function getBorderStyleForStatus(status: string) {
  switch (status) {
    case "ongoing":
      return "border-lit-accent dark:border-dark-accent";
    case "complete":
      return "border-lit-primary dark:border-dark-primary";
    case "archived":
      return "border-lit-secondary dark:border-dark-secondary";
    case "paused":
      return "border-lit-secondary dark:border-dark-secondary";
    default:
      return "border-lit-secondary dark:border-dark-secondary";
  }
}

export default ProjectsPage;
