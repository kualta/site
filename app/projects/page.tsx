import { Project } from "@prisma/client";
import ProjectsPage from "./ProjectsPage";

async function page() {
  const projects: Project[] = await (
    await fetch("https://kualta.dev/api/projects", { next: { revalidate: 1 } })
  ).json();

  return (
    <div className="max-w-2xl min-w-fit w-full">
      <ProjectsPage projects={projects} />
    </div>
  );
}

export default page;
