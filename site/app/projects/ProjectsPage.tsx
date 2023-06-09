"use client";
import { roboto_mono } from "@/components/Fonts";
import { Project } from "@prisma/client";
import Link from "next/link";
import { useState } from "react";

const ProjectsPage = ({ projects }: { projects: Project[] }) => {
  const [selectedStatuses, setSelectedStatuses] = useState(["planned", "complete", "ongoing", "paused", "archived"]);

  function handleStatusChange(e: any) {
    const value = e.target.value;
    setSelectedStatuses((prevSelectedStatuses) => {
      console.log("value=" + value);
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
    let link = project.link ? project.link : project.git_link;
    let border_color = getBorderStyleForStatus(project.status);

    return (
      <div key={project.id}>
        <a
          key={project.id}
          className={"flex group border border-yell aspect-video items-center justify-center " + border_color}
          href={link}
        >
          <b className={`${roboto_mono.className} group-hover:underline`}>{project.name}</b>
        </a>
      </div>
    );
  });
  return (
    <div>
      <div className={`flex flex-row gap-4 p-4 justify-center items-center ${roboto_mono.className}`}>
        <label>
          <input
            type="checkbox"
            value="planned"
            checked={selectedStatuses.includes("planned")}
            onChange={handleStatusChange}
            className="mr-2 accent-gray-900"
          />
          Planned
        </label>
        <label>
          <input
            type="checkbox"
            value="ongoing"
            checked={selectedStatuses.includes("ongoing")}
            onChange={handleStatusChange}
            className="mr-2 accent-stone-800"
          />
          Ongoing
        </label>
        <label>
          <input
            type="checkbox"
            value="complete"
            checked={selectedStatuses.includes("complete")}
            onChange={handleStatusChange}
            className="mr-2 accent-stone-800"
          />
          Completed
        </label>
        <label>
          <input
            type="checkbox"
            value="paused"
            checked={selectedStatuses.includes("paused")}
            onChange={handleStatusChange}
            className="mr-2 accent-stone-800"
          />
          Paused
        </label>
        <label>
          <input
            type="checkbox"
            value="archived"
            checked={selectedStatuses.includes("archived")}
            onChange={handleStatusChange}
            className="mr-2 accent-yellow-900"
          />
          Archived
        </label>
      </div>
      <div className="grid grid-cols-3 grid-flow-row m-4 gap-4 p-4 my-10">
        {projectsGrid}
        <div className="flex justify-center items-center">
          <Link href={"/"}>{`< back`}</Link>
        </div>
      </div>
    </div>
  );
};

function getBorderStyleForStatus(status: string) {
  switch (status) {
    case "ongoing":
      return "border-stone-800";
    case "complete":
      return "border-stone-800";
    case "planned":
      return "border-gray-900";
    case "archived":
      return "border-yellow-900";
    case "paused":
      return "border-stone-800";
    default:
      return "border-stone-800";
  }
}

export default ProjectsPage;
