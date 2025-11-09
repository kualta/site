import { Project } from "@/types";
import ProjectsPage from "./ProjectsPage";
import { SubscriptionBox } from "@/components/SubscriptionBox";

export const metadata = {
  title: "projects",
  description: "kualta & kunet projects",
};

async function page() {
  const projects: Project[] = await (
    await fetch("https://kualta.dev/api/projects", { next: { revalidate: 1 } })
  ).json();

  return (
    <div className="max-w-2xl w-full place-items-center justify-center mb-10">
      <ProjectsPage projects={projects} />
      <SubscriptionBox />
    </div>
  );
}

export default page;
