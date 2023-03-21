import { FiGithub, FiGlobe, FiMail, FiTwitter, FiYoutube } from 'react-icons/fi';

function ContactIcons(props: { contacts: any[]; size?: number }) {
    let icon = <></>;
    let size = props.size ? props.size : 22;

    let links = props.contacts.map((contact) => {
        switch (contact.name) {
            case 'website':
                icon = <FiGlobe size={size} />;
                break;
            case 'github':
                icon = <FiGithub size={size} />;
                break;
            case 'youtube':
                icon = <FiYoutube size={size} />;
                break;
            case 'twitter':
                icon = <FiTwitter size={size} />;
                break;
            case 'email':
                icon = <FiMail size={size} />;
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
}

export default ContactIcons;
