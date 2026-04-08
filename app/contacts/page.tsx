import { Contact } from "@/types";
import { getAllContacts } from "@/lib/dataFetch";

export const metadata = {
  title: "contacts",
  description: "contact kualta",
};

async function ContactsPage() {
  const contacts = await (await getAllContacts()).json();

  return (
    <div className="max-w-xl w-full grow flex flex-col gap-4 p-4">
      {contacts.map((contact: Contact) => (
        <a
          key={contact.link + contact.description}
          href={contact.link}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full flex flex-row items-baseline gap-2 hover:opacity-70 text-lg"
        >
          <span className="font-medium whitespace-nowrap">{contact.platform}</span>
          <span className="flex-grow border-b border-dotted border-secondary-text opacity-50" />
          <span className="text-sm text-secondary-text whitespace-nowrap font-mono">{contact.label}</span>
        </a>
      ))}
    </div>
  );
}

export default ContactsPage;
