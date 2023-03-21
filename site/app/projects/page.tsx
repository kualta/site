import { ProjectGrid } from "@/components/DataList";

async function ProjectsPage() {
    let projects = await (await fetch('https://kualta.dev/api/projects', { cache: 'no-store' })).json();

    return (
        <>
            <ProjectGrid projects={projects} />
        </>
    );
}
 
export default ProjectsPage;