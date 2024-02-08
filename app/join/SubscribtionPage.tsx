"use client";
import { Card } from "@/components/Card";
import { useState } from "react";
import { FiAtSign } from "react-icons/fi";
import { RiDiscordFill } from "react-icons/ri";
import { TbBox } from "react-icons/tb";
import { SiMatrix } from "react-icons/si";

const SubscriptionPage = () => {
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
    <div className="flex flex-col gap-8">
      <h1 className="text-3xl font-bold text-center mt-8">Subscribe</h1>
      <div className="flex flex-col gap-4 place-content-center items-center justify-center">
        <Card>
          {success === undefined ? (
            <form onSubmit={handleSubmit} className="listmonk-form">
              <div className="flex flex-row gap-2">
                <input
                  className="p-3 rounded-lg bg-secondary dark:bg-dark-secondary accent-primary"
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
            <div className="w-98">Subscribed!</div>
          )}
        </Card>
        <p className="text-2xl">
          <b className="drop-shadow-glow">Kurier</b> will deliver latest news and events right into your mailbox.
        </p>
      </div>

      <h1 className="text-3xl font-bold text-center mt-16">Join Kunet</h1>
      <Card>
        <div className="flex flex-row gap-4 place-content-around items-center ">
          <a
            href="https://discord.gg/DhMeQAXW4F"
            className="flex flex-col justify-center items-center hover:drop-shadow-glow hover:transition-all hover:duration-300 hover:cursor-pointer"
            target="_blank"
            rel="noreferrer"
          >
            Discord
            <RiDiscordFill size={32} />
          </a>
          <div className="opacity-50 flex flex-col justify-center items-center gap-2">
            Matrix
            <SiMatrix size={30} />
            Soon
          </div>
          <div className="opacity-50 flex flex-col justify-center items-center gap-2">
            Ping
            <FiAtSign size={30} />
            Soon
          </div>
          <div className="opacity-50 flex flex-col justify-center items-center gap-2">
            Black Box
            <TbBox size={32} />
            Soon
          </div>
        </div>
      </Card>
      <div className="text-2xl place-items-center justify-center flex flex-row gap-2">
        An open community. <b className="drop-shadow-glow">You're invited.</b>
      </div>
      {/* <p className="text-2xl text-center">
        Every entry point is <b>valid</b>. Use what you're <b>most comfortable</b> with, miss out on <b>nothing</b>.
      </p> */}
    </div>
  );
};

export default SubscriptionPage;
