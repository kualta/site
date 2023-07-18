import { Contact, Project } from "@prisma/client";

export function ProjectList(props: { projects: Project[] }) {
  return (
    <div className="flex flex-col space-y-2 p-4">
      {props.projects.map((project) => {
        const link = project.link ? project.link : project.git_link;
        return (
          <a
            className="flex group decoration-1 underline-offset-4 w-fit items-center"
            href={link}
            key={project.link + project.name + project.date}
          >
            <b className={"group-hover:underline"}>{project.name}</b>
            <span className="px-1 font-light">{" - "}</span>
            <span className={" group-hover:underline font-light truncate"}>{project.description}</span>
            {project.status === "ongoing" && <span className="text-xs text-stone-500 px-2">current</span>}
          </a>
        );
      })}
    </div>
  );
}

export interface Article {
  name: string;
  link: string;
  description: string;
}

export function ArticleList(props: { articles: Article[] }) {
  return (
    <div className="flex flex-col space-y-2 p-4">
      {props.articles.map((article, i) => {
        const title = article.name.toLocaleLowerCase();
        return (
          <a
            className="flex group decoration-1 underline-offset-4 w-fit items-center"
            href={article.link}
            key={article.link + article.name + article.description}
          >
            <b className={"group-hover:underline w-fit"}>{title}</b>
            <span className="px-1 font-light">{" - "}</span>
            <span className={"group-hover:underline font-light truncate"}>{article.description}</span>
            {i === 0 && <span className="text-xs text-stone-500 px-2">latest</span>}
          </a>
        );
      })}
    </div>
  );
}

export function ContactList(props: { contacts: Contact[] }) {
  return (
    <div className="flex flex-col space-y-2 p-4">
      {props.contacts.map((contact) => (
        <a
          className="group decoration-1 underline-offset-4 w-fit"
          href={contact.link}
          key={contact.link + contact.id + contact.platform}
        >
          <b className={"group-hover:underline"}>{contact.platform}</b>
          <span className="px-1 font-light">{" - "}</span>
          <span className={"font-ultralight group-hover:underline truncate"}>{contact.label}</span>
        </a>
      ))}
    </div>
  );
}
