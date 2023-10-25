import { ContactIcon } from "components/ContactIcons";
import { Contact } from "@prisma/client";
import { FadeIn } from "@/components/Transitions";
import { Card } from "@/components/Card";
import { fredoka } from "styles/fonts";
import { getAllContacts } from "prisma/dataFetch";

async function ContactsPage() {
  const contacts = await (await getAllContacts()).json();

  return (
    <FadeIn>
      <div className={"flex justify-center items-center flex-col gap-4 mt-16"}>
        {contacts.map((contact: Contact) => {
          const icon = ContactIcon(contact, 22);
          return (
            <Card key={contact.link + contact.description}>
              <a
                className={"flex gap-4 p-1 px-2 items-center w-60"}
                href={contact.link}
              >
                <span>{icon}</span>
                <div>
                  <p>{contact.label}</p>
                  <p className="overflow-x-visible w-fit text-xs text-secondary-text">
                    {contact.description}
                  </p>
                </div>
              </a>
            </Card>
          );
        })}
      </div>
    </FadeIn>
  );
}

export default ContactsPage;
