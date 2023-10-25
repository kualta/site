"use client";
import { Card } from "@/components/Card";
import { FadeIn } from "@/components/Transitions";
import { ProjectCard } from "@/components/ProjectCard";
import { Project } from "@prisma/client";
import { useState } from "react";
import { fredoka } from "styles/fonts";

const ProjectsPage = ({ projects }: { projects: Project[] }) => {
  const [selectedStatuses, setSelectedStatuses] = useState([
    "complete",
    "ongoing",
    "paused",
    "archived",
  ]);

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

  const projectsList = filteredProjects.map((project) => {
    return <ProjectCard key={project.id} project={project} />;
  });

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

  // TODO: add sorting options
  // TODO: add expand all button
  return (
    <>
      <div
        className={
          "flex flex-wrap gap-4 p-4 justify-center items-center  text-xs sm:text-base"
        }
      >
        <CheckBox value="complete" />
        <CheckBox value="ongoing" />
        <CheckBox value="paused" />
        <CheckBox value="archived" />
      </div>

      <FadeIn>
        <div className="flex flex-col w-full gap-4 p-4">{projectsList}</div>
      </FadeIn>
    </>
  );
};

export default ProjectsPage;
