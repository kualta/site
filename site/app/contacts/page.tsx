import { ContactIcon } from "@/components/ContactIcons";
import { roboto_mono } from "@/components/Fonts";
import { Contact } from "@prisma/client";

async function ContactsPage() {
	const contacts: Contact[] = await (
		await fetch("https://kualta.dev/api/contacts", { cache: "no-store" })
	).json();

	return (
		<div
			className={`${roboto_mono.className} flex justify-center items-center flex-col gap-4 py-4 m-auto`}
		>
			{contacts.map((contact: Contact) => {
				const icon = ContactIcon(contact, 22);
				return (
					<a
						className="flex gap-4 group border-b p-4 border-stone-800 w-full items-center"
						href={contact.link}
						key={contact.link+contact.description}
					>
						<div className="text-right w-16">
							<b className="text-right">{contact.platform}</b>
						</div>
						{icon}
						<div className="group-hover:underline">
							<p className="">{contact.label}</p>
							<p className="overflow-x-visible w-fit text-xs text-stone-400">
								{contact.description}
							</p>
						</div>
					</a>
				);
			})}

			{/* <div className="flex justify-center items-center mr-16">
                <Link href={'/'}>{`< back`}</Link>
            </div> */}
		</div>
	);
}

export default ContactsPage;
