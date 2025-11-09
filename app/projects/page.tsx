import { Project } from "@/types";
import ProjectsPage from "./ProjectsPage";
import { SubscriptionBox } from "@/components/SubscriptionBox";
import projectsData from "@/data/projects.json";

export const metadata = {
  title: "projects",
  description: "kualta & kunet projects",
};

async function page() {
  const projects = projectsData as Project[];
  const sortedProjects = [...projects].sort((a, b) => (b.relevance || 0) - (a.relevance || 0)).sort((a, b) => (a.status === "complete" ? -1 : 1)).sort((a, b) => (a.status === "ongoing" ? -1 : 1));

  return (
    <div className="max-w-2xl w-full place-items-center justify-center mb-10">
      <ProjectsPage projects={sortedProjects} />
      <SubscriptionBox />
    </div>
  );
}

export default page;
