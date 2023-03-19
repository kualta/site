import { FiGithub, FiGlobe, FiMail, FiTwitter, FiYoutube } from 'react-icons/fi';

const ContactIcons = (props: { contacts: any[] }) => {
    let icon = <></>;
    let iconSize = 22;
    let links = props.contacts.map((contact) => {
        switch (contact.name) {
            case 'website':
                icon = <FiGlobe size={iconSize} />;
                break;
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
            <div key={contact.link} className="hover:scale-125">
                <a href={contact.link} key={contact.link}>
                    {icon}
                </a>
            </div>
        );
    });
    return <>{links}</>;
};

export default ContactIcons;
