import { Project } from "@prisma/client";
import ProjectsPage from "./ProjectsPage";
import Polyhedron from "@/components/Polyhedron";

async function page() {
  const projects: Project[] = await (await fetch("https://kualta.dev/api/projects", { cache: "no-store" })).json();

  return (
    <div>
      <div className="mx-auto max-w-2xl">
        <ProjectsPage projects={projects} />
      </div>
    </div>
  );
}

export default page;
