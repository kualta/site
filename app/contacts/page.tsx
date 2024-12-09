import { Card } from "@/components/Card";
import { EtheriumButton, PGPButton } from "@/components/ContactButtons";
import { Contact } from "@prisma/client";
import { ContactIcon } from "components/ContactIcons";
import { getAllContacts } from "prisma/dataFetch";

export const metadata = {
  title: "contacts",
  description: "contact kualta",
};

async function ContactsPage() {
  const contacts = await (await getAllContacts()).json();

  return (
    <div className={"flex justify-center flex-col gap-4 w-72 ml-auto mr-auto -mt-16"}>
      {contacts.map((contact: Contact) => {
        const icon = ContactIcon(contact, 22);
        return (
          <a key={contact.link + contact.description} href={contact.link} target="_blank" rel="noopener noreferrer">
            <Card>
              <div className="w-60 flex gap-4 items-center">
                <span>{icon}</span>
                <div>
                  <p>{contact.label}</p>
                  <p className="overflow-x-visible w-fit text-xs text-secondary-text">{contact.description}</p>
                </div>
              </div>
            </Card>
          </a>
        );
      })}

      <EtheriumButton />
      <PGPButton />
    </div>
  );
}

export default ContactsPage;
