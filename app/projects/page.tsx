import { Project } from "@prisma/client";
import ProjectsPage from "./ProjectsPage";

async function page() {
  const projects: Project[] = await (await fetch("https://kualta.dev/api/projects", { cache: "no-store" })).json();
  return <ProjectsPage projects={projects} />;
}

export default page;
