import { Contact } from "@prisma/client";
import { FiAtSign, FiGithub, FiGlobe, FiMail, FiYoutube } from "react-icons/fi";
import { RiBlueskyLine, RiTwitterXLine } from "react-icons/ri";

export const ContactIcon = (contact: Contact, size?: number) => {
  let icon = <></>;
  switch (contact.platform) {
    case "website":
      icon = <FiGlobe size={size} />;
      break;
    case "github":
      icon = <FiGithub size={size} />;
      break;
    case "youtube":
      icon = <FiYoutube size={size} />;
      break;
    case "twitter":
      icon = <RiTwitterXLine size={size} />;
      break;
    case "bsky":
      icon = <RiBlueskyLine size={(size ?? 22) + 4} />;
      break;
    case "ping":
      icon = <FiAtSign size={(size ?? 22) + 1} />;
      break;
    case "email":
      icon = <FiMail size={size} />;
      break;
  }
  return icon;
};

function ContactIcons(props: { contacts: Contact[]; size?: number }) {
  const size = props.size ? props.size : 18;

  const links = props.contacts.map((contact) => {
    const icon = ContactIcon(contact, size);
    return (
      <div key={contact.link} className="hover:scale-125">
        <a
          href={contact.link}
          key={contact.link}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={contact.platform}
        >
          {icon}
        </a>
      </div>
    );
  });
  return <>{links}</>;
}

export default ContactIcons;
