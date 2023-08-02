"use client";
import { Project } from "@prisma/client";
import Link from "next/link";
import { useState } from "react";

const ProjectsPage = ({ projects }: { projects: Project[] }) => {
  const [selectedStatuses, setSelectedStatuses] = useState(["planned", "complete", "ongoing", "paused", "archived"]);

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
        <CheckBox value="planned" />
        <CheckBox value="complete" />
        <CheckBox value="ongoing" />
        <CheckBox value="paused" />
        <CheckBox value="archived" />
      </div>

      <div className="grid grid-cols-3 grid-flow-row m-4 gap-4 p-4 my-10">{projectsGrid}</div>
    </div>
  );
};

function getBorderStyleForStatus(status: string) {
  switch (status) {
    case "ongoing":
      return "border-lit-accent dark:border-dark-accent";
    case "complete":
      return "border-lit-primary dark:border-dark-primary";
    case "planned":
      return "border-gray-300 dark:border-gray-900";
    case "archived":
      return "border-lit-secondary dark:border-dark-secondary";
    case "paused":
      return "border-lit-secondary dark:border-dark-secondary";
    default:
      return "border-lit-secondary dark:border-dark-secondary";
  }
}

export default ProjectsPage;
