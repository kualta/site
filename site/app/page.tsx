import { ListTitle } from "@/components/LIstTitle";
import { Contact, Project } from "@prisma/client";
import ContactIcons from "components/ContactIcons";
import { ArticleList, ContactList, ProjectList } from "components/DataList";
import { roboto_mono } from "components/Fonts";
import Link from "next/link";

async function HomePage() {
	const projects = await (
		await fetch("https://kualta.dev/api/projects", { cache: "no-store" })
	)
		.json()
		.then((projects) =>
			projects.filter((project: Project) => project.status !== "planned"),
		);
	const contacts = await (
		await fetch("https://kualta.dev/api/contacts", { cache: "no-store" })
	)
		.json()
		.then((contacts) => contacts.filter((contact: Contact) => contact.is_main));
	const articles = await (
		await fetch("https://blog.kualta.dev/api/posts", { cache: "no-store" })
	).json();

	return (
		<>
			<div className={"font-mono"}>
				<ListTitle href={"/projects"} text={"projects"} />
				<ProjectList projects={projects} />
				<ListTitle href={"/blog"} text={"articles"} />
				<ArticleList articles={articles} />
				<ListTitle href={"/contacts"} text={"contacts"} />
				<ContactList contacts={contacts} />
			</div>
		</>
	);
}

export default HomePage;
