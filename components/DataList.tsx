import { Contact, Project } from "@prisma/client";

export const DataEntry = ({ data }: { data: any }) => {
  const link = data.link ? data.link : data.git_link;
  return (
    <a
      className="group decoration-1 underline-offset-4 w-fit items-center"
      href={link}
      key={data.link + data.name + data.date}
    >
      <b className={"group-hover:underline font-mono"}>{data.name}</b>
      <span>{" - "}</span>
      <span className={"group-hover:underline "}>{data.description}</span>
      {/* {project.status === "ongoing" && <span className="text-xs text-stone-500 px-2">current</span>} */}
    </a>
  );
};

export function DataList({ data }: { data: any[] }) {
  return (
    <span className="flex flex-col space-y-2 pl-4 pt-2">
      {data.map((data) => (
        <DataEntry data={data} />
      ))}
    </span>
  );
}

export function ContactList(props: { contacts: Contact[] }) {
  return (
    <div className="flex flex-col space-y-2 pl-4 pt-2">
      {props.contacts.map((contact) => (
        <a
          className="group decoration-1 underline-offset-4 w-fit"
          href={contact.link}
          key={contact.link + contact.id + contact.platform}
        >
          <b className={"group-hover:underline font-mono"}>{contact.platform}</b>
          <span className="px-1 ">{" - "}</span>
          <span className={"group-hover:underline truncate"}>{contact.label}</span>
        </a>
      ))}
    </div>
  );
}
