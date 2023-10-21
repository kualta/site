import { ContactIcon } from "components/ContactIcons";
import { Contact } from "@prisma/client";
import { FadeIn } from "@/components/FadeIn";

async function ContactsPage() {
  const contacts: Contact[] = await (
    await fetch("https://kualta.dev/api/contacts", { cache: "no-store" })
  ).json();

  return (
    <FadeIn>
      <div
        className={
          "flex justify-center items-center flex-col gap-4 m-auto max-w-fit h-full"
        }
      >
        {contacts.map((contact: Contact) => {
          const icon = ContactIcon(contact, 22);
          return (
            <a
              className={
                "flex gap-4 hover:underline p-4 px-8 bg-secondary dark:bg-dark-secondary w-full items-center drop-shadow-md rounded-lg active-bg"
              }
              href={contact.link}
              key={contact.link + contact.description}
            >
              <span>{icon}</span>
              <div>
                <p>{contact.label}</p>
                <p className="overflow-x-visible w-fit text-xs text-secondary-text">
                  {contact.description}
                </p>
              </div>
            </a>
          );
        })}
      </div>
    </FadeIn>
  );
}

export default ContactsPage;
