import { Contact } from "@/types";
import { getAllContacts } from "@/lib/dataFetch";

const ethereum = {
  platform: "ethereum",
  label: "kualta.eth",
  link: "https://etherscan.io/address/0xDeAd010d1c8f9B463F5dE853902761Cdbac53fb7",
};

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
      <a
        href={ethereum.link}
        target="_blank"
        rel="noopener noreferrer"
        className="w-full flex flex-row items-baseline gap-2 hover:opacity-70 text-lg"
      >
        <span className="font-medium whitespace-nowrap">{ethereum.platform}</span>
        <span className="flex-grow border-b border-dotted border-secondary-text opacity-50" />
        <span className="text-sm text-secondary-text whitespace-nowrap font-mono">{ethereum.label}</span>
      </a>
    </div>
  );
}

export default ContactsPage;
