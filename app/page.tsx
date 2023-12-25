import { Contact, Project } from "@prisma/client";
import { getAllPosts } from "../prisma/dataFetch";
import { getAllContacts } from "../prisma/dataFetch";
import { getAllProjects } from "../prisma/dataFetch";
import ContactIcons from "@/components/ContactIcons";
import { IsChristmas, Snow } from "@/components/Effects";

async function HomePage() {
  const projects = await (await getAllProjects())
    .json()
    .then((projects: Project[]) => projects.filter((project: Project) => project.status !== "planned"))
    .then((projects: Project[]) => projects.filter((project: Project) => project.relevance && project.relevance > 25));

  const contacts = await (await getAllContacts())
    .json()
    .then((contacts: any) => contacts.filter((contact: Contact) => contact.is_main));

  const articles = await (await getAllPosts()).json();

  return (
    <div className={"flex flex-col w-full grow justify-center place-content-center snowflake font-bold"}>
      <div className="flex flex-col gap-2 w-min mx-auto">
        <h1 className="text-8xl text-left relative">
          kualta
          <IsChristmas>
            <img src="/santa_hat.svg" className="absolute top-1 -left-1 w-6 h-6 " alt="santa hat" />
          </IsChristmas>
        </h1>
        <div className="flex flex-row gap-2">
          <ContactIcons contacts={contacts} />
        </div>
      </div>
    </div>
  );
}

export default HomePage;
