import { useState } from "react";
import { LuMail, LuMailCheck } from "react-icons/lu";

export function EmailSubscription() {
  const [success, setSuccess] = useState<boolean | undefined>(undefined);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const email = (form.elements.namedItem("email") as HTMLInputElement)?.value;
    if (!email) return;

    try {
      const res = await fetch(`/api/subscribe?email=${encodeURIComponent(email)}`, {
        method: "POST",
      });
      const data = await res.json();
      setSuccess(data.status === 200);
    } catch {
      setSuccess(false);
    }
    form.reset();
  };

  return (
    <div className="flex flex-col gap-4 place-content-center items-center justify-center w-full">
      {success === undefined ? (
        <form onSubmit={handleSubmit} className="w-full">
          <div className="flex flex-row gap-2">
            <input
              className="p-3 rounded-xl min-w-0 flex-grow bg-secondary dark:bg-dark-secondary accent-primary"
              type="email"
              name="email"
              required
              placeholder="E-mail"
            />
            <button
              className="hidden sm:flex bg-primary dark:bg-dark-primary p-3 rounded-xl hover:opacity-50 hover:cursor-pointer text-white"
              name="submit"
              type="submit"
            >
              Subscribe
            </button>
            <button
              className="flex sm:hidden bg-primary dark:bg-dark-primary p-3 rounded-xl hover:opacity-50 hover:cursor-pointer text-white"
              name="submit"
              type="submit"
              aria-label="Subscribe"
            >
              <LuMail size={24} />
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-row gap-2 items-center justify-center w-full p-3">
          Subscribed!
          <LuMailCheck size={24} />
        </div>
      )}
    </div>
  );
}
