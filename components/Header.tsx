import Link from "next/link";
import { BackButton, MetaButton, NotificationsButton, ThemeToggle } from "./MetaButton";

export const Header = () => {
  return (
    <>
      <div
        className={`z-[100] flex flex-row place-content-between place-items-center text-xl md:text-2xl
          tracking-wide max-w-full md:max-w-2xl w-full h-fit p-4 sm:p-8 sm:px-4`}
      >
        <BackButton />
        <Link className="active:text-secondary-text" href="/projects">
          projects
        </Link>
        <Link className="active:text-secondary-text" href="/posts">
          posts
        </Link>
        <Link className="active:text-secondary-text" href="/contacts">
          contacts
        </Link>
        <ThemeToggle />
      </div>

      <NotificationsButton />
    </>
  );
};
