import { Contact } from "@/types";
import { FiAtSign, FiGithub, FiGlobe, FiMail, FiYoutube } from "react-icons/fi";
import { RiTwitterXLine } from "react-icons/ri";
import { FarcasterIcon } from "./Icons";

export const ContactIcon = (contact: Contact, size?: number) => {
  let icon = <></>;
  switch (contact.platform) {
    case "website":
      icon = <FiGlobe size={size ?? 22} />;
      break;
    case "github":
      icon = <FiGithub size={size ?? 22} />;
      break;
    case "youtube":
      icon = <FiYoutube size={size ?? 22} />;
      break;
    case "twitter":
      icon = <RiTwitterXLine size={size ?? 22} />;
      break;
    case "farcaster":
      icon = <FarcasterIcon size={size ?? 20} />;
      break;
    case "ping":
      icon = <FiAtSign size={(size ?? 22) + 1} />;
      break;
    case "email":
      icon = <FiMail size={size ?? 22} />;
      break;
  }
  return icon;
};

function ContactIcons(props: { contacts: Contact[]; size?: number }) {
  const size = props.size ? props.size : 18;

  const links = props.contacts.map((contact) => {
    const icon = ContactIcon(contact, size);
    return (
      <div key={contact.link} className="hover:scale-125 transition-all duration-100">
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
