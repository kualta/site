import { ContactIcon } from "components/ContactIcons";
import { Contact } from "@prisma/client";
import Link from "next/link";

async function ContactsPage() {
  const contacts: Contact[] = await (await fetch("https://kualta.dev/api/contacts", { cache: "no-store" })).json();

  return (
    <div className={"flex justify-center items-center flex-col gap-4 m-auto max-w-fit h-full"}>
      {contacts.map((contact: Contact) => {
        const icon = ContactIcon(contact, 22);
        return (
          <a
            className="flex gap-4 hover:text-lit-accent hover:dark:text-dark-accent border-b p-4 border-stone-800 w-full items-center"
            href={contact.link}
            key={contact.link + contact.description}
          >
            <div className="text-right w-16">
              <b className="text-right">{contact.platform}</b>
            </div>
            {icon}
            <div>
              <p className="">{contact.label}</p>
              <p className="overflow-x-visible w-fit text-xs text-stone-400">{contact.description}</p>
            </div>
          </a>
        );
      })}
    </div>
  );
}

export default ContactsPage;
