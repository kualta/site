import { Contact } from "@prisma/client";
import {
  FiAtSign,
  FiGithub,
  FiGlobe,
  FiMail,
  FiTwitter,
  FiYoutube,
} from "react-icons/fi";

import { RiTwitterXLine } from "react-icons/ri";

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
    case "ping":
      icon = <FiAtSign size={size} />;
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
        <a href={contact.link} key={contact.link}>
          {icon}
        </a>
      </div>
    );
  });
  return <>{links}</>;
}

export default ContactIcons;
