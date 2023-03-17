import { FiGithub, FiMail, FiTwitter, FiYoutube } from 'react-icons/fi';
import { Contact } from 'site/app/api/contacts/route';

const ContactIcons = (props: { contacts: Contact[] }) => {
    let icon = <></>;
    let iconSize = 22;
    let links = props.contacts.map((contact) => {
        switch (contact.name) {
            case 'github':
                icon = <FiGithub size={iconSize} />;
                break;
            case 'youtube':
                icon = <FiYoutube size={iconSize} />;
                break;
            case 'twitter':
                icon = <FiTwitter size={iconSize} />;
                break;
            case 'email':
                icon = <FiMail size={iconSize} />;
                break;
        }

        return (
            <div className="hover:scale-125">
                <a href={contact.link} key={contact.link}>
                    {icon}
                </a>
            </div>
        );
    });
    return <>{links}</>;
};

export default ContactIcons;
