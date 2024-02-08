import { Project } from "@prisma/client";
import ProjectsPage from "./ProjectsPage";
import SubscriptionBox from "@/components/SubscriptionBox";

async function page() {
  const projects: Project[] = await (
    await fetch("https://kualta.dev/api/projects", { next: { revalidate: 1 } })
  ).json();

  return (
    <div className="max-w-2xl w-full mb-10">
      <ProjectsPage projects={projects} />
      <SubscriptionBox />
    </div>
  );
}

export default page;
