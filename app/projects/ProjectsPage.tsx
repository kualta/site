"use client";
import { ProjectCard } from "@/components/ProjectCard";
import { Project } from "@/types";
import { useState } from "react";

const ProjectsPage = ({ projects }: { projects: Project[] }) => {
  const [selectedStatuses, setSelectedStatuses] = useState(["complete", "ongoing", "paused", "archived"]);

  const CheckBox = ({ value }: { value: string }) => {
    return (
      <label>
        <input
          type="checkbox"
          value={value}
          checked={selectedStatuses.includes(value)}
          onChange={handleStatusChange}
          className="mr-2 accent-secondary dark:accent-dark-text"
        />
        <span>{value}</span>
      </label>
    );
  };

  function handleStatusChange(e: { target: { value: any } }) {
    const value = e.target.value;
    setSelectedStatuses((prevSelectedStatuses) => {
      if (prevSelectedStatuses.includes(value)) {
        return prevSelectedStatuses.filter((status) => status !== value);
      }
      return [...prevSelectedStatuses, value];
    });
  }

  const filteredProjects = projects.filter((project) => {
    return selectedStatuses.includes(project.status);
  });

  const projectsList = filteredProjects.map((project) => {
    return <ProjectCard key={project.id} project={project} />;
  });

  // TODO: add sorting options
  return (
    <>
      <div
        className={
          "flex flex-row flex-wrap gap-4 p-4 items-center justify-center  text-xs sm:text-sm md:text-base truncate"
        }
      >
        <div className="flex flex-row sm:flex-row gap-4">
          <CheckBox value="complete" />
          <CheckBox value="ongoing" />
          <CheckBox value="archived" />
        </div>
      </div>

      <div className="flex flex-col w-full gap-4 p-4">{projectsList}</div>
    </>
  );
};

export default ProjectsPage;
