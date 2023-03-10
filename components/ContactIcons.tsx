import { FiGithub, FiMail, FiTwitter, FiYoutube } from 'react-icons/all';
import { Contact } from 'site/app/api/contacts/route';

const ContactIcons = (props: { contacts: Contact[]}) => {
    let links = props.contacts.map((contact) => {
        let icon = <></>;
        let iconSize = 22;
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
            <a href={contact.link} key={contact.link}>
                {icon}
            </a>
        );
    });
    return <>{links}</>;
};

export default ContactIcons;
