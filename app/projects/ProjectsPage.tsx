"use client";
import { FadeIn } from "@/components/Transitions";
import { ProjectCard } from "@/components/ProjectCard";
import { Project } from "@prisma/client";
import { useState } from "react";
import { MdExpandCircleDown, MdExpandLess, MdExpandMore, MdOutlineExpand } from "react-icons/md";
import { RiExpandRightFill, RiExpandUpDownLine } from "react-icons/ri";

const ProjectsPage = ({ projects }: { projects: Project[] }) => {
  const [selectedStatuses, setSelectedStatuses] = useState(["complete", "ongoing", "paused", "archived"]);
  const [expandAll, setExpandAll] = useState(false);

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
    return <ProjectCard key={project.id} project={project} expandAll={expandAll} />;
  });

  // TODO: add sorting options
  return (
    <>
      <div className={"flex flex-wrap gap-4 p-4 justify-between items-center text-xs sm:text-base"}>
        <div className="flex gap-4">
          <CheckBox value="complete" />
          <CheckBox value="ongoing" />
          <CheckBox value="paused" />
          <CheckBox value="archived" />
        </div>
        <button className="flex gap-2 items-center px-3.5" type="button" onClick={() => setExpandAll(!expandAll)}>
          {expandAll ? "collapse all" : "expand all"}
          {expandAll ? <MdExpandLess /> : <MdExpandMore />}
        </button>
      </div>

      <FadeIn>
        <div className="flex flex-col w-full gap-4 p-4">{projectsList}</div>
      </FadeIn>
    </>
  );
};

export default ProjectsPage;
