import { Contact } from "@prisma/client";

export const DataEntry = ({ data }: { data: any }) => {
  const link = data.link ? data.link : data.git_link;
  return (
    <a
      className="w-fit items-center hover:text-lit-accent hover:dark:text-dark-accent"
      href={link}
      key={data.link + data.name + data.date}
    >
      <b className={" font-mono"}>{data.name}</b>
      {" - "}
      <span>{data.description}</span>
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
          className="hover:text-lit-accent hover:dark:text-dark-accent w-fit"
          href={contact.link}
          key={contact.link + contact.id + contact.platform}
        >
          <b>{contact.platform}</b>
          {" - "}
          <span className={"truncate"}>{contact.label}</span>
        </a>
      ))}
    </div>
  );
}
