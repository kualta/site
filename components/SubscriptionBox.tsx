"use client";
import { Card } from "@/components/Card";
import { useState } from "react";
import { MetaButton } from "./MetaButton";
import Link from "next/link";
import { FiBell, FiMail } from "react-icons/fi";
import { LuMail, LuMailCheck } from "react-icons/lu";

export const SubscriptionBox = () => {
  return (
    <div className="flex gap-4 flex-row place-content-center items-center justify-center w-full p-2 pl-4">
      <MetaButton>
        <Link className="active:text-secondary-text" href="/join">
          <Card>
            <FiBell size={22} strokeWidth="2" />
          </Card>
        </Link>
      </MetaButton>

      <EmailSubscription />
    </div>
  );
};

export const EmailSubscription = () => {
  const [success, setSuccess] = useState<boolean | undefined>(undefined);

  const handleSubmit = (event: any) => {
    event.preventDefault();

    fetch(`/api/subscribe?email=${event.target.email.value}`, {
      method: "POST",
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.status === 200) {
          setSuccess(true);
        } else {
          setSuccess(false);
        }
      });

    event.target.email.value = "";
  };

  return (
    <div className="flex flex-col gap-4 place-content-center items-center justify-center w-fit">
      {success === undefined ? (
        <form onSubmit={handleSubmit} >
          <div className="flex flex-row gap-2">
            <input
              className="p-3 rounded-lg min-w-0 w-full bg-secondary dark:bg-dark-secondary accent-primary w-fit"
              type="email"
              name="email"
              required
              placeholder="E-mail"
            />
            <button
              className="hidden sm:flex bg-primary dark:bg-dark-primary p-3 rounded-lg hover:opacity-50 hover:cursor-pointer text-white"
              name="submit"
              type="submit"
            >
              Subscribe
            </button>
            <button
              className="flex sm:hidden bg-primary dark:bg-dark-primary p-3 rounded-lg hover:opacity-50 hover:cursor-pointer text-white"
              name="submit"
              type="submit"
            >
              <LuMail size={24} />
            </button>
          </div>
        </form>
      ) : (
        <Card>
          <div className="w-full flex flex-row gap-4">
            Subscribed!
            <LuMailCheck size={24} />
          </div>
        </Card>
      )}
    </div>
  );
};
