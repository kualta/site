import { ListTitle } from "extra/LIstTitle";
import { Contact, Project } from "@prisma/client";
import { ArticleList, ContactList, ProjectList } from "extra/DataList";
import { getAllPosts } from "../extra/dataFetch";
import { getAllContacts } from "../extra/dataFetch";
import { getAllProjects } from "../extra/dataFetch";

async function HomePage() {
  const projects = await (
    await getAllProjects()
  )
    .json()
    .then((projects) => projects.filter((project: Project) => project.status !== "planned"));
  const contacts = await (
    await getAllContacts()
  )
    .json()
    .then((contacts) => contacts.filter((contact: Contact) => contact.is_main));

  const articles = await (await getAllPosts()).json();

  return (
    <div className="font-mono">
      <ListTitle href={"/projects"} text={"projects"} />
      <ProjectList projects={projects} />
      <ListTitle href={"/blog"} text={"articles"} />
      <ArticleList articles={articles} />
      <ListTitle href={"/contacts"} text={"contacts"} />
      <ContactList contacts={contacts} />
    </div>
  );
}

export default HomePage;
