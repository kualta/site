import { Contact, Project } from "@prisma/client";
import { DataList, LinkHeader } from "components/DataList";
import { getAllPosts } from "../prisma/dataFetch";
import { getAllContacts } from "../prisma/dataFetch";
import { getAllProjects } from "../prisma/dataFetch";
import Polyhedron from "@/components/Polyhedron";
import Link from "next/link";
import { Transition } from "@headlessui/react";
import { fredoka } from "styles/fonts";
import ContactIcons from "@/components/ContactIcons";

async function HomePage() {
  const projects = await (
    await getAllProjects()
  )
    .json()
    .then((projects: Project[]) =>
      projects.filter((project: Project) => project.status !== "planned")
    )
    .then((projects: Project[]) =>
      projects.filter(
        (project: Project) => project.relevance && project.relevance > 25
      )
    );

  const contacts = await (await getAllContacts())
    .json()
    .then((contacts: any) =>
      contacts.filter((contact: Contact) => contact.is_main)
    );

  const articles = await (await getAllPosts()).json();

  return (
    <div
      className={`flex flex-col w-full grow justify-center place-content-center font-bold ${fredoka.className}`}
    >
      <div className="flex flex-col gap-2 w-min mx-auto">
        <h1 className="text-8xl text-left">kualta</h1>
        <div className="flex flex-row gap-2">
          <ContactIcons contacts={contacts} />
        </div>
      </div>
    </div>
  );
}

export default HomePage;
