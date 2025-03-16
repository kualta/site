import Link from "next/link";
import { BackButton, NotificationsButton, ThemeToggle } from "./MetaButton";

export const Header = () => {
  return (
    <>
      <div
        className={`z-[100] flex flex-row place-content-around sm:place-content-between place-items-center text-xl md:text-2xl
          tracking-wide max-w-full md:max-w-2xl w-full h-fit py-8 px-8`}
      >
        <div className="hidden sm:flex w-0 h-0 sm:w-8 sm:h-8">
          <BackButton />
        </div>
        <Link className="active:text-secondary-text" href="/projects">
          projects
          <br />
        </Link>
        <Link className="active:text-secondary-text" href="/posts">
          posts
          <br />
        </Link>
        <Link className="active:text-secondary-text" href="/contacts">
          contacts
          <br />
        </Link>
        <div className="hidden sm:flex w-0 h-0 sm:w-8 sm:h-8">
          <ThemeToggle />
        </div>
      </div>
    </>
  );
};
