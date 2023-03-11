import { Contact } from '../site/app/api/contacts/route';
import { roboto_mono } from './fonts';

const Contacts = (props: { contacts: Contact[] }) => {
    return (
        <div className="flex flex-col space-y-4 py-8">
            <h2 className={`${roboto_mono.className} font-semibold text-xl`}>
                Contacts
            </h2>
            {props.contacts.map((project) => (
                <a href={project.link} key={project.link} className="">
                    <b className={roboto_mono.className}>{project.name}</b>
                    {` - `}
                    <span className={roboto_mono.className}>
                        {project.description}
                    </span>
                </a>
            ))}
        </div>
    );
};

export default Contacts;
