"use client";
import { env } from "process";
import { useState } from "react";

const SubscriptionPage = () => {
  const [email, setEmail] = useState("");

  const handleSubmit = async (event: any) => {
    event.preventDefault();

    const formData = {
      email: email,
      name: "The Subscriber",
      status: "enabled",
      lists: [1],
      attribs: {
        city: "Bengaluru",
        projects: 3,
        stack: { languages: ["go", "python"] },
      },
    };

    const login = env.MAIL_USERNAME;
    const password = env.MAIL_PASSWORD;

    const response = await fetch("https://mail.kualta.dev/api/subscribers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${btoa(`${login}:${password}`)}`,
      },
      body: JSON.stringify(formData),
    });

    if (response.ok) {
      // Handle successful subscription
      console.log("Subscription successful!");
    } else {
      // Handle subscription failure
      console.error("Subscription failed");
    }
  };
  return (
    <form onSubmit={handleSubmit} className="listmonk-form">
      <div>
        <h3>Subscribe</h3>
        <input type="hidden" name="nonce" />
        <p>
          <input
            type="email"
            name="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="E-mail"
          />
        </p>

        <p>
          <input type="submit" value="Subscribe" />
        </p>
      </div>
    </form>
  );
};

export default SubscriptionPage;
