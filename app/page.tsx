import { LinkTitle } from "components/LIstTitle";
import { Contact, Project } from "@prisma/client";
import { ArticleList, ContactList, ProjectList } from "components/DataList";
import { getAllPosts } from "../prisma/dataFetch";
import { getAllContacts } from "../prisma/dataFetch";
import { getAllProjects } from "../prisma/dataFetch";

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
      <LinkTitle href={"/projects"} text={"projects"} />
      <ProjectList projects={projects} />
      <LinkTitle href={"/blog"} text={"articles"} />
      <ArticleList articles={articles} />
      <LinkTitle href={"/contacts"} text={"contacts"} />
      <ContactList contacts={contacts} />
      <LinkTitle href={"/explore"} text={"explore >"} />
    </div>
  );
}

export default HomePage;
