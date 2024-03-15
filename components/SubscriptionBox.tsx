"use client";
import { Card } from "@/components/Card";
import { useState } from "react";

const SubscriptionBox = () => {
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
    <div className="flex flex-col gap-4 place-content-center items-center justify-center mx-4">
      <Card>
        {success === undefined ? (
          <form onSubmit={handleSubmit} className="listmonk-form">
            <div className="flex flex-row gap-2">
              <input
                className="p-3 rounded-lg bg-secondary dark:bg-dark-secondary accent-primary w-fit"
                type="email"
                name="email"
                required
                placeholder="E-mail"
              />
              <input
                className="bg-primary dark:bg-dark-primary p-3 rounded-lg hover:opacity-50 hover:cursor-pointer text-white"
                name="submit"
                type="submit"
                value="Subscribe"
              />
            </div>
          </form>
        ) : (
          <div className="w-full">Subscribed!</div>
        )}
      </Card>
    </div>
  );
};

export default SubscriptionBox;
